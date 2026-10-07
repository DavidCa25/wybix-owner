import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { adaptadorNode, migrar, versionActual, MIGRACIONES, crearPos, aplicarSnapshot, identificar, pendientes, aplicarResultados, resumen, aplicarInbox } from '../src/index.ts';
import { base, snapshot, catalogo, U, PIN, lupita, marta } from './fixture.ts';

const stockDe = async (pos: any, u: string) => (await pos.stock()).find((s: any) => s.product_uuid === u)?.qty ?? '0';

test('migraciones: instalación limpia y re-ejecución sin efecto', async () => {
  const db = adaptadorNode(new DatabaseSync(':memory:'));
  const r = await migrar(db);
  assert.deepEqual(r.aplicadas, [1, 2, 3]);
  assert.equal(await versionActual(db), MIGRACIONES.length);
  assert.deepEqual((await migrar(db)).aplicadas, [], 'correr otra vez no aplica nada');
});

test('migraciones: una tablet en v1 CON datos sube a v2 sin perderlos', async () => {
  const db = adaptadorNode(new DatabaseSync(':memory:'));
  await migrar(db, MIGRACIONES.slice(0, 1));
  await db.run(`INSERT INTO kv (k, v) VALUES ('dato', 'conservado')`);
  await db.run(`INSERT INTO shifts (uuid, status, register_uuid, employee_uuid, business_date, opening_cash, opened_at) VALUES ('s1', 'OPEN', 'r', 'e', '2026-11-01', '500.00', '2026-11-01T10:00:00Z')`);
  await db.run(`INSERT INTO sales (uuid, folio, shift_uuid, employee_uuid, catalog_version, total, cash_net, change, status, business_date, occurred_at) VALUES ('v1', 'F1-000001', 's1', 'e', 1, '25.00', '25.00', '0.00', 'COMPLETED', '2026-11-01', 'x')`);
  const r = await migrar(db);
  assert.deepEqual(r, { desde: 1, hasta: 3, aplicadas: [2, 3] });
  assert.equal((await db.get<any>(`SELECT v FROM kv WHERE k = 'dato'`)).v, 'conservado');
  assert.equal((await db.get<any>(`SELECT printed FROM sales WHERE uuid = 'v1'`)).printed, 0, 'la columna nueva llega con su default');
});

test('una migración que falla no deja la base a medias', async () => {
  const db = adaptadorNode(new DatabaseSync(':memory:'));
  await migrar(db, MIGRACIONES.slice(0, 1));
  await assert.rejects(migrar(db, [...MIGRACIONES.slice(0, 1), { version: 2, nombre: 'rota', sql: 'CREATE TABLE ok_t (x INT); CREATE TABLE ok_t (y INT);' }]));
  assert.equal(await versionActual(db), 1);
  assert.equal(await db.get(`SELECT 1 FROM sqlite_master WHERE name = 'ok_t'`), null);
});

test('FERIA COMPLETA SIN INTERNET: recibir 40, vender 32, merma, corte, regresar 8', async () => {
  const { pos, db } = await base();
  const rec = await pos.recibirTransferencia(marta, U.transfer, {});
  assert.equal(rec.ya_recibida, false);
  assert.equal(await stockDe(pos, U.dona), '40');
  await pos.abrirTurno(lupita, '500');
  // 31 donas en efectivo (en varias ventas) + 1 con tarjeta = 32
  let folio = '';
  for (let i = 0; i < 6; i++) folio = (await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 5 }], [{ method: 'EFECTIVO', amount: '125.00', received: '200.00' }])).folio;
  await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]);
  await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }, { product_uuid: U.cafe, quantity: 2 }], [{ method: 'TARJETA', amount: '95.00' }]);
  assert.equal(folio, 'F1-000006');
  assert.equal(await stockDe(pos, U.dona), '8', '40 - 32');
  assert.equal(await stockDe(pos, U.grano), '964', 'café: 2 x 18 g de grano consumidos');
  // merma: el cajero no puede; con la encargada sí
  await assert.rejects(pos.registrarMerma(lupita, U.leche, '100', 'Se cortó'), /autorización de un encargado/);
  await pos.registrarMerma(lupita, U.leche, '100', 'Se cortó', marta);
  assert.equal(await stockDe(pos, U.leche), '4500', '5000 - 400 café - 100 merma');
  // corte: a ciegas para la cajera; el esperado solo cuenta efectivo
  const res = await pos.resumenTurno(lupita);
  assert.equal(res!.esperado, null);
  assert.equal(res!.tickets, 8);
  assert.equal(res!.ventas, null, 'a ciegas no ve importes: efectivo vendido + fondo = esperado');
  assert.deepEqual(res!.por_metodo, {});
  const enc = await pos.resumenTurno(marta);
  assert.equal(enc!.ventas, '870.00');   // 6 x 125 + 25 + 95
  assert.equal(enc!.por_metodo.TARJETA, '95.00');
  assert.equal(enc!.esperado, '1275.00');
  const c = await pos.cerrarTurno(lupita, '1270');
  assert.deepEqual(c, { shift_uuid: c.shift_uuid, counted: '1270.00', ciego: true });
  const sh = await db.get<any>('SELECT expected, difference FROM shifts WHERE uuid = ?', [c.shift_uuid]);
  assert.deepEqual([sh.expected, sh.difference], ['1275.00', '-5.00'], '500 + 775 efectivo; tarjeta no entra al cajón');
  // regreso del sobrante
  const ret = await pos.regresarSobrante(marta, [{ product_uuid: U.dona, quantity: '8' }]);
  assert.equal(ret.lineas.length, 1);
  assert.equal(await stockDe(pos, U.dona), '0');
  // outbox: un evento por hecho, en orden
  const evs = await pendientes(db, 100, '9999');
  assert.deepEqual([...new Set(evs.map((e) => e.event_type))].sort(),
    ['INVENTORY_MOVEMENT_RECORDED', 'RETURN_SENT', 'SALE_RECORDED', 'SHIFT_CLOSED', 'SHIFT_OPENED', 'TRANSFER_RECEIVED']);
  assert.ok(evs.every((e, i) => i === 0 || e.local_seq > evs[i - 1].local_seq));
  // recibir la misma transferencia otra vez no suma
  assert.equal((await pos.recibirTransferencia(marta, U.transfer, {})).ya_recibida, true);
});

test('una venta es todo o nada: si algo falla no queda nada a medias', async () => {
  const { pos, db } = await base();
  await pos.recibirTransferencia(marta, U.transfer, {});
  await pos.abrirTurno(lupita, '0');
  const antes = await db.get<any>('SELECT (SELECT COUNT(*) FROM sales) s, (SELECT COUNT(*) FROM outbox) o, (SELECT COUNT(*) FROM inventory_movements) m');
  await assert.rejects(pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'TARJETA', amount: '20.00' }]), /suman 20.00/);
  // falla a la mitad: la tabla de pagos rechaza el insert (se fuerza con un trigger)
  await db.exec(`CREATE TRIGGER romper BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT, 'disco lleno'); END;`);
  await assert.rejects(pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]), /disco lleno/);
  await db.exec('DROP TRIGGER romper');
  const despues = await db.get<any>('SELECT (SELECT COUNT(*) FROM sales) s, (SELECT COUNT(*) FROM outbox) o, (SELECT COUNT(*) FROM inventory_movements) m');
  assert.deepEqual(despues, antes);
  assert.equal(await stockDe(pos, U.dona), '40');
  assert.equal((await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }])).folio, 'F1-000001', 'el folio tampoco se consumió');
});

test('matar la app: el turno, las ventas y el outbox siguen al reabrir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-pos-'));
  const archivo = join(dir, 'pos.db');
  try {
    const a = await base(archivo);
    await a.pos.recibirTransferencia(marta, U.transfer, {});
    const t = await a.pos.abrirTurno(lupita, '300');
    await a.pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 2 }], [{ method: 'EFECTIVO', amount: '50.00' }]);
    a.raw.close();   // "kill": se cierra la base sin más
    const raw = new DatabaseSync(archivo);
    const db = adaptadorNode(raw);
    await migrar(db);
    const pos = crearPos(db);
    assert.equal((await pos.turnoActual())!.uuid, t.shift_uuid);
    assert.equal(await stockDe(pos, U.dona), '38');
    assert.equal((await resumen(db)).pendientes, 3, 'recepción + apertura + venta');
    await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]);
    assert.equal((await db.get<any>('SELECT MAX(folio) f FROM sales')).f, 'F1-000002', 'la numeración continúa');
    raw.close();
  } finally { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows suelta el archivo después */ } }
});

test('catálogo N -> N+1: lo vendido con N se queda con N; producto desactivado deja de venderse', async () => {
  const { pos, db } = await base();
  await pos.recibirTransferencia(marta, U.transfer, {});
  await pos.abrirTurno(lupita, '0');
  const v1 = await pos.registrarVenta(lupita, [{ product_uuid: U.vieja, quantity: 1 }], [{ method: 'EFECTIVO', amount: '30.00' }]);
  await aplicarSnapshot(db, snapshot({ snapshot_version: 2, catalog: catalogo(2, { precioDona: '28.00', desactivarVieja: true }) }));
  const v2 = await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '28.00' }]);
  assert.deepEqual([v1.catalog_version, v2.catalog_version], [1, 2]);
  assert.equal((await db.get<any>('SELECT unit_price FROM sale_lines WHERE sale_uuid = ?', [v1.sale_uuid])).unit_price, '30.00', 'no se recalcula');
  await assert.rejects(pos.registrarVenta(lupita, [{ product_uuid: U.vieja, quantity: 1 }], [{ method: 'EFECTIVO', amount: '30.00' }]), /ya no está a la venta/);
  await aplicarSnapshot(db, snapshot({ snapshot_version: 3, catalog: catalogo(1) }));
  assert.equal((await db.get<any>(`SELECT v FROM kv WHERE k = 'catalog_version'`)).v, '2', 'un catálogo viejo no baja la versión');
});

test('snapshot de otra empresa u otro evento: rechazado completo', async () => {
  const { db } = await base();
  await assert.rejects(aplicarSnapshot(db, snapshot({ company: '99999999-9999-4999-8999-999999999999' })), /otra empresa/);
  await assert.rejects(aplicarSnapshot(db, snapshot({ location: '88888888-8888-4888-8888-888888888888' })), /otro evento/);
});

test('PIN offline: correcto, incorrecto, bloqueo y auditoría sin el PIN', async () => {
  const { db } = await base();
  const ok = await identificar(db, U.lupita, PIN.lupita);
  assert.equal(ok.ok && ok.persona.role, 'CASHIER');
  for (let i = 0; i < 5; i++) await identificar(db, U.lupita, '9137');
  const b = await identificar(db, U.lupita, PIN.lupita);
  assert.equal(b.ok, false);
  assert.equal((b as any).bloqueado, true);
  const aud = JSON.stringify(await db.all('SELECT * FROM audit_local'));
  assert.ok(!aud.includes(PIN.lupita) && !aud.includes('9137'), 'la auditoría no guarda el PIN');
});

test('permisos locales: el cajero no hace ajustes ni recibe mercancía sin encargado', async () => {
  const { pos } = await base();
  await assert.rejects(pos.recibirTransferencia(lupita, U.transfer, {}), /encargado/);
  await assert.rejects(pos.registrarAjuste(lupita, U.dona, '5', 'conteo'), /encargado/);
  await pos.recibirTransferencia(lupita, U.transfer, { [U.dona]: '39' }, marta);
  assert.equal(await stockDe(pos, U.dona), '39', 'se registra lo recibido (39 de 40), no lo enviado');
  await assert.rejects(pos.registrarAjuste(marta, U.dona, '0', 'x'), /no puede ser cero/);
});

test('tablet revocada: no abre turno ni vende, pero conserva lo pendiente', async () => {
  const { pos, db } = await base();
  await pos.recibirTransferencia(marta, U.transfer, {});
  await db.run(`INSERT INTO kv (k, v) VALUES ('device_status', 'REVOKED')`);
  await assert.rejects(pos.abrirTurno(lupita, '0'), /dada de baja/);
  assert.equal((await resumen(db)).pendientes, 1);
});

test('evento cerrado por la dueña: la tablet ya no abre turnos nuevos', async () => {
  const { pos, db } = await base();
  const loc = JSON.parse((await db.get<{ v: string }>(`SELECT v FROM kv WHERE k = 'location'`))!.v);
  for (const estado of ['CLOSED', 'RECONCILED']) {
    await db.run(`UPDATE kv SET v = ? WHERE k = 'location'`, [JSON.stringify({ ...loc, event_status: estado })]);
    await assert.rejects(pos.abrirTurno(lupita, '0'), /evento ya cerró/);
  }
  await db.run(`UPDATE kv SET v = ? WHERE k = 'location'`, [JSON.stringify({ ...loc, event_status: 'OPEN' })]);
  assert.ok((await pos.abrirTurno(lupita, '0')).shift_uuid, 'abierto de nuevo, vuelve a operar');
});

test('reloj de la tablet mal puesto: el orden lo da local_seq, no la hora', async () => {
  let t = new Date('2026-11-01T12:00:00Z');
  const { pos, db } = await base(':memory:', () => t);
  await pos.recibirTransferencia(marta, U.transfer, {});
  await pos.abrirTurno(lupita, '0');
  await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]);
  t = new Date('2020-01-01T00:00:00Z');   // alguien movió el reloj al pasado
  await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]);
  const evs = await pendientes(db, 100, '9999');
  const ventas = evs.filter((e) => e.event_type === 'SALE_RECORDED');
  assert.ok(ventas[1].local_seq > ventas[0].local_seq && ventas[1].occurred_at < ventas[0].occurred_at);
  assert.equal(new Set(evs.map((e) => e.event_uuid)).size, evs.length, 'UUID únicos aunque el reloj retroceda');
});

test('resultados de sync: aplicados salen, rechazados quedan visibles, errores se reprograman', async () => {
  const { pos, db } = await base();
  await pos.recibirTransferencia(marta, U.transfer, {});
  await pos.abrirTurno(lupita, '0');
  const evs = await pendientes(db, 10, '9999');
  await aplicarResultados(db, [
    { event_uuid: evs[0].event_uuid, result: 'APPLIED' },
    { event_uuid: evs[1].event_uuid, result: 'ERROR', error: 'timeout' },
  ], new Date().toISOString(), () => '2999-01-01T00:00:00Z');
  const r = await resumen(db);
  assert.deepEqual([r.pendientes, r.enviados], [1, 1]);
  assert.equal((await pendientes(db, 10, new Date().toISOString())).length, 0, 'el que falló espera su reintento');
  await aplicarResultados(db, [{ event_uuid: evs[1].event_uuid, result: 'REJECTED', error: 'no' }], new Date().toISOString(), () => 'x');
  assert.equal((await resumen(db)).rechazados, 1);
});

test('dos tablets: la venta de la otra baja el stock local; si queda negativo se avisa, no se borra nada', async () => {
  const { pos, db } = await base();
  await pos.recibirTransferencia(marta, U.transfer, {});
  const r = await aplicarInbox(db, [{ event_uuid: 'e-otra-1', origin_device: 'tablet-2', aggregate_type: 'SALE',
    payload: { movements: [{ uuid: 'm-otra-1', product_uuid: U.dona, type: 'SALE', quantity: '45.00' }] } }], 'tablet-1', new Date().toISOString());
  assert.equal(await stockDe(pos, U.dona), '-5');
  assert.equal(r.negativos.length, 1);
  assert.equal((await aplicarInbox(db, [{ event_uuid: 'e-otra-1', origin_device: 'tablet-2', aggregate_type: 'SALE', payload: {} }], 'tablet-1', 'x')).aplicados, 0, 'una sola vez');
});

test('la proyección de stock se reconstruye de los hechos', async () => {
  const { pos, db } = await base();
  await pos.recibirTransferencia(marta, U.transfer, {});
  await pos.abrirTurno(lupita, '0');
  await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 3 }], [{ method: 'EFECTIVO', amount: '75.00' }]);
  await db.run(`UPDATE stock_projection SET qty = '999'`);   // proyección corrupta
  await pos.reconstruirProyecciones();
  assert.equal(await stockDe(pos, U.dona), '37');
});
