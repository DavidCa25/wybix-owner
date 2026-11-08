import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impresoraBluetooth, normalizarDireccion, mensajeBluetooth, esReintentable, type TransporteBt } from '../lib/impresora-bluetooth.ts';
import { ticketEscPos, ANCHO_58, type Ticket } from '../lib/escpos.ts';

const ticket: Ticket = {
  negocio: 'I Do Nut', ubicacion: 'Caja 1', folio: 'F1-000045', fecha: '07/11/2026 18:30', cajero: 'Lupita',
  lineas: [{ cantidad: '3', nombre: 'Dona de chocolate con chispas de colores', importe: '$75.00' }],
  total: '$75.00', pagos: [{ metodo: 'Efectivo', monto: '$100.00' }], cambio: '25.00',
};
const DIR = '66:22:AA:BB:0C:1D';
const err = (code: string, message = code) => Object.assign(new Error(message), { code });
const sinEspera = { dormir: async () => {} };

/** Transporte falso: responde con la lista de resultados en orden (undefined = éxito). */
function falso(resultados: Array<Error | undefined>) {
  const llamadas: Array<{ direccion: string; datos: number[]; timeoutMs: number }> = [];
  const t: TransporteBt = {
    async enviar(direccion, datos, timeoutMs) {
      llamadas.push({ direccion, datos, timeoutMs });
      const r = resultados.shift();
      if (r) throw r;
    },
  };
  return { t, llamadas };
}

test('dirección: acepta MAC con : o -, en cualquier caja; rechaza lo demás', () => {
  assert.equal(normalizarDireccion(' 66:22:aa:bb:0c:1d '), DIR);
  assert.equal(normalizarDireccion('66-22-AA-BB-0C-1D'), DIR);
  for (const malo of ['', null, undefined, '66:22:AA:BB:0C', '66:22:AA:BB:0C:1D:00', 'GG:22:AA:BB:0C:1D', '192.168.1.50']) {
    assert.equal(normalizarDireccion(malo), null, String(malo));
  }
});

test('formato: envía el ticket ESC/POS de 58 mm (32 columnas) a la dirección normalizada', async () => {
  const { t, llamadas } = falso([undefined]);
  const imp = impresoraBluetooth('66:22:aa:bb:0c:1d', t, sinEspera);
  assert.equal(imp.tipo, 'bluetooth');
  await imp.imprimir(ticket);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].direccion, DIR);
  assert.deepEqual(llamadas[0].datos, Array.from(ticketEscPos(ticket, ANCHO_58)));
  assert.ok(llamadas[0].datos.every((b) => Number.isInteger(b) && b >= 0 && b <= 255));
  // Ninguna línea de texto excede 32 columnas (el nombre largo se recorta).
  const lineas = Buffer.from(llamadas[0].datos).toString('latin1').split('\n').map((l) => l.replace(/[\x00-\x1f]./g, '').replace(/[\x00-\x1f]/g, ''));
  assert.ok(lineas.every((l) => l.length <= 32), lineas.find((l) => l.length > 32));
  assert.ok(lineas.some((l) => l.startsWith('3 Dona de chocolate') && l.endsWith('$75.00')));
});

test('reconexión: si la impresora estaba dormida, el segundo intento imprime', async () => {
  const esperas: number[] = [];
  const { t, llamadas } = falso([err('BT_CONEXION', 'read failed, socket might closed'), undefined]);
  const imp = impresoraBluetooth(DIR, t, { esperaMs: 1500, dormir: async (ms) => { esperas.push(ms); } });
  await imp.imprimir(ticket);
  assert.equal(llamadas.length, 2);
  assert.deepEqual(esperas, [1500]);
  assert.deepEqual(llamadas[0].datos, llamadas[1].datos);
});

test('reconexión: el tiempo agotado al conectar también se reintenta; tras agotar intentos falla con mensaje claro', async () => {
  const { t, llamadas } = falso([err('BT_TIEMPO'), err('BT_TIEMPO'), err('BT_TIEMPO')]);
  const imp = impresoraBluetooth(DIR, t, { ...sinEspera, intentos: 3 });
  await assert.rejects(imp.imprimir(ticket), (e: Error & { code?: string }) => {
    assert.equal(e.code, 'BT_TIEMPO');
    assert.match(e.message, /no respondió/);
    return true;
  });
  assert.equal(llamadas.length, 3);
});

test('a media impresión (BT_ENVIO) NO se reintenta: evitaría un ticket doble; queda para reimprimir', async () => {
  const { t, llamadas } = falso([err('BT_ENVIO'), undefined]);
  const imp = impresoraBluetooth(DIR, t, sinEspera);
  await assert.rejects(imp.imprimir(ticket), /Reimprime el ticket desde Estado/);
  assert.equal(llamadas.length, 1);
});

test('errores que no se arreglan reintentando fallan al primer intento', async () => {
  for (const code of ['BT_APAGADO', 'BT_PERMISO', 'BT_NO_EMPAREJADA', 'BT_NO_SOPORTADO']) {
    const { t, llamadas } = falso([err(code), undefined]);
    await assert.rejects(impresoraBluetooth(DIR, t, sinEspera).imprimir(ticket), (e: Error & { code?: string }) => e.code === code);
    assert.equal(llamadas.length, 1, code);
  }
});

test('sin módulo nativo o con dirección inválida no intenta conectar', async () => {
  await assert.rejects(impresoraBluetooth(DIR, null).imprimir(ticket), /no tiene Bluetooth/);
  const { t, llamadas } = falso([]);
  await assert.rejects(impresoraBluetooth('no-es-mac', t).imprimir(ticket), /no es válida|Elígela de nuevo/);
  assert.equal(llamadas.length, 0);
});

test('cola: dos tickets seguidos nunca abren dos conexiones a la vez, y una falla no bloquea al siguiente', async () => {
  let abiertas = 0, maximo = 0, n = 0;
  const t: TransporteBt = {
    async enviar() {
      abiertas++; maximo = Math.max(maximo, abiertas);
      await new Promise((r) => setTimeout(r, 5));
      abiertas--;
      if (++n === 1) throw err('BT_ENVIO');
    },
  };
  const imp = impresoraBluetooth(DIR, t, sinEspera);
  const [a, b, c] = await Promise.allSettled([imp.imprimir(ticket), imp.imprimir(ticket), imp.imprimir(ticket)]);
  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'fulfilled');
  assert.equal(c.status, 'fulfilled');
  assert.equal(maximo, 1);
});

test('mensajes: códigos conocidos en español; desconocidos conservan el detalle', () => {
  assert.match(mensajeBluetooth(err('BT_APAGADO')), /Bluetooth de la tablet está apagado/);
  assert.match(mensajeBluetooth(err('BT_NO_EMPAREJADA')), /Ajustes de Android/);
  assert.equal(mensajeBluetooth(new Error('algo raro')), 'Impresora Bluetooth: algo raro');
  assert.equal(esReintentable(err('BT_CONEXION')), true);
  assert.equal(esReintentable(err('BT_ENVIO')), false);
  assert.equal(esReintentable(new Error('x')), false);
});
