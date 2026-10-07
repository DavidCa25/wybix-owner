import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { armarQr, cuerpoFirmado, verificarQr, base64url, aTransferencia, crearSincronizador, espera, textoEstado, ErrorNubeDenegada, type Manifiesto } from '../src/index.ts';
import { importarTransferencia, resumen, pendientes } from '@wybix/database';
import { base, snapshot, U, lupita, marta } from '../../database/test/fixture.ts';

/** Llave de equipo como la genera el POS de Windows (node:crypto, Ed25519). */
function llaveDeEquipo() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, publica: base64url.enc(new Uint8Array(raw)) };
}
const manifiesto = (o: Partial<Manifiesto> = {}): Manifiesto => ({
  v: 1, t: 'eeeeeeee-0000-4000-8000-000000000001', c: U.company, f: U.centro, to: U.feria, k: 'dev-centro', at: '2026-11-01T08:00:00Z',
  l: [[U.dona, '40.00']], ...o,
});

test('QR firmado por el POS de Windows (node:crypto) se verifica en la tablet (@noble)', () => {
  const k = llaveDeEquipo();
  const m = manifiesto();
  const qr = armarQr(m, new Uint8Array(sign(null, Buffer.from(cuerpoFirmado(m)), k.privateKey)));
  const r = verificarQr(qr, [{ key_id: 'dev-centro', public_key: k.publica }], { company_uuid: U.company, location_uuid: U.feria });
  assert.equal(r.ok, true);
});

test('QR manipulado (40 -> 400), de llave desconocida o de otra empresa: rechazado', () => {
  const k = llaveDeEquipo();
  const m = manifiesto();
  const qr = armarQr(m, new Uint8Array(sign(null, Buffer.from(cuerpoFirmado(m)), k.privateKey)));
  const [p, , f] = qr.split('.');
  const alterado = `${p}.${base64url.enc(new TextEncoder().encode(JSON.stringify({ ...m, l: [[U.dona, '400.00']] })))}.${f}`;
  const llaves = [{ key_id: 'dev-centro', public_key: k.publica }];
  const esperado = { company_uuid: U.company, location_uuid: U.feria };
  assert.equal((verificarQr(alterado, llaves, esperado) as any).code, 'FIRMA');
  assert.equal((verificarQr(qr, [{ key_id: 'dev-centro', public_key: llaveDeEquipo().publica }], esperado) as any).code, 'FIRMA', 'otra llave con el mismo id');
  assert.equal((verificarQr(qr, [], esperado) as any).code, 'LLAVE_DESCONOCIDA');
  assert.equal((verificarQr(qr, llaves, { company_uuid: 'otra', location_uuid: U.feria }) as any).code, 'AJENO');
  assert.equal((verificarQr('hola', llaves, esperado) as any).code, 'FORMATO');
});

test('recepción por QR sin Internet: se importa y se recibe una sola vez', async () => {
  const { db, pos } = await base();
  const k = llaveDeEquipo();
  const m = manifiesto();
  const qr = armarQr(m, new Uint8Array(sign(null, Buffer.from(cuerpoFirmado(m)), k.privateKey)));
  const r = verificarQr(qr, [{ key_id: 'dev-centro', public_key: k.publica }], { company_uuid: U.company, location_uuid: U.feria });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal((await importarTransferencia(db, aTransferencia(r.manifiesto), r.firma)).nueva, true);
  assert.equal((await importarTransferencia(db, aTransferencia(r.manifiesto), r.firma)).nueva, false, 'escanear dos veces no duplica');
  await pos.recibirTransferencia(marta, m.t, {});
  assert.equal((await pos.stock()).find((s) => s.product_uuid === U.dona)?.qty, '40');
});

test('backoff exponencial con jitter, acotado a 15 minutos', () => {
  assert.equal(espera(1, () => 1), 5_000);
  assert.equal(espera(1, () => 0), 2_500);
  assert.equal(espera(4, () => 1), 40_000);
  assert.equal(espera(50, () => 1), 15 * 60_000);
  assert.equal(textoEstado({ pendientes: 18, rechazados: 0, cuarentena: 0 }, true, false), '18 operaciones pendientes');
  assert.equal(textoEstado({ pendientes: 0, rechazados: 0, cuarentena: 0 }, true, false), 'Todo sincronizado');
});

/** Nube falsa: idempotente por event_uuid, con interruptor de red. */
function nubeFalsa() {
  const vistos = new Map<string, unknown>();
  const n = {
    red: true, revocada: false, rechazar: new Set<string>(), llamadas: 0,
    async enviarEventos(l: any) {
      n.llamadas++;
      if (!n.red) throw new TypeError('Network request failed');
      if (n.revocada) throw new ErrorNubeDenegada('DEVICE_REVOKED', 'revocada');
      return { results: l.events.map((e: any) => {
        if (n.rechazar.has(e.event_type)) return { event_uuid: e.event_uuid, result: 'REJECTED', error: 'no válido' };
        if (vistos.has(e.event_uuid)) return { event_uuid: e.event_uuid, result: 'DUPLICATE' };
        vistos.set(e.event_uuid, e); return { event_uuid: e.event_uuid, result: 'APPLIED' };
      }) };
    },
    async snapshot() { if (!n.red) throw new TypeError('offline'); if (n.revocada) throw new ErrorNubeDenegada('DEVICE_REVOKED', 'r'); return snapshot({ snapshot_version: 2 }); },
    async inbox(c: number) { if (!n.red) throw new TypeError('offline'); return { events: [], cursor: c }; },
    vistos,
  };
  return n;
}

test('sin red: nada se pierde; al volver la red sube TODO una sola vez', async () => {
  const { db, pos } = await base();
  const nube = nubeFalsa();
  const s = crearSincronizador({ db, nube, dispositivo: async () => 'tablet-1', version: '0.1.0' });
  await pos.recibirTransferencia(marta, U.transfer, {});
  await pos.abrirTurno(lupita, '0');
  for (let i = 0; i < 5; i++) await pos.registrarVenta(lupita, [{ product_uuid: U.dona, quantity: 1 }], [{ method: 'EFECTIVO', amount: '25.00' }]);
  nube.red = false;
  const e1 = await s.sincronizar(true);
  assert.equal(e1.pendientes, 7);
  assert.equal(e1.en_linea, false);
  assert.match(e1.texto, /Sin conexión · 7 operaciones pendientes/);
  nube.red = true;
  const e2 = await s.sincronizar(true);
  assert.equal(e2.texto, 'Todo sincronizado');
  assert.equal(nube.vistos.size, 7);
  // reenviar lo mismo (p. ej. se perdió el acuse): DUPLICATE, ningún efecto nuevo
  await db.run(`UPDATE outbox SET status = 'PENDING'`);
  await s.sincronizar(true);
  assert.equal(nube.vistos.size, 7);
  assert.equal((await resumen(db)).pendientes, 0);
});

test('lote parcialmente aceptado: lo rechazado queda visible, lo demás sale', async () => {
  const { db, pos } = await base();
  const nube = nubeFalsa();
  nube.rechazar.add('TRANSFER_RECEIVED');
  const s = crearSincronizador({ db, nube, dispositivo: async () => 'tablet-1', version: '0.1.0' });
  await pos.recibirTransferencia(marta, U.transfer, {});
  await pos.abrirTurno(lupita, '0');
  const e = await s.sincronizar(true);
  assert.deepEqual([e.pendientes, e.rechazados], [0, 1]);
  assert.match(e.texto, /1 en revisión/);
});

test('dos sincronizaciones a la vez: una sola ejecución', async () => {
  const { db, pos } = await base();
  const nube = nubeFalsa();
  const s = crearSincronizador({ db, nube, dispositivo: async () => 'tablet-1', version: '0.1.0' });
  await pos.recibirTransferencia(marta, U.transfer, {});
  const [a, b] = [s.sincronizar(true), s.sincronizar(true)];
  assert.equal(a, b);
  await a;
  assert.equal(nube.llamadas, 1);
});

test('tablet revocada: deja de recibir maestros, no borra lo pendiente', async () => {
  const { db, pos } = await base();
  const nube = nubeFalsa();
  const s = crearSincronizador({ db, nube, dispositivo: async () => 'tablet-1', version: '0.1.0' });
  await pos.recibirTransferencia(marta, U.transfer, {});
  nube.revocada = true;
  const e = await s.sincronizar(true);
  assert.equal(e.revocado, true);
  assert.equal((await pendientes(db, 10, '9999')).length, 1, 'lo pendiente sigue ahí');
  await assert.rejects(pos.abrirTurno(lupita, '0'), /dada de baja/);
});
