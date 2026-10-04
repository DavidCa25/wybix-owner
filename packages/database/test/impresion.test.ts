import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendientes } from '../src/index.ts';
import { base, U, lupita, marta } from './fixture.ts';

async function conVenta() {
  const b = await base();
  await b.pos.abrirTurno(lupita, '200');
  const v = await b.pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 2 }], [{ method: 'EFECTIVO', amount: '50.00', received: '100.00' }]);
  return { ...b, v };
}
const conteo = async (db: any) => ({
  ventas: (await db.get('SELECT COUNT(*) AS n FROM sales')).n,
  pagos: (await db.get('SELECT COUNT(*) AS n FROM payments')).n,
  inventario: (await db.get('SELECT COUNT(*) AS n FROM inventory_movements')).n,
  outbox: (await pendientes(db, 1000, '9999')).length,
  stock: JSON.stringify(await db.all('SELECT product_uuid, qty FROM stock_projection ORDER BY product_uuid')),
});

test('el ticket se reconstruye desde la venta GUARDADA', async () => {
  const { pos, v } = await conVenta();
  const t = await pos.datosTicket(v.sale_uuid);
  assert.equal(t.folio, v.folio);
  assert.equal(t.cajero, 'lupita');
  assert.deepEqual(t.lineas, [{ cantidad: '2', nombre: 'Dona glaseada', subtotal: '50.00' }]);
  assert.deepEqual(t.pagos, [{ metodo: 'EFECTIVO', monto: '100.00' }]);
  assert.equal(t.copia, false);
});

test('falla la impresión: la venta queda, el ticket aparece como pendiente', async () => {
  const { pos, v } = await conVenta();
  await pos.resultadoImpresion(v.sale_uuid, false, 'La impresora no respondió.');
  const sin = await pos.ticketsSinImprimir();
  assert.equal(sin.length, 1);
  assert.equal(sin[0].folio, v.folio);
  assert.equal(sin[0].last_error, 'La impresora no respondió.');
});

test('reimprimir un ticket fallido no crea venta, pago, inventario ni evento; y deja rastro', async () => {
  const { db, pos, v } = await conVenta();
  await pos.resultadoImpresion(v.sale_uuid, false, 'timeout');
  const antes = await conteo(db);
  const r = await pos.registrarReimpresion(lupita, v.sale_uuid, true);
  assert.deepEqual(r, { copia: false, ok: true }, 'el cliente lo recibe por primera vez: no es copia');
  assert.deepEqual(await conteo(db), antes);
  assert.equal((await pos.ticketsSinImprimir()).length, 0);
  const a = await db.get<{ employee_uuid: string; result: string; detail: string }>(`SELECT employee_uuid, result, detail FROM audit_local WHERE action = 'TICKET_REIMPRESO'`);
  assert.ok(a);
  assert.equal(a.employee_uuid, U.lupita);
  assert.equal(a.result, 'OK');
  assert.equal(JSON.parse(a.detail).dispositivo, 'tablet-1');
});

test('reimprimir uno que ya salió es una COPIA; una reimpresión fallida se audita con su error', async () => {
  const { db, pos, v } = await conVenta();
  await pos.resultadoImpresion(v.sale_uuid, true);
  assert.equal((await pos.datosTicket(v.sale_uuid)).copia, true);
  assert.deepEqual(await pos.registrarReimpresion(lupita, v.sale_uuid, true), { copia: true, ok: true });
  await pos.registrarReimpresion(lupita, v.sale_uuid, false, 'papel agotado');
  const fallo = await db.get<{ result: string; detail: string }>(`SELECT result, detail FROM audit_local WHERE action = 'TICKET_REIMPRESO' AND result = 'FAILED'`);
  assert.ok(fallo);
  assert.equal(JSON.parse(fallo.detail).error, 'papel agotado');
  const trabajos = await db.all(`SELECT kind, status FROM print_jobs WHERE sale_uuid = ? ORDER BY id`, [v.sale_uuid]);
  assert.deepEqual(trabajos.map((t: any) => `${t.kind}:${t.status}`), ['TICKET:PRINTED', 'REPRINT:PRINTED', 'REPRINT:FAILED']);
});

test('cambiar la impresora: la cajera necesita autorización de un encargado; queda auditado', async () => {
  const { db, pos } = await base();
  await assert.rejects(pos.configurarImpresora(lupita, { tipo: 'red', host: '192.168.1.50' }), /autorización de un encargado/);
  assert.equal(await db.get(`SELECT v FROM kv WHERE k = 'impresora'`), null);
  await pos.configurarImpresora(lupita, { tipo: 'red', host: '192.168.1.50' }, marta);
  const config = await db.get<{ v: string }>(`SELECT v FROM kv WHERE k = 'impresora'`);
  assert.ok(config);
  assert.deepEqual(JSON.parse(config.v), { tipo: 'red', host: '192.168.1.50' });
  await assert.rejects(pos.configurarImpresora(marta, { tipo: 'red', host: 'no válida; rm -rf' }), /IP/);
  await pos.configurarImpresora(marta, { tipo: 'ninguna' });
  const aud = await db.all<{ employee_uuid: string; detail: string }>(`SELECT employee_uuid, detail FROM audit_local WHERE action = 'IMPRESORA_CONFIGURADA' ORDER BY rowid`);
  assert.equal(aud.length, 2);
  assert.equal(JSON.parse(aud[0].detail).autorizo, U.marta);
});

test('una venta ajena a la tablet no se reimprime', async () => {
  const { pos } = await conVenta();
  await assert.rejects(pos.registrarReimpresion(lupita, 'no-existe', true), /No existe esa venta/);
});
