# Fase 2 · EVENT y Wybix POS Mobile — diseño

Capacidad oficial y reutilizable (no exclusiva de I Do Nut): **una tablet en una
ubicación EVENT vende sin Internet**. Durante el evento, la autoridad es el
SQLite cifrado de la tablet; la nube solo enrola, distribuye maestros, recibe
hechos, consolida y reporta.

## 1. Piezas

```
Centro (POS Windows + SQL Server)          Nube (Supabase)                    Feria (tablet)
  sp_transfer_send  ── TRANSFER_SENT ──▶  sync_ingest → stock_transfers ──▶  mobile_snapshot
  sp_catalog_publication ─ publish ─────▶  catalog_publications (vN)  ─────▶  catálogo vN
  sp_staff_publication   ─ publish ─────▶  employees (PIN publicado) ───────▶  staff por evento
  QR firmado (Ed25519) ───────────────── (sin red) ────────────────────────▶  importarTransferencia
                                          sync_ingest ◀── events (outbox) ──  ventas, turnos, merma…
  pos_transfer_inbox ◀── RETURN ────────  stock_transfers (RETURN)  ◀───────  regresarSobrante
  sp_transfer_receive_return
```

- **Centro es la autoridad de SU inventario**: mandar a una feria es una SALIDA
  en su SQL Server (`TRANSFER_OUT`); recibir el sobrante, una ENTRADA
  (`RETURN_TRANSFER_IN`). Quién lo hace sale de la sesión del POS.
- **La feria no tiene SQL Server**: su inventario es el ledger de la tablet y,
  en la nube, `inventory_ledger` (hechos) con la vista `location_stock`.
  Nunca se guarda “stock = 8”.

## 2. Monorepo (`wybix-owner`, npm workspaces)

```
apps/owner        Wybix Owner (com.wybix.owner)
apps/pos-mobile   Wybix POS Mobile (com.wybix.posmobile)
packages/domain   decimal exacto, receta efectiva, venta, inventario, caja, permisos, uuid
packages/database SQLite: migraciones, POS local, snapshot, sincronía, cobros
packages/auth     PIN scrypt (idéntico al POS de Windows)
packages/sync     motor de sincronización, QR firmado
packages/api      cliente de la Edge Function pos-sync
packages/ui       tema y componentes de la tablet
supabase/         migraciones, Edge Functions, pruebas SQL, reversas, scripts
```

Una sola versión de React (19.1.0) y React Native (0.81.5) en la raíz. Los
paquetes exportan TypeScript fuente; Node 24 los ejecuta directo en pruebas.

**Metro en el monorepo**: `apps/*/metro.config.js` fija la raíz del servidor en
la app **solo** para `expo export:embed` (lo que corren Gradle y EAS en un build
release). Sin eso el release no resuelve la entrada `../../node_modules/expo-router/entry.js`;
con la raíz cambiada siempre, el modo desarrollo deja de servir el bundle.

## 3. EVENT

`sucursales.tipo = 'EVENT'` con `event_status`:

```
PLANNED ──▶ OPEN ──▶ CLOSED ──▶ RECONCILED
              ▲         │
              └─────────┘ (reabrir)
```

- Se crea con **sucursal base** (`HOME_REQUIRED`): de ahí salen catálogo,
  personal y mercancía; hereda su zona horaria.
- **Conciliar** exige: sin turnos abiertos (`SHIFTS_OPEN`), sin mercancía en
  camino (`TRANSFERS_IN_TRANSIT`) y existencias en cero (`STOCK_NOT_ZERO`). Con
  existencias, solo con `forzar` + motivo; el faltante queda en
  `sucursales.reconciliation` (no se esconde).
- **Evento cerrado**: en cuanto la tablet recibe el snapshot con el evento
  CLOSED o RECONCILED, ya no abre turnos nuevos (lo vendido sin red antes de
  saberlo sí se acepta al sincronizar).
- **Personal por evento** (`location_staff`): ser encargado en Centro no da
  permisos en la feria.
- **Tablets**: código de 24 h, un uso, con su caja (`F1`, `F2`…). Solo en EVENT
  PLANNED/OPEN y con cupo (`mobile_pos_max`).

## 4. Derechos (se APLICAN)

`company_entitlements()` + `wx_permite(company, acción)`:

| Acción | Requisito | Código si falta |
|---|---|---|
| Crear BRANCH | licencia ligada y cupo `locations_max` | `NO_LICENSE`, `LIMIT_LOCATIONS` |
| Crear EVENT | `temporary_locations` | `NO_ENTITLEMENT_TEMPORARY_LOCATIONS` |
| Enrolar tablet | `mobile_pos` y cupo `mobile_pos_max` | `NO_ENTITLEMENT_MOBILE_POS`, `LIMIT_MOBILE_POS` |

Un EVENT no cuenta como sucursal. Dar de baja una tablet libera su cupo.
Perder el derecho nunca da de baja las tablets que ya están. Complemento nuevo
`ADDON_MOBILE_POS` (precio por definir).

## 5. Tablet: SQLite local

SQLCipher 4.7 (expo-sqlite `useSQLCipher`), llave de 32 bytes en SecureStore
(`WHEN_UNLOCKED_THIS_DEVICE_ONLY`), `allowBackup=false`. **Una sola conexión y
una cola en JS** (`apps/pos-mobile/lib/base.ts`): `withExclusiveTransactionAsync`
abre otra conexión sin la llave. La llave, el `device_uuid` y la apertura se
crean una sola vez por proceso (antes, dos aperturas simultáneas podían generar
dos llaves y dejar la base ilegible).

Migraciones reales (`schema_migrations`), probadas en instalación limpia,
re-ejecución, v1→v2 con datos y migración que falla (no deja nada a medias).

| Tabla | Qué guarda |
|---|---|
| `kv` | identidad, releases, impresora, último estado |
| `catalog_versions`, `products` | catálogo por versión (N y N+1 conviven) |
| `staff`, `pin_attempts` | personal del evento con hash de PIN; bloqueos |
| `payment_methods`, `trusted_keys` | métodos de pago; llaves Ed25519 de la sucursal |
| `shifts` | turnos (uno abierto por caja: índice único parcial) |
| `sales`, `sale_lines`, `payments` | venta congelada (precio, costo, receta, versión de catálogo) |
| `inventory_movements` | ledger local (`TRANSFER_IN`, `SALE`, `WASTE`, `ADJUSTMENT`, `RETURN_TRANSFER_OUT`…) |
| `cash_movements` | fondo, efectivo de venta, retiros, egresos |
| `transfers`, `transfer_lines` | enviado vs recibido; origen snapshot / QR / local |
| `stock_projection` | proyección reconstruible desde el ledger |
| `outbox` | `event_uuid`, empresa, ubicación, dispositivo, agregado, tipo, `occurred_at`, `local_seq`, payload, `schema_version`, estado, intentos, último error |
| `inbox` | hechos de otras tablets del evento (por cursor) |
| `audit_local` | autorizaciones de encargado, PIN fallidos (sin el PIN) |
| `payment_intents` | cobro electrónico idempotente por venta (v2) |
| `print_jobs` | impresión: la venta vale aunque no imprima (v2) |

## 6. Operación sin Internet

- Enrolamiento y snapshot con red; después, todo local: PIN (scrypt), turno,
  venta en UNA transacción (venta + líneas + pagos + inventario + caja +
  outbox), merma/ajuste con autorización, recibir transferencia, corte a ciegas,
  regresar sobrante.
- Catálogo N → N+1: lo vendido con N se queda con N; un producto desactivado
  deja de venderse en N+1.
- Recepción sin red: QR firmado por la caja de Centro (`WXT1.<manifiesto>.<firma>`);
  se verifica con la llave de confianza del snapshot. Alterado, de otra llave o
  de otra empresa: rechazado.
- Stock negativo (dos tablets): se avisa, no se borra nada.

## 7. Protocolo de sincronización

`POST functions/v1/pos-sync` con la credencial del **equipo** (`x-wybix-device`).

- **Lote**: hasta 500 eventos en orden de `local_seq` (nunca por hora). Sobre
  con `company_uuid`, `location_uuid` (la nube los compara con la credencial:
  `ENVELOPE_MISMATCH`) y `device_now` (la nube mide el desfase del reloj).
- **Resultado por evento**: `APPLIED`, `DUPLICATE` (mismo `event_uuid`),
  `REJECTED` (con motivo, queda visible en la tablet), `QUARANTINED` (posterior a
  la baja de la tablet: se guarda, no entra a totales).
- **Reintentos**: backoff exponencial 5 s → 15 min con jitter; una sola
  sincronización a la vez; sin red no se pierde nada.
- **Cuándo**: al abrir, al recuperar la red, cada minuto al frente y manual.
  En segundo plano (WorkManager) es una mejora, no un requisito.
- **Maestros**: `mobile_snapshot` (catálogo, personal del evento, caja, llaves,
  versión mínima) e `mobile_inbox` (hechos de otras tablets por cursor).
- **Tablet dada de baja**: puede seguir enviando lo pendiente (lo anterior a la
  baja se acepta; lo posterior queda en cuarentena), pero ya no recibe maestros
  (`DEVICE_REVOKED`).
- **Clon de base**: la huella del servidor SQL (`server_fingerprint`) se compara;
  una base restaurada en otro servidor no sincroniza en silencio hasta que la
  dueña decide (`REBIND` / `NEW_LOCATION`).

## 8. Wybix Owner

- Tablero: cada evento con su estado y “sincronizó hace X” (no se presenta
  como tiempo real).
- Pestaña **Eventos**: crear (nombre + sucursal base), lista con estado, ventas
  de hoy y última sincronización.
- **Detalle**: abrir / cerrar / reabrir / conciliar (con motivo si quedan
  existencias); tablets (código, último contacto, sincronización, pendientes,
  reloj desfasado, dar de baja); personal por evento (No asignado / Cajero /
  Encargado; aviso si no tiene PIN).
- Todo por funciones `owner_*` que validan membresía y rol en la base.

## 9. Pruebas

| Suite | Comando |
|---|---|
| Paquetes (dominio, base local, PIN, QR, motor, cobros, ESC/POS) | `npm test` |
| Nube SQL + E2E I Do Nut + reversa | `npm run test:fase2` |
| Paridad de recetas con SQL Server | `npm run db:test-paridad-recetas` (repo del POS) |
