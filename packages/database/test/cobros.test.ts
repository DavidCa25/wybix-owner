import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarCobro, reconciliarCobro, intentosDe, type ProveedorCobro } from '../src/index.ts';
import { base } from './fixture.ts';

/** Terminal falsa que COBRA de verdad (lleva la cuenta) y deduplica por llave. */
function terminal() {
  const cobros = new Map<string, string>();     // idempotency_key -> estado
  const t = { red: true, cortarDespuesDeCobrar: false, llamadasCrear: 0, rechazar: false,
    get cargos() { return [...cobros.values()].filter((s) => s === 'APPROVED').length; } };
  const prov: ProveedorCobro = {
    nombre: 'TERMINAL_PRUEBA',
    async crear(i) {
      t.llamadasCrear++;
      if (!t.red) throw new TypeError('Network request failed');
      if (!cobros.has(i.idempotency_key)) cobros.set(i.idempotency_key, t.rechazar ? 'REJECTED' : 'APPROVED');
      if (t.cortarDespuesDeCobrar) { t.cortarDespuesDeCobrar = false; throw new TypeError('Network request failed'); }
      return { status: cobros.get(i.idempotency_key) as 'APPROVED', external_id: 'mp-' + i.idempotency_key };
    },
    async consultar(i) {
      if (!t.red) throw new TypeError('offline');
      const s = cobros.get(i.idempotency_key);
      return s ? { status: s as 'APPROVED', external_id: 'mp-' + i.idempotency_key } : { status: 'NOT_FOUND' };
    },
  };
  return { t, prov };
}

test('aprobado y la red se cae justo después: UNKNOWN, se concilia, UN solo cargo', async () => {
  const { db } = await base();
  const { t, prov } = terminal();
  t.cortarDespuesDeCobrar = true;
  const i1 = await iniciarCobro(db, prov, 'venta-1', '95.00');
  assert.equal(i1.status, 'UNKNOWN', 'sin respuesta no es "falló"');
  const i2 = await iniciarCobro(db, prov, 'venta-1', '95.00');   // el cajero vuelve a tocar "Cobrar"
  assert.equal(i2.intent_uuid, i1.intent_uuid, 'retoma el MISMO intento');
  assert.equal(i2.status, 'APPROVED');
  assert.equal(t.cargos, 1, 'el cliente pagó una sola vez');
  assert.equal((await intentosDe(db, 'venta-1')).length, 1);
});

test('sin red al crear: UNKNOWN; al volver la red, el proveedor no lo tenía y se envía con LA MISMA llave', async () => {
  const { db } = await base();
  const { t, prov } = terminal();
  t.red = false;
  const i1 = await iniciarCobro(db, prov, 'venta-2', '50.00');
  assert.equal(i1.status, 'UNKNOWN');
  t.red = true;
  const i2 = await reconciliarCobro(db, prov, i1);
  assert.equal(i2.status, 'APPROVED');
  assert.equal(i2.idempotency_key, i1.idempotency_key);
  assert.equal(t.cargos, 1);
});

test('rechazado: se permite un intento NUEVO con otra llave; aprobado: no se puede cobrar otra vez', async () => {
  const { db } = await base();
  const { t, prov } = terminal();
  t.rechazar = true;
  const r = await iniciarCobro(db, prov, 'venta-3', '20.00');
  assert.equal(r.status, 'REJECTED');
  t.rechazar = false;
  const a = await iniciarCobro(db, prov, 'venta-3', '20.00');
  assert.equal(a.status, 'APPROVED');
  assert.notEqual(a.idempotency_key, r.idempotency_key);
  const otra = await iniciarCobro(db, prov, 'venta-3', '20.00');
  assert.equal(otra.intent_uuid, a.intent_uuid, 'aprobado: devuelve el mismo, no cobra de nuevo');
  assert.equal(t.cargos, 1);
});

test('la base impide dos intentos activos para la misma venta', async () => {
  const { db } = await base();
  await db.run(`INSERT INTO payment_intents (intent_uuid, sale_uuid, provider, amount, idempotency_key, status, created_at, updated_at) VALUES ('a', 'v', 'P', '1', 'k1', 'PENDING', 'x', 'x')`);
  await assert.rejects(db.run(`INSERT INTO payment_intents (intent_uuid, sale_uuid, provider, amount, idempotency_key, status, created_at, updated_at) VALUES ('b', 'v', 'P', '1', 'k2', 'CREATED', 'x', 'x')`), /UNIQUE/);
});
