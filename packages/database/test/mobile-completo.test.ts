/**
 * POS MOBILE COMPLETO (auditoría 2026-11-24): paquetes y códigos, buscar sin
 * acentos, cobro dividido, devoluciones y sincronización rápida.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexar, indiceDeVenta, buscarEntradas, porCodigo, normalizar, Dec } from '@wybix/domain';
import { crearSincronizador } from '@wybix/sync';
import { aplicarSnapshot, resumen } from '../src/index.ts';
import { base, catalogo, snapshot, U, lupita, marta } from './fixture.ts';

/** El catálogo de la feria con la caja de 6 donas y códigos de barras. */
function catalogoConPaquetes(version = 2) {
  const c = catalogo(version);
  const dona = c.products.find((p) => p.uuid === U.dona)! as any;
  dona.bar_code = '7500000000011';
  dona.part_number = 'DONA-GLA';
  dona.presentations = [
    { id: '12', name: 'Caja 12', factor: 12, sale_price: '250.00', bar_code: '7500000000127' },
    { id: '6', name: 'Caja 6', factor: 6, sale_price: '130.00', bar_code: '7500000000066' },
  ];
  return c;
}

async function feria() {
  const b = await base();
  await aplicarSnapshot(b.db, snapshot({ snapshot_version: 2, catalog: catalogoConPaquetes() as any }));
  await b.pos.recibirTransferencia(marta, U.transfer, {});
  await b.pos.abrirTurno(lupita, '500');
  return b;
}

test('buscar: sin acentos, por clave y por código; los paquetes de menor a mayor', () => {
  const ix = indexar(catalogoConPaquetes() as any);
  const indice = indiceDeVenta(ix);
  assert.equal(normalizar('  Café   de OLLA '), 'cafe de olla');
  assert.deepEqual(buscarEntradas(indice, 'cafe').map((e) => e.nombre), ['Café de olla']);
  assert.deepEqual(buscarEntradas(indice, 'dona glaseada caja').map((e) => e.nombre), ['Dona glaseada · Caja 6', 'Dona glaseada · Caja 12']);
  assert.equal(buscarEntradas(indice, 'dona-gla')[0].product_uuid, U.dona, 'por clave');
  assert.equal(buscarEntradas(indice, '7500000000066')[0].presentation_id, '6', 'el código exacto va primero');
  assert.deepEqual(porCodigo(ix, '7500000000127'), { product_uuid: U.dona, presentation_id: '12', piezas: 12 });
  assert.deepEqual(porCodigo(ix, '7500000000011'), { product_uuid: U.dona, presentation_id: null, piezas: 1 });
  assert.equal(porCodigo(ix, '0000'), null);
});

test('paquete: cobra su precio entero, descuenta sus piezas y no acepta piezas sueltas', async () => {
  const { pos } = await feria();
  const q = await pos.cotizarVenta([{ product_uuid: U.dona, quantity: 12, presentation_id: '6' }, { product_uuid: U.dona, quantity: 1 }]);
  assert.equal(q.total, '285.00', '2 cajas de 6 a $130 + 1 dona a $25');
  await assert.rejects(pos.cotizarVenta([{ product_uuid: U.dona, quantity: 5, presentation_id: '6' }]), /se vende completo/);
  await assert.rejects(pos.cotizarVenta([{ product_uuid: U.dona, quantity: 6, presentation_id: '99' }]), /ya no está a la venta/);
  const v = await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 6, presentation_id: '6' }], [{ method: 'EFECTIVO', amount: '130.00' }]);
  assert.equal(v.total, '130.00');
  assert.equal((await pos.stock()).find((s) => s.product_uuid === U.dona)?.qty, '34', 'salen 6 donas de 40');
  const d = await pos.detalleVenta(v.sale_uuid);
  assert.ok(d!.lineas.every((l) => l.presentation_id === '6'), 'el renglón recuerda el paquete');
});

test('cobro dividido: efectivo y tarjeta en una venta', async () => {
  const { pos } = await feria();
  const v = await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 4 }],
    [{ method: 'TARJETA', amount: '60.00' }, { method: 'EFECTIVO', amount: '40.00', received: '50.00' }]);
  assert.equal(v.total, '100.00');
  assert.equal(v.cambio, '10.00');
  const ventas = await pos.ventasDelTurno();
  assert.equal(ventas[0].metodo, 'MIXTO');
});

test('devolución: parcial y luego completa; inventario, cajón y nube cuadran', async () => {
  const { pos, db } = await feria();
  const v = await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 3 }], [{ method: 'EFECTIVO', amount: '75.00' }]);
  await assert.rejects(pos.devolverVenta(lupita, v.sale_uuid, [{ line_no: 1, quantity: 1 }], 'venía aplastada'), /autorización de un encargado/);
  const r1 = await pos.devolverVenta(lupita, v.sale_uuid, [{ line_no: 1, quantity: 1 }], 'venía aplastada', marta);
  assert.deepEqual(r1, { importe: '25.00', refunded_total: '25.00', completa: false });
  assert.equal((await pos.stock()).find((s) => s.product_uuid === U.dona)?.qty, '38', '40 - 3 + 1');
  await assert.rejects(pos.devolverVenta(marta, v.sale_uuid, [{ line_no: 1, quantity: 3 }], 'otra vez'), /solo quedan 2/);
  const r2 = await pos.devolverVenta(marta, v.sale_uuid, [{ line_no: 1, quantity: 2 }], 'el cliente se arrepintió');
  assert.deepEqual(r2, { importe: '50.00', refunded_total: '75.00', completa: true });
  await assert.rejects(pos.devolverVenta(marta, v.sale_uuid, [{ line_no: 1, quantity: 1 }], 'x'), /ya se devolvió completa/);
  const caja = await db.all<{ type: string; amount: string }>(`SELECT type, amount FROM cash_movements WHERE type = 'SALE_RETURN_CASH'`);
  assert.deepEqual(caja.map((c) => c.amount), ['25.00', '50.00']);
  // La nube recibe la venta reemitida (misma hora del hecho) con su devuelto.
  const evs = await db.all<{ payload: string; occurred_at: string }>(`SELECT payload, occurred_at FROM outbox WHERE event_type = 'SALE_REFUNDED' ORDER BY local_seq`);
  assert.equal(evs.length, 2);
  const ultimo = JSON.parse(evs[1].payload);
  assert.equal(ultimo.refunded_total, '75.00');
  assert.equal(ultimo.movements[0].type, 'SALE_RETURN');
  const venta = await db.get<{ occurred_at: string }>('SELECT occurred_at FROM sales WHERE uuid = ?', [v.sale_uuid]);
  assert.equal(evs[1].occurred_at, venta!.occurred_at);
  assert.equal((await pos.ventasDelTurno())[0].status, 'RETURNED');
});

/** Nube que cuenta lo que se le pide y solo manda catálogo si la tablet no lo tiene. */
function nubeContadora() {
  const n = {
    eventos: 0, snapshots: 0, bandejas: 0, catalogosMandados: 0, latidos: [] as any[],
    async enviarEventos(l: any) { n.eventos++; return { results: l.events.map((e: any) => ({ event_uuid: e.event_uuid, result: 'APPLIED' })) }; },
    async snapshot(desde: any) {
      n.snapshots++;
      const manda = !(desde.catalog_version >= 2);
      if (manda) n.catalogosMandados++;
      const s: any = snapshot({ snapshot_version: 3, catalog: catalogoConPaquetes() as any });
      if (!manda) { s.catalog = null; s.staff = desde.security_revision >= 1 ? null : s.staff; }
      return s;
    },
    async inbox(c: number) { n.bandejas++; return { events: [], cursor: c }; },
    async latido(info: any) { n.latidos.push(info); },
  };
  return n;
}

test('sincronización rápida: después de vender solo sube; el catálogo no vuelve a bajar', async () => {
  const { db, pos } = await feria();
  const nube = nubeContadora();
  let ahora = new Date('2026-11-05T12:00:00Z');
  const s = crearSincronizador({ db, nube, dispositivo: async () => 'tablet-1', version: '0.4.0', reloj: () => ahora });
  await s.sincronizar(true);                 // completo: snapshot, pero la tablet ya tiene la v2
  assert.equal(nube.snapshots, 1);
  assert.equal(nube.catalogosMandados, 0, 'la nube no reenvía un catálogo que la tablet ya tiene');
  assert.equal(nube.latidos[0].stats.catalogo, 'sin_cambios');
  await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]);
  ahora = new Date('2026-11-05T12:01:00Z');
  const e = await s.sincronizar(true, 'rapido');
  assert.equal(e.pendientes, 0, 'la venta subió');
  assert.equal(nube.snapshots, 1, 'el ciclo rápido no pidió snapshot');
  assert.equal(nube.bandejas, 1, 'ni bajó lo de otras tablets');
  const m = await s.metricas();
  assert.equal(m!.modo, 'rapido');
  assert.equal(m!.enviados, 1);
  // Pasados 5 minutos, el ciclo rápido se vuelve completo.
  ahora = new Date('2026-11-05T12:07:00Z');
  await s.sincronizar(true, 'rapido');
  assert.equal(nube.snapshots, 2);
  assert.equal((await resumen(db)).pendientes, 0);
});

test('decimal: dividir reparte en proporción con redondeo de SQL Server', () => {
  assert.equal(Dec.de('100.00').dividir('3', 2).fijo(2), '33.33');
  assert.equal(Dec.de('2').dividir('3', 2).fijo(2), '0.67');
  assert.equal(Dec.de('75.00').por('1').dividir('3').redondear(2).fijo(2), '25.00');
});

test('conteo: solo las diferencias se ajustan, todo o nada, y es de encargado', async () => {
  const { pos, db } = await feria();
  await assert.rejects(pos.aplicarConteo(lupita, [{ product_uuid: U.dona, contado: 38 }], 'pasillo 1'), /autorización de un encargado/);
  const r = await pos.aplicarConteo(lupita, [{ product_uuid: U.dona, contado: 38 }, { product_uuid: U.leche, contado: '5000' }], 'pasillo 1', marta);
  assert.deepEqual(r.ajustes, [{ product_uuid: U.dona, antes: '40', contado: '38', diferencia: '-2' }], 'la leche cuadró: sin ajuste');
  assert.equal((await pos.stock()).find((s) => s.product_uuid === U.dona)?.qty, '38');
  await assert.rejects(pos.aplicarConteo(marta, [{ product_uuid: U.dona, contado: 30 }, { product_uuid: 'no-existe', contado: 1 }], 'x'), /no está en el catálogo/);
  assert.equal((await pos.stock()).find((s) => s.product_uuid === U.dona)?.qty, '38', 'un error no deja el conteo a medias');
  const evs = await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox WHERE event_type = 'INVENTORY_MOVEMENT_RECORDED'`);
  assert.equal(Number(evs[0].n), 1);
});

test('caja de sucursal: el snapshot es de sucursal, la existencia la manda la base y lo no subido se descuenta', async () => {
  const { adaptadorNode, migrar, guardarEnrolamiento, crearPos, modoDeOperacion } = await import('../src/index.ts');
  const { DatabaseSync } = await import('node:sqlite');
  const db = adaptadorNode(new DatabaseSync(':memory:'));
  await migrar(db);
  await guardarEnrolamiento(db, { device_uuid: 'tablet-s', device_id: 'dev-s', modo: 'SUCURSAL', local_host: 'http://192.168.1.20:7427' });
  assert.deepEqual(await modoDeOperacion(db), { modo: 'SUCURSAL', local_host: 'http://192.168.1.20:7427' });
  const sucursal = (stock: string): any => {
    const s: any = snapshot({ snapshot_version: 2, catalog: catalogoConPaquetes() as any });
    s.modo = 'SUCURSAL';
    s.location = { ...s.location, tipo: 'BRANCH', event_status: null };
    s.stock = [{ product_uuid: U.dona, qty: stock }];
    s.transfers = [];
    return s;
  };
  // Un snapshot de evento no entra en una caja de sucursal.
  await assert.rejects(aplicarSnapshot(db, snapshot({ snapshot_version: 2 })), /caja de sucursal/);
  await aplicarSnapshot(db, sucursal('100'));
  const pos = crearPos(db);
  assert.equal((await pos.stock()).find((x) => x.product_uuid === U.dona)?.qty, '100');
  await pos.abrirTurno(marta, '0');
  await pos.registrarVenta(marta, [{ product_uuid: U.dona, quantity: 3 }], [{ method: 'EFECTIVO', amount: '75.00' }]);
  assert.equal((await pos.stock()).find((x) => x.product_uuid === U.dona)?.qty, '97');
  // La base todavía no sabe de la venta (sigue en 100): la tablet no la olvida.
  await aplicarSnapshot(db, sucursal('100'));
  assert.equal((await pos.stock()).find((x) => x.product_uuid === U.dona)?.qty, '97');
  // Ya subió (la base dice 97) y no hay pendientes: se toma la de la base.
  await db.run(`UPDATE outbox SET status = 'SENT'`);
  await aplicarSnapshot(db, sucursal('90'));
  assert.equal((await pos.stock()).find((x) => x.product_uuid === U.dona)?.qty, '90');
});

test('cliente de Local Host: lee el QR de la computadora y rechaza otros', async () => {
  const { leerQrLocalHost } = await import('../../api/src/index.ts');
  assert.deepEqual(leerQrLocalHost('http://192.168.1.20:7427/pair/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'),
    { base: 'http://192.168.1.20:7427', token: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde' });
  assert.equal(leerQrLocalHost('WX4K-8P2Q-9QF1'), null);
  assert.equal(leerQrLocalHost('https://evil.example/pair/x'), null);
});
