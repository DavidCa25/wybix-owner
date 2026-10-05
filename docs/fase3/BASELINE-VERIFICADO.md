# Baseline remoto comprobado — 2026-10-04

Fuente remota: live-baseline-inventory.json proporcionado por el propietario, 23:49 hora local. Copia lógica restaurada en Docker sin red: 55 tablas COPY, 8.783 registros, historial de migraciones vacío. Datos y definiciones privadas permanecen en .secrets; no se versionan.

## Dictamen

| Migración | Estado | Evidencia / decisión |
|---|---|---|
| 20260901000000_base_nube_legado | EQUIVALENTE CON DIFERENCIAS IRRELEVANTES, después de corregir el archivo local | El original era NO EQUIVALENTE: 12 columnas numeric no reproducían numeric(12,2). Corregidas únicamente sus declaraciones CREATE TABLE locales; no se alteraron columnas remotas. Índices redundantes y políticas/webhook legados adicionales no son efectos exigidos por este archivo. |
| 20260926120000_licenciamiento_v2 | EQUIVALENTE CON DIFERENCIAS IRRELEVANTES | Parte A presente: columnas, restricciones, índices, grants requeridos, RLS/policy del catálogo, trigger de auditoría, 23 funciones y contratos del catálogo coinciden con referencia local. Los hashes de las funciones diferían por CRLF/LF; la normalización exclusiva de saltos de línea demuestra cuerpos iguales. Dos funciones legadas adicionales no forman parte del contrato introducido por esta migración. |
| 20260926130000_pos_sync_sin_service_role | EQUIVALENTE | sync_token_hash text y ux_sucursales_sync_token presentes, incluyendo unicidad y filtro IS NOT NULL. Esto prueba solo SQL; no certifica el bundle Edge pos-sync ni rotación de llaves. |
| 20260927120000_licenciamiento_v2_final | NO EQUIVALENTE | max_registers aún NOT NULL DEFAULT 1; legacy_max_registers('multi') conserva 0; faltan licenses_max_registers_check y licenses_edicion_cajas_check. No registrar como aplicada. Su aplicación requiere verificar antes compatibilidad de emisores web y Edge con MultiCaja=NULL. |

## Método y límites

Se construyeron referencias locales desde los archivos históricos, sin datos de clientes, en bases nuevas del contenedor aislado. La referencia corregida de las tres primeras migraciones tiene todos los objetos y atributos exigidos presentes en el remoto: 26 tablas/vistas, 259 columnas, 68 constraints; índices, privilegios, RLS, policies y triggers requeridos comprobados. Se revisaron también objetos adicionales. Las definiciones de las funciones de la copia restaurada tienen los mismos hashes que el inventario remoto actual; comparadas contra referencia, las 23 funciones de Parte A son iguales al normalizar CRLF a LF, sin eliminar comentarios ni alterar código.

La primera referencia creada como supabase_admin produjo diferencias artificiales de propietarios/grants. La comprobación definitiva crea los objetos históricos como postgres, igual que el remoto. Las dos FK a auth.users se compararon con la misma tabla destino: users frente a auth.users en pg_get_constraintdef era solo visibilidad del search_path.

Extras: dos índices legados, dos funciones, ocho políticas Owner previas y webhook alerta-push. No se consideran ausentes ni se eliminan. Las políticas y el webhook son diferencias intencionalmente fuera de la migración base, no una certificación de seguridad: Fase 1 sustituye políticas; Fase 3 mueve el secreto del webhook a Vault. No declarar que los riesgos de estos objetos son irrelevantes para la plataforma.

Se cotejaron los grants efectivos esperados, incluyendo propietarios correctos, grants anon/authenticated/service_role y restricción de funciones. Las capabilities del catálogo coinciden; no se sobrescriben precios ni datos comerciales. Este dictamen no autoriza aplicar la Parte B ni las fases nuevas, y no sustituye el smoke de compatibilidad de Edge/emisores.

## Validación local

test:full tras corregir tipos: TypeScript PASS, Node 94/94, SQL Fase 3 72/72; referencia histórica corregida construida en transacción satisfactoriamente. Backup restaurado y conteos comprobados; no se restauró ni escribió Supabase remoto. No se ejecutó migration repair, deploy, secrets/Vault ni EAS.

## Siguiente acción del propietario

Registrar primero SOLO 20260901000000 con migration repair --linked --status applied. Esperar salida, verificar historial con SELECT y luego registrar las otras dos equivalentes, una por una. Mantener 20260927120000 pendiente hasta verificar su gate. Ninguna cadena db push --include-all.

## Avance manual y gate Parte B — 2026-10-05

Propietario registró las tres primeras versiones; SELECT remoto confirmó las tres, sin la cuarta. Se descargaron únicamente copias de lectura de los bundles desplegados a .secrets/cloud-pre-b, sin reemplazar código del repositorio ni desplegar funciones. license-check v6 y trial-license v5 tienen entradas iguales a las locales; certificate conserva registers_max nullable y license-check traduce NULL a 0 para clientes anteriores. pos-sync v1 no lee max_registers ni emite licencias: no necesita actualización para este cambio específico, aunque sigue pendiente su actualización Fase 1/2/3.

Preflight SELECT remoto: cero planes inválidos; dos licencias MultiCaja aún en formato legado; cero MonoCaja por normalizar. No se consultaron claves ni datos de titulares.

El emisor local api/license/issue.ts usa license_create_from_order y no escribe max_registers directamente. Falta confirmar que el deployment Production de Vercel contiene ese emisor. GitHub privado no accesible sin sesión y no hay credenciales Vercel locales disponibles; no se instalaron herramientas ni se inició login. Solicitar al propietario Source/commit del deployment vigente, revisar ese commit localmente y solo después preparar aplicación transaccional de la Parte B, smoke y registro manual separado.

### Gate de emisor resuelto y ensayo Parte B

Propietario identificó el commit Production ebec626f48320738f57b3f3447bfbdc423d49cf0. api/license/issue.ts de ese commit cotiza con license_quote y emite por license_create_from_order; no escribe max_registers directamente. Esto, junto a los bundles Edge verificados, permite preparar Parte B.

En una copia local nueva de la base restaurada, sin red, se ensayó la migración exacta con BEGIN/COMMIT y guards de baseline/planes. Resultado: dos MultiCaja normalizadas a NULL, cero MonoCaja incorrectas, dos constraints presentes, legacy y runtime multi=NULL, un evento de auditoría. Conteos de las 55 tablas conservados salvo el evento de auditoría añadido; una segunda aplicación mantuvo un solo evento. Archivo manual apply-20260927120000.sql en .secrets, sin registro automático de historial. Pendiente ejecución remota por propietario, smoke de solo lectura y después reparación manual de esta cuarta versión.

### Baseline terminado y preparación Fase 1

Propietario aplicó Parte B; seis controles remotos de solo lectura pasaron. Después registró 20260927120000: SELECT confirmó las cuatro versiones históricas. Preflight Fase 1 proporcionado por propietario: baseline/contrato/licencias/pgcrypto correctos, sin Fase 1 instalada ni registrada, cero owners/sucursales huérfanos.

Se prepararon apply-20261002120000.sql (BEGIN/COMMIT, guards del baseline y contrato) y fase1-smoke.sql en .secrets. Ensayo local en copia nueva de la restauración: aplicación y repetición exitosas, nueve controles booleanos correctos, dispositivos y membresías sin duplicación. Conciliación local dejó OWNER_APP_UNVERIFIED=1 y LICENSE_UNLINKED=5, sin asignaciones arbitrarias. Los conteos de tablas originales se preservaron salvo auditoría prevista de licencias/catálogo. La ejecución remota, smoke y registro siguen a cargo del propietario; RLS cambia y el riesgo de esta etapa es HIGH. No desplegar todas las Edge ni resolver pendientes de identidad a ciegas como efecto colateral.
