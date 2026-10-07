import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardarDesfase, desfaseGuardado, pendientes } from '../src/index.ts';
import { base, U, lupita } from './fixture.ts';

/** Reloj de la tablet controlable. Zona del evento: America/Mexico_City (UTC-6). */
function relojDe(iso: string) { let t = Date.parse(iso); return { ahora: () => new Date(t), avanzar: (min: number) => { t += min * 60_000; } }; }
const venta = (pos: any) => pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]);
const eventoDe = async (db: any, tipo: string) => (await pendientes(db, 500, '9999')).filter((e: any) => e.event_type === tipo).map((e: any) => e.payload);

test('una venta que cruza la medianoche es del día de SU turno', async () => {
  const r = relojDe('2026-11-02T05:50:00Z');               // 23:50 del 1 de noviembre en León
  const { db, pos } = await base(':memory:', r.ahora);
  const t = await pos.abrirTurno(lupita, '200');
  assert.equal(t.business_date, '2026-11-01');
  await venta(pos);
  r.avanzar(20);                                           // 00:10 del 2 de noviembre
  await venta(pos);
  const ventas = await eventoDe(db, 'SALE_RECORDED');
  assert.deepEqual(ventas.map((v: any) => v.business_date), ['2026-11-01', '2026-11-01']);
  const filas = await db.all('SELECT business_date FROM sales ORDER BY folio');
  assert.deepEqual(filas.map((f: any) => f.business_date), ['2026-11-01', '2026-11-01']);
});

test('reloj de la tablet atrasado un día: con el desfase medido, el turno nace con la fecha correcta', async () => {
  const r = relojDe('2026-11-01T18:00:00Z');               // la tablet cree que es el 1 (12:00 en León)
  const { db, pos } = await base(':memory:', r.ahora);
  await guardarDesfase(db, 24 * 3600_000);                 // el servidor dijo que en realidad es un día después
  const t = await pos.abrirTurno(lupita, '200');
  assert.equal(t.business_date, '2026-11-02');
  await venta(pos);
  const [v] = await eventoDe(db, 'SALE_RECORDED');
  assert.equal(v.business_date, '2026-11-02');
  // occurred_at sigue siendo la hora cruda de la tablet: la nube la corrige con SU medición.
  assert.equal(v.occurred_at, '2026-11-01T18:00:00.000Z');
});

test('sin red: queda guardado el último desfase medido (con su fecha)', async () => {
  const r = relojDe('2026-11-01T18:00:00Z');
  const { db } = await base(':memory:', r.ahora);
  await guardarDesfase(db, -3 * 3600_000, new Date('2026-10-31T10:00:00Z'));
  const d = await desfaseGuardado(db);
  assert.deepEqual(d, { ms: -10_800_000, at: '2026-10-31T10:00:00.000Z' });
});

test('sin desfase medido todavía, vale la hora de la tablet (como antes)', async () => {
  const r = relojDe('2026-11-02T05:50:00Z');
  const { pos } = await base(':memory:', r.ahora);
  assert.equal((await pos.abrirTurno(lupita, '200')).business_date, '2026-11-01');
});

test('movimientos y corte heredan la fecha del turno', async () => {
  const r = relojDe('2026-11-02T05:50:00Z');
  const { db, pos } = await base(':memory:', r.ahora);
  await pos.abrirTurno(lupita, '200');
  r.avanzar(30);
  await venta(pos);
  const c = await pos.cerrarTurno(lupita, '225');
  const [cierre] = await eventoDe(db, 'SHIFT_CLOSED');
  assert.ok(c.shift_uuid);
  assert.equal(cierre.business_date, '2026-11-01');
});
