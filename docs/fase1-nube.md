# Fase 1 en la nube: multiempresa, equipos, hechos y CFDI con dueño

Estado: implementado y probado en local (`node scripts/probar-fase1.mjs`, 127/127).
**No desplegado.** Nada de esto está en producción.

## Qué cambia

| Antes | Ahora |
| --- | --- |
| Un `negocio` + una `sucursal` por computadora (`provision`). | Empresa → ubicación → equipo. La base de SQL Server (`instance_uuid`) es la ubicación; dos PCs de la misma sucursal son la misma ubicación. |
| Token por sucursal. | Credencial por equipo (`devices`); el token anterior sigue sirviendo hasta que el POS se actualiza. |
| Acceso del dueño por `negocios.owner_id`. | Membresías (`company_memberships`), creadas solo con una invitación de un solo uso. |
| Funciones fiscales con `issuerId`/`invoiceId` del cuerpo y la llave anónima. | `fiscal_autorizar`: identidad del equipo → empresa → emisor → factura. |
| Espejo de resúmenes. | Además, hechos idempotentes (`sync_events` + `sales_facts`, `shift_facts`, `cash_movement_facts`). |
| Esquema creado a mano. | `20260901000000_base_nube_legado.sql` lo versiona tal como está en producción. |

## Orden de despliegue (cuando se apruebe)

1. Respaldo del proyecto (Dashboard → Database → Backups) y `pg_dump` de `public`.
2. `supabase db push --include-all`: aplica la base versionada (sin efecto en producción, solo `if not exists`) y `20261002120000_fase1_multiempresa.sql`.
3. Revisar `select * from fase1_conciliacion;`. En los datos actuales se esperan `LICENSE_UNLINKED` y `OWNER_APP_UNVERIFIED` (la app que se ligó sin invitación).
4. Desplegar `pos-sync`, `link-owner`, `fiscal-*` y `fiscal-claim-history`. Las fiscales llevan primero **`FISCAL_PERMITIR_LEGADO=1`** mientras haya POS anteriores.
5. Agregar las funciones fiscales al rewrite de `wybix-landing/vercel.json` (ya está en el diff) y desplegar la web.
6. Publicar el POS nuevo. Cuando ya no queden POS anteriores facturando, **quitar `FISCAL_PERMITIR_LEGADO`**.
7. Publicar la app del dueño (selector de empresa, QR con invitación).

## Transición fiscal

- Los POS anteriores llaman sin credencial de equipo. Con `FISCAL_PERMITIR_LEGADO=1` se les atiende **solo** si el emisor o la factura no tienen empresa en la nube (`fiscal_legado_libre`). En cuanto la empresa dueña se actualiza y registra o reclama su emisor, queda protegida.
- El POS nuevo reclama su histórico (`fiscal-claim-history`). El RFC sale de Fiscalapi, no del cuerpo.
  - Si **una** empresa reclama un emisor, queda `PENDING_RECONCILIATION`: puede seguir timbrando y aparece en `fase1_conciliacion`.
  - Si **dos** empresas lo reclaman, queda `CONFLICT`, bloqueado para todas, y se resuelve con `fiscal_conciliar_emisor`.
- No se inventa dueño: el conteo de pendientes es el reporte.

## Reversa

`supabase/rollback/20261002120000_fase1_multiempresa.down.sql` (una transacción, idempotente):

- Respalda todo lo nuevo en `respaldo.fase1_rb_*`.
- Restaura las políticas originales (`respaldo.fase1_politicas`), los privilegios y los grants del catálogo.
- Quita lo nuevo.

Después hay que volver a desplegar las funciones anteriores. Dos efectos a tener en cuenta:

- Los POS ya actualizados dejan de sincronizar hasta reaprovisionar.
- Vuelve la vulnerabilidad fiscal P0.

## Riesgos que quedan

- **Disparador `alerta-push`**: en producción lleva el secreto del webhook escrito en su definición (`x-webhook-secret`). No se versionó. Hay que rotarlo y moverlo a Vault o a un secret de la función.
- **Llave de instalación** en `database_metadata` de SQL Server: quien tiene acceso a la base de la sucursal puede unir un equipo a **esa** ubicación (la nube exige la misma `instance_uuid`). Es la misma frontera que ya da acceso a los datos.
- **Restaurar el respaldo de una sucursal en otra** copia su `instance_uuid` y su llave. Hay que documentarlo en soporte, o en la Fase 2 regenerar la instancia al detectar un servidor distinto.
- **Derechos por empresa** (`locations_max` y similares): se calculan e informan (`company_entitlements`, `enforced: false`); no se aplican hasta que la web venda por empresa.
- **Borrar cuenta** desde el POS ya no puede borrar una empresa con varias ubicaciones. Esa acción falta en la app del dueño (Fase 2).
- **`fiscal-catalogs`** sigue con la llave anónima: son catálogos públicos del SAT y no exponen datos de nadie.
