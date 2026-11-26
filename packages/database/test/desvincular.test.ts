import { test } from 'node:test';
import assert from 'node:assert/strict';
import { borrarDatosLocales, estadoDesvincular, versionActual, MIGRACIONES } from '../src/index.ts';
import { base, U, lupita } from './fixture.ts';

test('desvincular: con turno abierto no borra nada', async () => {
  const b = await base();
  await b.pos.abrirTurno(lupita, '500');
  await assert.rejects(borrarDatosLocales(b.db), { code: 'DESVINCULAR_TURNO' });
  assert.ok((await b.db.get<any>(`SELECT count(*) AS n FROM products`)).n > 0);
});

test('desvincular: con ventas sin enviar no borra nada', async () => {
  const b = await base();
  await b.pos.abrirTurno(lupita, '500');
  await b.pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]);
  await b.db.run(`UPDATE shifts SET status = 'CLOSED'`);
  const e = await estadoDesvincular(b.db);
  assert.equal(e.turnoAbierto, false);
  assert.ok(e.pendientes > 0);
  await assert.rejects(borrarDatosLocales(b.db), { code: 'DESVINCULAR_PENDIENTES' });
});

test('desvincular: todo enviado deja la base vacía con su esquema', async () => {
  const b = await base();
  await b.pos.abrirTurno(lupita, '500');
  await b.pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]);
  await b.db.run(`UPDATE shifts SET status = 'CLOSED'`);
  await b.db.run(`UPDATE outbox SET status = 'SENT'`);
  await borrarDatosLocales(b.db);
  for (const t of ['kv', 'products', 'staff', 'sales', 'shifts', 'outbox']) {
    assert.equal((await b.db.get<any>(`SELECT count(*) AS n FROM ${t}`)).n, 0, t);
  }
  assert.equal(await versionActual(b.db), MIGRACIONES.length, 'el esquema sigue migrado');
  assert.deepEqual(await estadoDesvincular(b.db), { pendientes: 0, enRevision: 0, turnoAbierto: false });
});

test('desvincular: forzar (tablet dada de baja) borra aunque haya pendientes', async () => {
  const b = await base();
  await b.pos.abrirTurno(lupita, '500');
  await borrarDatosLocales(b.db, { forzar: true });
  assert.equal((await b.db.get<any>(`SELECT count(*) AS n FROM shifts`)).n, 0);
});
