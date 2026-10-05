# Deploy de Fase 3 — backend aplicado y verificado

## Estado remoto actual

Actualizado el 5 de octubre de 2026. Proyecto `swlpspgmkwzlrowllvvj`, región us-east-2, PostgreSQL 17.6. El propietario autorizó continuar los siguientes pasos, excluyendo cinco licencias antiguas de prueba. No hay staging accesible; se utilizó un ensayo local aislado sobre el backup restaurado antes de aplicar cada etapa remota.

El remoto contiene ahora 60 tablas/vistas públicas y catorce versiones registradas: cuatro baseline, Fase 1, Fase 2 y ocho Fase 3. Cada etapa nueva se aplicó en transacción y pasó smoke de contratos, hashes normalizados, grants, RLS, políticas y triggers antes de registrar su historial.

Los contratos requeridos están instalados; las once funciones del delta están ACTIVE y sus bundles coinciden con las fuentes locales. pg_net, Vault y pg_cron están disponibles. Vault tiene las tres referencias de Wybix; el job está INACTIVO. El inventario del 4 de octubre bajo cierre-operativo es evidencia histórica, no el estado vigente. Véanse FASES2-3-APLICACION.md y la evidencia depurada del despliegue actual.

| Edge remota | Versión | JWT gateway |
|---|---:|---|
| pos-sync | 3 | desactivado |
| link-owner | 6 | desactivado |
| license-check / trial-license | 7 / 6 | desactivado |
| fiscal-catalogs | 8 | desactivado |
| fiscal-register-issuer | 12 | desactivado |
| fiscal-invoice-files | 7 | desactivado |
| fiscal-stamp-invoice | 21 | desactivado |
| fiscal-cancel-invoice | 9 | desactivado |
| send-alert-push / notificar-alerta | 10 / 6 | desactivado |
| owner-mfa / notificaciones / fiscal-claim-history | 2 / 2 / 2 | desactivado |

La rotación de secrets incrementó automáticamente una revisión en todas las funciones. Los bundles de license-check, trial-license y fiscal-catalogs conservan exactamente su SHA-256 anterior: no se actualizó su código.

## Estado local

Monorepo Owner + POS Mobile, contratos Fase 1/2 y ocho migraciones Fase 3. Las pruebas actuales validan la cadena completa local. Windows tiene el adaptador de publicación/transferencias en su working tree; su liberación es una dependencia operativa para poblar eventos con catálogo/personal reales. No se considera desplegado porque exista código local.

## Migraciones — lista exacta y orden

| Orden | Archivo | Tratamiento / smoke inmediato |
|---:|---|---|
| 1 | 20260901000000_base_nube_legado.sql | Baseline: comparar tablas/columnas e índices ya existentes; no duplicar esquema |
| 2 | 20260926120000_licenciamiento_v2.sql | Baseline comercial: comparar catálogo/contratos sin cambiar precios; verificar `license_runtime` y trial |
| 3 | 20260926130000_pos_sync_sin_service_role.sql | Baseline de acceso: verificar RPCs y grants esperados |
| 4 | 20260927120000_licenciamiento_v2_final.sql | Confirmar transición comercial terminada; no aplicar contracción si algún cliente necesita contrato viejo |
| 5 | 20261002120000_fase1_multiempresa.sql | Nuevas entidades, scopes y hechos; leer `fase1_conciliacion` y comprobar RLS |
| 6 | 20261010120000_fase2_event_mobile.sql | Mobile/eventos/stock; confirmar addon y `company_entitlements` |
| 7 | 20261011100000_fase3_alerta_push_vault.sql | Trigger cerrado con Vault; alerta persiste si falta configuración |
| 8 | 20261011110000_fase3_mfa.sql | AAL1 lee; administración devuelve MFA_REQUIRED/MFA_ENROLL_REQUIRED |
| 9 | 20261011120000_fase3_notificaciones.sql | Planificación/leases/scopes; sin activar entrega hasta configurar proveedor |
| 10 | 20261011130000_fase3_notificaciones_cron.sql | Instala cron si disponible; comprobar un job `wybix-notificaciones` |
| 11 | 20261011140000_fase3_aprobaciones.sql | Solicitud, decisión AAL2, hash y consumo único |
| 12 | 20261011150000_fase3_fecha_negocio.sql | Fecha ligada al turno; no mover ventas al día de recepción |
| 13 | 20261011160000_fase3_aprobaciones_payload.sql | Evento alterado rechazado antes del ledger |
| 14 | 20261011170000_fase3_reconciliacion.sql | Nombres/causas, motivo requerido, ajuste único por conciliación |

**No ejecutar `db push --include-all` como primera acción.** El historial vacío exige resolver primero el baseline, con revisión semántica y backup. Las migraciones 1–4 son candidatos a registrar como aplicadas SOLO si se confirma su equivalencia, incluyendo constraints/grants. Si existe una diferencia material, preparar un parche explícito y volver a probarlo. No inventar entradas del historial para ocultar un delta.

Después de aprobar el baseline, registrar individualmente cada versión confirmada:

```powershell
supabase migration repair --linked --status applied 20260901000000
# Repetir, después de su revisión, para 20260926120000, 20260926130000 y 20260927120000.
```

Para cada migración nueva, por separado, el comando que requiere autorización es:

```powershell
supabase db query --linked --file supabase/migrations/20261002120000_fase1_multiempresa.sql
# Ejecutar el smoke, revisar esquema y logs. Solo entonces registrar ESTA versión:
supabase migration repair --linked --status applied 20261002120000
```

Repetir ese par, con el nombre y versión exactos de cada fila 6–14, sin bucle que continúe tras un fallo. Conservar salida sanitizada y comparar inventario antes/después. `migration repair` puede necesitar acceso SQL del propietario además de la sesión Management API. No colocar contraseñas en argumentos, Markdown ni logs.

## Edge Functions — lista exacta y orden

Todas estas acciones necesitan autorización de deploy. Usar este repositorio, nunca la copia vieja `wybix-supabase`. En cada fila ejecutar una función, hacer smoke y leer logs antes de continuar.

| Orden | Función | Dependencia | Smoke |
|---:|---|---|---|
| 1 | pos-sync | SQL Fase 1/2/3 | Sin credencial deniega; QA enrola/snapshot/sync y repetición única |
| 2 | link-owner | membresías/invitaciones | Invitación QA única; cuenta ajena no reclama empresa |
| 3–7 | fiscal-register-issuer, fiscal-stamp-invoice, fiscal-invoice-files, fiscal-cancel-invoice, fiscal-claim-history | Fase 1, proveedor fiscal, decisión de transición | Sin identidad deniega; scope ajeno deniega; no timbrar datos reales |
| 8 | owner-mfa | SQL MFA y GoTrue TOTP | Sin JWT 401; recuperación QA limitada y auditada |
| 9–10 | send-alert-push, notificar-alerta | Vault y WEBHOOK_SECRET nuevo | Sin secreto 401; no secretos/config inválida 503; recepción QA |
| 11 | notificaciones | SQL entregas, proveedores y Vault | Sin secreto deniega; ciclo autenticado procesa solo QA |

Ejemplo exacto, repetir por slug de la tabla:

```powershell
supabase functions deploy pos-sync --project-ref swlpspgmkwzlrowllvvj --no-verify-jwt
```

El gateway no exige JWT porque POS autentica credencial propia, owner-mfa verifica la sesión en el handler y workers verifican secreto. No confundir `--no-verify-jwt` con endpoint sin autenticación. No se requiere redeploy de `license-check`, `trial-license` o `fiscal-catalogs` solo por su existencia: revisar contrato/signatura y agregarlo al plan únicamente si el delta semántico lo requiere.

## Secrets

Existen por nombre: `FISCALAPI_API_KEY`, `FISCALAPI_TENANT`, `FISCALAPI_URL`, `LICENSE_PUBLIC_KEYS`, `LICENSE_SECRET`, `LICENSE_SIGNING_KEY`, `LICENSE_SIGNING_KID`, `WEBHOOK_SECRET` y secretos administrados `SUPABASE_*`. Valores no consultados ni publicados. La presencia de un nombre no demuestra que una credencial funcione.

Faltan `RESEND_API_KEY`, `NOTIF_EMAIL_FROM`. `EXPO_ACCESS_TOKEN` es condicional a la configuración de seguridad push de Expo. Validar dominio/remitente con el proveedor antes de activar email. WEBHOOK_SECRET ya se rotó coordinadamente con Vault y se comprobó mediante una petición vacía autenticada sin destinatarios. Las llaves de licencia y Android se preservaron.

`FISCAL_PERMITIR_LEGADO` no existe. Decidir expresamente si hay POS fiscales antiguos: habilitarlo solo durante una transición controlada, usando las restricciones del handler; retirarlo cuando se haya actualizado el último cliente. No habilitarlo por conveniencia del QA.

Guardar valores nuevos en archivo local ignorado bajo `.secrets/` o en el gestor de secretos. La acción reservada sería `supabase secrets set --project-ref swlpspgmkwzlrowllvvj --env-file <archivo-local-ignorado>`. No usar placeholders vacíos para reemplazar secretos existentes.

## Vault

`wybix_webhook_secret`, `wybix_alerta_push_url` y `wybix_notif_url` ya están configurados. El primero coincide con WEBHOOK_SECRET; las URL apuntan a `/functions/v1/send-alert-push` y `/functions/v1/notificaciones`. Valores y SQL con credenciales permanecen bajo .secrets; la evidencia versionable incluye solo nombres/resultados.

## Dependencias

Backup verificable → baseline confirmado → Fase 1 → conciliación de identidades → Fase 2 → MFA → aprobaciones. Notification engine precede al worker; worker/proveedores/secretos preceden a activar cron. La migración cron puede registrar el job antes: mantener desactivado `cron.alter_job(..., active := false)` hasta tener configuración lista; activarlo es otra acción remota autorizada. TOTP en Auth y credenciales FCM/Expo requieren comprobación del propietario: no se certificaron mediante los inventarios SQL.

Mobile usa `/backend/functions/v1/pos-sync`; ese rewrite existe en la landing actual. Owner usa Supabase directamente. La cobertura actual del rewrite de la landing no incluye fiscales; comprobar la URL usada por la versión Windows que se vaya a liberar antes del smoke fiscal. No desplegar la landing como efecto colateral.

## Riesgo

**HIGH** para Fase 1/baseline y cambio de scopes fiscales; **MEDIUM** para Fase 2/MFA/reconciliación y activación de notificaciones; **LOW** para consultas de preflight y documentación. No hay ensayo en staging que reduzca el riesgo productivo. Usar ventana de mantenimiento coordinada y una empresa QA separada; no reutilizar I Do Nut real.

## Rollback

- Preflight/baseline: si no hay equivalencia o backup, no aplicar. Un historial reparado erróneamente se corrige con `migration repair --status reverted <versión>`; eso NO revierte DDL ni datos.
- Fase 1/2: existen reversas en `supabase/rollback/`, pero retiran entidades y cambian scopes. **No ejecutarlas automáticamente** ni sin nueva autorización de acciones destructivas. Preferir pausar nuevos enrolamientos, conservar datos y aplicar forward fix. Restaurar backup/PITR requiere ventana y decisión explícita.
- MFA/aprobaciones/conciliación: conservar auditoría y permisos consumidos; no volver al handler inseguro para recuperar disponibilidad. Pausar acciones administrativas/nuevas aprobaciones, investigar y corregir hacia adelante.
- Entregas: desactivar el job cron primero; conservar colas y leases. Volver a una revisión segura del worker; no retornar al webhook abierto. Los reintentos respetan idempotencia.
- Edge: conservar revisión anterior y bundle antes del deploy en almacenamiento restringido; no versionar bundles que puedan incluir secretos históricos. Restaurar una revisión solo tras comprobar que no abre accesos cruzados. No publicar clientes hasta terminar los smokes.

## Smoke tests y gate

Después de cada etapa: SELECT de tablas/columnas/RPCs/RLS/triggers del bloque, llamada positiva QA, llamada negativa sin identidad/otro scope, ausencia de errores nuevos en logs y verificación de una operación legacy pertinente. Ante fallo, detener el bloque, conservar evidencia y no continuar automáticamente.

Consulta repetible sin datos sensibles: `supabase db query --linked --file supabase/scripts/fase3-preflight.sql -o json`. No ejecutar las suites que siembran pruebas contra el proyecto remoto.

**Pendientes:** proveedor/remitente email, recepción push/email, Auth TOTP real y prueba Owner AAL2, conciliación de la app Owner no verificada y hardware. Cron sigue apagado hasta verificar la entrega. Las cinco licencias excluidas no bloquean estas tareas. El backend pasó enrolamiento/snapshot/PIN/venta/turno/cierre reales en dos empresas QA aisladas. Se solicitó APK interno EAS con la llave existente; revisar RELEASE-EAS.md para resultado de build/firma. No se publicó en tiendas ni se hizo push Git.
