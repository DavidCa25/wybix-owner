# Fases 2 y 3 — aplicación remota verificada

2026-10-05. Fase 1 aplicada por propietario, nueve controles correctos, historial remoto con cinco versiones previas. Conciliaciones OPEN: OWNER_APP_UNVERIFIED=1, LICENSE_UNLINKED=5. No se resuelven sin evidencia ni se asignan licencias arbitrariamente.

## Alcance y autorización

El propietario autorizó continuar los siguientes pasos, excluyendo las cinco licencias antiguas de prueba sin empresa. Se aplicaron Fase 2 y las ocho migraciones Fase 3, con smoke de contratos/permisos antes de registrar cada versión. El historial remoto contiene las catorce versiones previstas. Las cinco licencias excluidas no se vincularon ni eliminaron.

Las once Edge Functions del delta se desplegaron individualmente, se descargó cada bundle para comparar sus fuentes con el repositorio y se comprobó el rechazo sin identidad. WEBHOOK_SECRET se rotó y las tres referencias Vault quedaron configuradas. El webhook rechaza llamadas sin secreto con 401; una petición autenticada sin alerta devuelve 400 sin enviar mensajes. Cron permanece INACTIVO: faltan proveedor/remitente email y recepción física verificada.

Se crearon dos licencias nuevas origin=QA, independientes de las cinco excluidas, según el piloto aprobado. El backend público de la landing pasó bootstrap, derechos Mobile, publicación, enrolamiento de un uso, snapshot, PIN SQLite, aislamiento, venta/turno/cierre, sincronización y repetición sin duplicar hechos. Auth real remoto pasó TOTP, AAL1/AAL2, decisión/consumo único y recuperación Edge de un uso con identidad QA sintética. Validación visual Owner/autenticador física pendiente. EAS usa la llave definitiva existente; su certificado coincide con el JKS local y el APK final. El segundo build interno terminó; firma, hash, runtime y metadatos se verificaron. Resultado y artefacto en RELEASE-EAS.md; piloto físico con código nuevo y acceso privado preparado.

## Preparación y evidencia

En .secrets/backup-fase3-20261004-232515 quedan phase23-plan.json, un apply-<version>.sql transaccional y un smoke-<version>.sql de solo lectura por etapa. Los guards exigen la versión previa; los scripts no registran historial automáticamente. Los smokes comprueban tablas, tipos/defaults/nullability, restricciones, índices, cuerpos de funciones mediante hashes normalizados, permisos efectivos, RLS/policies y triggers. Las definiciones con secrets y datos de clientes no se imprimen ni se versionan.

Se creó un contenedor LOCAL independiente, sin red, con Supabase Postgres 17.11 y pg_cron 1.6.4. Se restauró el backup verificado y se aplicó el baseline/Fase 1. Las nueve etapas de Fase 2/3 se aplicaron individualmente, con smoke y registro LOCAL de cada versión, y se repitieron para verificar idempotencia. Los smokes pasaron. cron fue probado realmente y el job permaneció INACTIVO. Evidencia detallada: phase23-rehearsal-evidence.json en carpeta protegida.

test:full actual: TypeScript PASS, Node 94/94, SQL 75/75. La suite local simula los grants por defecto de Supabase; se corrigieron permisos heredados en location_stock y funciones internas. Ninguna suite local sembró producción. El smoke positivo remoto independiente utiliza exclusivamente las dos empresas QA nuevas y conserva su evidencia privada.

## Orden SQL

1. 20261010120000_fase2_event_mobile: eventos, cupos/entitlements Mobile, catálogo, PIN/staff, stock, transferencias y contratos sync. Riesgo HIGH por enforcing de capacidades.
2. 20261011100000_fase3_alerta_push_vault: reemplaza webhook con secreto literal por lectura de Vault. Alertas persisten; push queda suspendido si Vault no está configurado. Riesgo MEDIUM.
3. 20261011110000_fase3_mfa: AAL2, recovery y límites. Riesgo MEDIUM; requiere Auth TOTP para pruebas reales.
4. 20261011120000_fase3_notificaciones: preferencias, deliveries, leases, dedup y RPCs. Riesgo MEDIUM; no invocar worker autenticado contra datos reales en smoke.
5. 20261011130000_fase3_notificaciones_cron: instala scheduler y crea job INACTIVO. Se corrigió el archivo fuente para que la migración no active entregas. Activación posterior requiere configuración/proveedor verificados y autorización específica. Riesgo MEDIUM.
6. 20261011140000_fase3_aprobaciones: MFA, solicitud/decisión/consumo. Riesgo MEDIUM.
7. 20261011150000_fase3_fecha_negocio: fecha anclada al turno y desfase. Riesgo MEDIUM.
8. 20261011160000_fase3_aprobaciones_payload: valida autorización/payload antes de aplicar efectos. Riesgo MEDIUM.
9. 20261011170000_fase3_reconciliacion: desglose, motivo y ajuste único. Riesgo MEDIUM.

Por etapa: ejecutar solo su apply, revisar el resultado y errores, ejecutar su smoke, inspeccionar catálogos/logs, y solo después migration repair --status applied para esa versión. Nunca continuar automáticamente ante contrato distinto ni registrar una etapa fallida. Las diferencias de plataforma/versiones que aparezcan en un smoke requieren revisión; no se ignoran para forzar verde. Conservar backups y resolver fallos hacia adelante; no ejecutar reversas destructivas.

## Delta Edge comprobado

Las fuentes remotas se descargaron solo a almacenamiento protegido, sin reemplazar archivos del repositorio. Necesitan actualización: pos-sync, link-owner, fiscal-register-issuer, fiscal-stamp-invoice, fiscal-invoice-files, fiscal-cancel-invoice, send-alert-push y notificar-alerta. Faltan remotamente: fiscal-claim-history, owner-mfa y notificaciones. Total: once funciones; ejecutar individualmente y verificar tras cada deploy.

Orden: pos-sync → link-owner → fiscal-register-issuer → fiscal-stamp-invoice → fiscal-invoice-files → fiscal-cancel-invoice → fiscal-claim-history → owner-mfa → send-alert-push → notificar-alerta → notificaciones. JWT gateway desactivado solo porque cada handler valida su credencial/JWT/secreto propio. license-check/trial-license ya son compatibles; fiscal-catalogs no cambia por esta fase.

Después de cada deploy: confirmar revisión/estado/configuración remota, verificar el bundle desplegado y rechazo sin identidad antes de cualquier proveedor o efecto comercial. Las pruebas positivas completas requieren empresa/licencia QA y actores reales autorizados; no usar datos productivos para timbrar, cobrar o enviar correos de prueba. EAS/APK final y UI física no se certifican con un rechazo HTTP ni con metadata SQL.

## Gates que quedan separados

WEBHOOK_SECRET debe rotarse coordinadamente con Vault; RESEND_API_KEY y NOTIF_EMAIL_FROM requieren proveedor/remitente. EXPO_ACCESS_TOKEN depende del modo de seguridad push del proyecto; FCM/Auth TOTP se verifican por separado. Vault necesita wybix_webhook_secret, wybix_alerta_push_url y wybix_notif_url. No mostrar valores ni regenerar llaves de licencia/Android.

La actualización de funciones fiscales pasa a scopes por dispositivo; POS antiguos sin credencial pueden requerir la transición FISCAL_PERMITIR_LEGADO, que no se activa automáticamente. Este cambio de acceso debe coordinarse con los clientes que sigan facturando.

Las cinco licencias sin vínculo quedan excluidas por decisión del propietario; no son un gate del piloto ni se reutilizan. La app Owner no verificada requiere evidencia del propietario para conciliarla. Los derechos Mobile de ambas empresas QA se comprobaron mediante company_entitlements. Cron inactivo implica que la entrega programada no está operativa todavía. Hardware, recepción push/email, MFA físico y actualización firmada siguen según PRUEBAS-MANUALES-CIERRE-FASE3.md. No se habilitó FISCAL_PERMITIR_LEGADO ni se timbraron/cancelaron facturas de prueba.
