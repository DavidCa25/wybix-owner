# Relevo técnico — 4 de octubre de 2026

## A. Punto recibido y fuentes

Claude dejó la Fase 3 al comenzar la validación de impresión. Se inspeccionaron Git, cambios, archivos nuevos/ignorados, migraciones, servicios y pruebas; no se repitió la auditoría histórica.

El encargo y la auditoría inicial se recuperaron de la conversación local de Claude y quedaron en `fase3-encargo.md` y `fase3-auditoria-claude.md`. No se encontró un archivo independiente con el nombre WYBIX MASTER CONTEXT. El código y las pruebas actuales prevalecieron sobre las afirmaciones de los documentos.

## B. Estado inicial comprobado

| Bloque | Lo recibido | Hallazgo del relevo |
|---|---|---|
| Etapa 0 | Ignorados Android/llaves, permisos deduplicados, webhook cerrado y Vault | Implementación presente; respaldo de llave y rotación productiva pendientes |
| MFA | SQL, Auth, Edge, Owner y recuperación | No se reimplementó; se repitió E2E local real |
| Notificaciones/push/email | Cola, entregas, preferencias y worker | Código y pruebas presentes; proveedores reales pendientes |
| Aprobaciones | Solicitud/decisión/consumo, Owner y Mobile | Faltaba verificar materialmente el evento ejecutado antes de proyectarlo |
| Fecha de negocio | Fecha de turno y desfase | Cubiertos por pruebas existentes |
| Impresión | Servicio con auditoría y permisos | Mobile aún guardaba configuración y resultado directamente; faltaba UI funcional |
| QA | Suites Node/SQL y campaña de demos activa | Node 88/89 inicialmente; tipos fallaban; SQL 64/64 |
| Tooling | Supabase local en scratch, artefactos y logs | Se identificaron, conservaron y separaron de evidencia final |

El test inicial de impresión confundía `null` de SQLite con `undefined`; las pruebas de API tampoco estrechaban callbacks opcionales antes de invocarlos. Se corrigieron las pruebas, sin relajar contratos.

## C. Working tree y acciones reservadas

El monorepo ya tenía una reorganización extensa Owner/paquetes/Mobile, con cambios staged, unstaged y untracked. Desktop también tenía cambios de Claude. Se preservó ese trabajo; no hubo reset, stash, commit, push, deploy, publicación, build remoto ni rotación de credenciales en este relevo.

Git conservaba como último commit local `81e419d` del 2 de octubre. La consulta de solo lectura a funciones del proyecto mostraba `pos-sync` v1 y ausencia de los nuevos endpoints MFA/notificaciones. Esa evidencia no permite certificar toda acción histórica externa, pero confirma que el backend requerido no estaba listo para un APK productivo.

## D. Residuos y aislamiento

- La llave `.jks` local está ignorada. No se abrió, movió, borró ni regeneró. Su respaldo definitivo requiere al propietario.
- `npm ls` encontró 13 dependencias extraneous, incluyendo soporte web utilizado en QA de Owner. Se conservaron; no se instaló ni podó dependencias durante el relevo.
- La configuración temporal `owner-web-local` en el launch de Desktop y el scratch de Claude se conservaron, identificados como tooling local.
- Supabase local corre en contenedores `*_sb-local`; no se cambió su configuración global. Para QA se actualizaron dos copias de módulos Edge en su scratch con respaldo y se reinició exclusivamente el runtime local. La copia antigua no incluía `approval_request`.
- Los logs de este relevo se agruparon en `evidencia/fase3/relevo/`. Los primeros fallos son evidencia histórica, no el resultado final.
- Se creó una empresa sintética y el usuario Android 10 para no sobrescribir la SQLite/credencial del usuario Android 0. Los usuarios Auth de prueba y el escenario local se conservaron.
- La campaña `db:test-demo` de Claude terminó con 73 comprobaciones correctas y verificaciones de identidad de las demos reales. La demo real Hospitality no se recreó: la fecha de creación siguió siendo del 26 de septiembre. No se ejecutaron escrituras contra demos reales en este relevo. Esta comprobación no equivale a comparar cada fila contra un backup.
- `db:test-giros` utiliza ahora `Wybix_Demo_PruebaServicios` y guardas de aislamiento. No se encontró un resultado nuevo de esa campaña completa; el resultado histórico no se presentó como prueba actual.

## E. Continuación ejecutada

Se completó el flujo de impresión, se vinculó la autorización remota con el payload ejecutado, se agregó conciliación con nombres/causas y ajustes trazables, se incorporaron niveles de QA y conexión SQL persistente opcional, y se corrigió el punto de entrada del worker Android. La evidencia y los gates vigentes están en `fase3-cierre-tecnico.md`.
