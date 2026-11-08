import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, lupita, U } from '../../../packages/database/test/fixture.ts';
import { imprimirGuardado } from '../lib/ticket-guardado.ts';
import type { Ticket } from '../lib/escpos.ts';
import { impresoraBluetooth } from '../lib/impresora-bluetooth.ts';

test('el flujo real de impresión recupera PENDING, registra falla y reintento sin modificar el negocio', async () => {
  const { pos, db, raw } = await base();
  try {
    await pos.abrirTurno(lupita, '200');
    const v = await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 2 }], [{ method: 'EFECTIVO', amount: '50.00', received: '100.00' }]);
    const hechos = async () => Promise.all(['sales', 'sale_lines', 'payments', 'inventory_movements', 'stock_projection', 'outbox'].map(t => db.all(`SELECT * FROM ${t} ORDER BY rowid`)));
    const antes = await hechos();
    assert.equal((await pos.ticketsSinImprimir()).length, 1);
    await assert.rejects(imprimirGuardado(pos, { tipo: 'red', imprimir: async () => { throw new Error('timeout TCP'); } }, v.sale_uuid), /timeout TCP/);
    assert.deepEqual(await hechos(), antes);
    let ticket: Ticket | undefined;
    await imprimirGuardado(pos, { tipo: 'red', imprimir: async t => { ticket = t; } }, v.sale_uuid, lupita);
    assert.ok(ticket);
    assert.equal(ticket.folio, v.folio);
    assert.equal(ticket.lineas[0].nombre, 'Dona glaseada');
    assert.equal(ticket.pie, undefined);
    // El único dato adicional en la venta es el indicador de impresión; el negocio no cambia.
    const despues = await hechos();
    const normalizar = (tablas: any[][]) => tablas.map((filas, i) => filas.map(f => i === 0 ? { ...f, printed: 0 } : f));
    assert.deepEqual(normalizar(despues), normalizar(antes));
    assert.equal((await pos.ticketsSinImprimir()).length, 0);
    await imprimirGuardado(pos, { tipo: 'red', imprimir: async t => { ticket = t; } }, v.sale_uuid, lupita);
    assert.equal(ticket.pie, 'COPIA');
    assert.deepEqual(await hechos(), despues);
    assert.equal((await db.all("SELECT * FROM audit_local WHERE action='TICKET_REIMPRESO'")).length, 2);
  } finally { raw.close(); }
});

test('sin impresora no se declara el ticket impreso; el trabajo queda recuperable', async () => {
  const { pos, raw } = await base();
  try {
    await pos.abrirTurno(lupita, '0');
    const v = await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]);
    await assert.rejects(imprimirGuardado(pos, { tipo: 'ninguna', imprimir: async () => { assert.fail('No debe invocar el transporte'); } }, v.sale_uuid, lupita), /Configura una impresora/);
    assert.equal((await pos.ticketsSinImprimir())[0].attempts, 0);
  } finally { raw.close(); }
});

test('Bluetooth: la venta queda guardada aunque la impresora esté apagada; FAILED con motivo y se reimprime', async () => {
  const { pos, raw } = await base();
  try {
    await pos.abrirTurno(lupita, '0');
    const v = await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]);
    let encendida = false;
    const enviados: number[][] = [];
    const imp = impresoraBluetooth('66:22:AA:BB:0C:1D', {
      async enviar(_d, datos) {
        if (!encendida) throw Object.assign(new Error('read failed'), { code: 'BT_CONEXION' });
        enviados.push(datos);
      },
    }, { dormir: async () => {} });
    await assert.rejects(imprimirGuardado(pos, imp, v.sale_uuid), /No se pudo conectar con la impresora Bluetooth/);
    const [pend] = await pos.ticketsSinImprimir();
    assert.equal(pend.sale_uuid, v.sale_uuid);
    assert.match(pend.last_error ?? '', /encendida/);
    encendida = true;
    await imprimirGuardado(pos, imp, v.sale_uuid, lupita);
    assert.equal(enviados.length, 1);
    assert.equal((await pos.ticketsSinImprimir()).length, 0);
  } finally { raw.close(); }
});
