/**
 * MIGRACIONES DE LA BASE LOCAL DEL POS MOBILE.
 *
 * Versionadas, en orden, cada una dentro de una transacción y registrada en
 * `schema_migrations`. No es "CREATE TABLE IF NOT EXISTS" a ciegas: una
 * tablet con la versión 1 y datos reales sube a la 2 aplicando SOLO la 2.
 * Una migración nunca se edita después de publicarse: se agrega otra.
 *
 * Solo lo que el POS Mobile necesita, no una copia de SQL Server.
 * Los montos y cantidades se guardan como TEXTO decimal exacto (ver
 * @wybix/domain/decimal): SQLite no tiene DECIMAL y REAL perdería centavos.
 */
import type { BaseLocal } from './adaptador.ts';

export interface Migracion { version: number; nombre: string; sql: string; }

export const MIGRACIONES: Migracion[] = [
  {
    version: 1,
    nombre: 'base-pos-mobile',
    sql: `
CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- Snapshot (lo que manda la nube). Reemplazable sin tocar la operación.
CREATE TABLE catalog_versions (
  version      INTEGER PRIMARY KEY,
  received_at  TEXT NOT NULL,
  payload      TEXT NOT NULL
);
CREATE TABLE products (
  uuid TEXT PRIMARY KEY, catalog_version INTEGER NOT NULL, nombre TEXT NOT NULL,
  price TEXT NOT NULL, cost TEXT, inventory_mode TEXT NOT NULL,
  sellable INTEGER NOT NULL, active INTEGER NOT NULL, category_uuid TEXT
);
CREATE TABLE staff (
  uuid TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
  pin_hash TEXT NOT NULL, pin_sal TEXT NOT NULL, pin_algo TEXT NOT NULL,
  active INTEGER NOT NULL, security_revision INTEGER NOT NULL
);
CREATE TABLE pin_attempts (staff_uuid TEXT PRIMARY KEY, failures INTEGER NOT NULL, locked_until TEXT);
CREATE TABLE payment_methods (code TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL, sort INTEGER NOT NULL);
CREATE TABLE trusted_keys (key_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, location_uuid TEXT, label TEXT);

-- Operación (la autoridad durante el evento).
CREATE TABLE shifts (
  uuid TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  register_uuid TEXT NOT NULL,
  employee_uuid TEXT NOT NULL,
  business_date TEXT NOT NULL,
  opening_cash TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by_uuid TEXT,
  authorized_by_uuid TEXT,
  expected TEXT, counted TEXT, difference TEXT,
  blind INTEGER
);
CREATE UNIQUE INDEX ux_shifts_open ON shifts (register_uuid) WHERE status = 'OPEN';

CREATE TABLE sales (
  uuid TEXT PRIMARY KEY,
  folio TEXT NOT NULL UNIQUE,
  shift_uuid TEXT NOT NULL REFERENCES shifts (uuid),
  employee_uuid TEXT NOT NULL,
  catalog_version INTEGER NOT NULL,
  total TEXT NOT NULL,
  cash_net TEXT NOT NULL,
  change TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'RETURNED')),
  business_date TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  invoice_requested INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sale_lines (
  sale_uuid TEXT NOT NULL REFERENCES sales (uuid),
  line_no INTEGER NOT NULL,
  product_uuid TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity TEXT NOT NULL,
  unit_price TEXT NOT NULL,
  subtotal TEXT NOT NULL,
  unit_cost TEXT NOT NULL,
  inventory_mode TEXT NOT NULL,
  recipe_uuid TEXT,
  variant_option_uuid TEXT,
  scale TEXT NOT NULL,
  modifiers TEXT NOT NULL,
  consumos TEXT NOT NULL,
  PRIMARY KEY (sale_uuid, line_no)
);
CREATE TABLE payments (
  sale_uuid TEXT NOT NULL REFERENCES sales (uuid),
  seq INTEGER NOT NULL,
  method TEXT NOT NULL,
  amount TEXT NOT NULL,
  received TEXT,
  change TEXT NOT NULL,
  reference TEXT,
  PRIMARY KEY (sale_uuid, seq)
);
CREATE TABLE inventory_movements (
  uuid TEXT PRIMARY KEY,
  product_uuid TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('TRANSFER_IN','SALE','SALE_RETURN','CONSUMPTION','WASTE','ADJUSTMENT','RETURN_TRANSFER_OUT')),
  quantity TEXT NOT NULL,
  ref_type TEXT, ref_uuid TEXT,
  employee_uuid TEXT,
  authorized_by_uuid TEXT,
  reason TEXT,
  occurred_at TEXT NOT NULL,
  origin_device TEXT NOT NULL
);
CREATE INDEX ix_inv_product ON inventory_movements (product_uuid);
CREATE TABLE cash_movements (
  uuid TEXT PRIMARY KEY,
  shift_uuid TEXT NOT NULL REFERENCES shifts (uuid),
  type TEXT NOT NULL CHECK (type IN ('OPENING','SALE_CASH','CASH_IN','CASH_OUT','EXPENSE','SALE_RETURN_CASH')),
  amount TEXT NOT NULL,
  reason TEXT,
  ref_uuid TEXT,
  employee_uuid TEXT NOT NULL,
  authorized_by_uuid TEXT,
  occurred_at TEXT NOT NULL
);
CREATE TABLE transfers (
  uuid TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('IN', 'RETURN_OUT')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RECEIVED', 'SENT')),
  source TEXT NOT NULL CHECK (source IN ('SNAPSHOT', 'QR', 'LOCAL')),
  from_location_uuid TEXT, to_location_uuid TEXT,
  manifest TEXT, signature TEXT,
  employee_uuid TEXT,
  created_at TEXT NOT NULL,
  received_at TEXT
);
CREATE TABLE transfer_lines (
  transfer_uuid TEXT NOT NULL REFERENCES transfers (uuid),
  product_uuid TEXT NOT NULL,
  product_name TEXT,
  qty_sent TEXT NOT NULL,
  qty_received TEXT,
  PRIMARY KEY (transfer_uuid, product_uuid)
);

-- Proyecciones: derivadas, se pueden reconstruir de los hechos.
CREATE TABLE stock_projection (product_uuid TEXT PRIMARY KEY, qty TEXT NOT NULL);

-- Sincronización.
CREATE TABLE outbox (
  local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uuid TEXT NOT NULL UNIQUE,
  aggregate_type TEXT NOT NULL,
  aggregate_uuid TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'REJECTED', 'QUARANTINED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  sent_at TEXT
);
CREATE INDEX ix_outbox_status ON outbox (status, local_seq);
CREATE TABLE inbox (
  event_uuid TEXT PRIMARY KEY,
  origin_device TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE audit_local (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  employee_uuid TEXT,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT
);
`,
  },
  {
    version: 2,
    nombre: 'cobros-con-terminal-e-impresion',
    sql: `
-- Spike 2.5: un cobro con terminal (Mercado Pago) es una INTENCIÓN con
-- idempotencia propia, persistida ANTES de pedirle nada al proveedor.
CREATE TABLE payment_intents (
  intent_uuid TEXT PRIMARY KEY,
  sale_uuid TEXT NOT NULL,
  provider TEXT NOT NULL,
  amount TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('CREATED','PENDING','APPROVED','REJECTED','CANCELLED','UNKNOWN')),
  external_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_payment_intents_activa ON payment_intents (sale_uuid)
  WHERE status IN ('CREATED', 'PENDING', 'UNKNOWN', 'APPROVED');

-- Spike 2.2: la impresión es un efecto posterior; su fallo no toca la venta.
CREATE TABLE print_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_uuid TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PRINTED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);
ALTER TABLE sales ADD COLUMN printed INTEGER NOT NULL DEFAULT 0;
`,
  },
  {version:3,nombre:'precios-promociones-combos',sql:`ALTER TABLE sales ADD COLUMN commercial_snapshot TEXT;ALTER TABLE sale_lines ADD COLUMN commercial_snapshot TEXT;`},
];

export async function versionActual(db: BaseLocal): Promise<number> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, nombre TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const r = await db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations');
  return Number(r?.v ?? 0);
}

/** Aplica las migraciones pendientes, cada una en su transacción. */
export async function migrar(db: BaseLocal, lista: Migracion[] = MIGRACIONES, ahora = () => new Date().toISOString()): Promise<{ desde: number; hasta: number; aplicadas: number[] }> {
  const desde = await versionActual(db);
  const ordenadas = [...lista].sort((a, b) => a.version - b.version);
  for (let i = 1; i < ordenadas.length; i++) {
    if (ordenadas[i].version !== ordenadas[i - 1].version + 1) throw new Error('Las migraciones deben ser consecutivas.');
  }
  const aplicadas: number[] = [];
  for (const m of ordenadas.filter((x) => x.version > desde)) {
    await db.transaccion(async (tx) => {
      await tx.exec(m.sql);
      await tx.run('INSERT INTO schema_migrations (version, nombre, applied_at) VALUES (?, ?, ?)', [m.version, m.nombre, ahora()]);
    });
    aplicadas.push(m.version);
  }
  return { desde, hasta: await versionActual(db), aplicadas };
}
