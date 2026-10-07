import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarWebhook, igualesSeguro, LONGITUD_MINIMA_SECRETO } from '../webhook.ts';
import { manejarAlertaPush, type DepsAlertaPush } from '../alerta-push.ts';

const SECRETO = 'w'.repeat(LONGITUD_MINIMA_SECRETO) + '-prueba';

function deps(over: Partial<DepsAlertaPush> = {}) {
  const enviados: unknown[][] = [];
  const d: DepsAlertaPush = {
    secreto: SECRETO,
    admin: () => ({
      negocioDeSucursal: async (id) => (id === 'suc-1' ? 'neg-1' : null),
      duenos: async () => ['u1', 'u2'],
      tokens: async () => ['ExponentPushToken[a]', 'ExponentPushToken[b]'],
    }),
    enviar: async (m) => { enviados.push(m); return { data: [] }; },
    ...over,
  };
  return { d, enviados };
}
const req = (secreto: string | null, body: unknown = { record: { sucursal_id: 'suc-1', tipo: 'REFUND', titulo: 'Devolución', mensaje: 'x' } }, method = 'POST') =>
  new Request('http://local/fn', { method, headers: secreto == null ? {} : { 'x-webhook-secret': secreto }, body: method === 'POST' ? JSON.stringify(body) : undefined });

test('falla cerrado: sin WEBHOOK_SECRET (o uno corto) nadie pasa, ni con cabecera', async () => {
  assert.deepEqual(await validarWebhook(undefined, 'lo-que-sea'), { ok: false, status: 503, motivo: 'SIN_CONFIGURAR' });
  assert.deepEqual(await validarWebhook('', ''), { ok: false, status: 503, motivo: 'SIN_CONFIGURAR' });
  assert.deepEqual(await validarWebhook('corto', 'corto'), { ok: false, status: 503, motivo: 'SIN_CONFIGURAR' });
  const { d, enviados } = deps({ secreto: undefined });
  assert.equal((await manejarAlertaPush(req(SECRETO), d)).status, 503);
  assert.equal(enviados.length, 0, 'no se envió nada');
});

test('secreto incorrecto o ausente: 401 y no se consulta ni se envía nada', async () => {
  let consultas = 0;
  const { d, enviados } = deps({ admin: () => { consultas++; throw new Error('no debía llegar'); } });
  assert.equal((await manejarAlertaPush(req(null), d)).status, 401);
  assert.equal((await manejarAlertaPush(req(SECRETO + 'x'), d)).status, 401);
  assert.equal((await manejarAlertaPush(req(SECRETO.slice(0, -1)), d)).status, 401);
  assert.equal(consultas, 0);
  assert.equal(enviados.length, 0);
});

test('secreto correcto: un push por token de los dueños de esa sucursal', async () => {
  const { d, enviados } = deps();
  const r = await manejarAlertaPush(req(SECRETO), d);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).sent, 2);
  assert.equal(enviados.length, 1);
  assert.deepEqual((enviados[0] as Array<{ to: string }>).map((m) => m.to), ['ExponentPushToken[a]', 'ExponentPushToken[b]']);
});

test('sin sucursal, sucursal ajena o método distinto: no envía', async () => {
  const { d, enviados } = deps();
  assert.equal((await manejarAlertaPush(req(SECRETO, { record: {} }), d)).status, 400);
  assert.equal((await (await manejarAlertaPush(req(SECRETO, { record: { sucursal_id: 'otra' } }), d)).json()).sent, 0);
  assert.equal((await manejarAlertaPush(req(SECRETO, null, 'GET'), d)).status, 405);
  assert.equal(enviados.length, 0);
});

test('los registros no llevan el secreto (ni el configurado ni el recibido)', async () => {
  const lineas: string[] = [];
  const orig = { warn: console.warn, error: console.error };
  console.warn = (...a: unknown[]) => { lineas.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { lineas.push(a.join(' ')); };
  try {
    await manejarAlertaPush(req('intento-' + SECRETO), deps().d);
    await manejarAlertaPush(req(SECRETO), deps({ admin: () => { throw new Error('falla de base'); } }).d);
  } finally { Object.assign(console, orig); }
  assert.ok(lineas.length >= 2);
  for (const l of lineas) assert.ok(!l.includes(SECRETO), `una línea de registro contiene el secreto: ${l}`);
});

test('igualesSeguro compara bien (incluidas longitudes distintas)', async () => {
  assert.equal(await igualesSeguro('abc', 'abc'), true);
  assert.equal(await igualesSeguro('abc', 'abd'), false);
  assert.equal(await igualesSeguro('abc', 'abcd'), false);
});
