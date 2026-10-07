import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ejecutarCiclo, pushExpo, correoResend, correoHtml, type Entrega, type DepsMotor } from '../notificaciones.ts';

const e = (id: number, canal: 'push' | 'email', destino = `ExponentPushToken[${id}]`): Entrega =>
  ({ id, canal, destino, titulo: 'Corte con diferencia', cuerpo: 'Centro · Caja 1.', datos: { kind: 'SHIFT_CLOSED' }, attempts: 1 });

function rpcFalso(colas: Record<string, any>) {
  const llamadas: Array<{ n: string; a: any }> = [];
  return { llamadas, rpc: async (n: string, a: any = {}) => { llamadas.push({ n, a }); const v = colas[n]; return typeof v === 'function' ? v(a) : v ?? null; } };
}
const respuesta = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test('push: un lote a Expo; ok, token inválido y error transitorio se reportan cada uno', async () => {
  const { llamadas, rpc } = rpcFalso({ notif_planear: 3, notif_vencer: 0, notif_tomar: ({ p_canal }: any) => (p_canal === 'push' ? [e(1, 'push'), e(2, 'push'), e(3, 'push')] : []), notif_por_recibo: [] });
  const enviados: any[] = [];
  const push = pushExpo(async (_u, init) => {
    enviados.push(JSON.parse(String(init!.body)));
    return respuesta(200, { data: [{ status: 'ok', id: 'tk-1' }, { status: 'error', message: 'no registrado', details: { error: 'DeviceNotRegistered' } },
                                   { status: 'error', message: 'despacio', details: { error: 'MessageRateExceeded' } }] });
  });
  const r = await ejecutarCiclo({ rpc, push, correo: null });
  assert.equal(enviados.length, 1, 'un solo request para el lote');
  assert.deepEqual(enviados[0].map((m: any) => m.to), ['ExponentPushToken[1]', 'ExponentPushToken[2]', 'ExponentPushToken[3]']);
  const res = llamadas.filter((l) => l.n === 'notif_resultado').map((l) => l.a);
  assert.deepEqual(res[0], { p_id: 1, p_ok: true, p_ref: 'tk-1' });
  assert.equal(res[1].p_token_invalido, true);
  assert.equal(res[2].p_permanente, false);
  assert.deepEqual(r.push, { ok: 1, fallo: 2 });
});

test('push: Expo caído (HTTP 503) => todas transitorias; 400 => permanentes', async () => {
  for (const [st, perm] of [[503, false], [400, true]] as const) {
    const { llamadas, rpc } = rpcFalso({ notif_tomar: ({ p_canal }: any) => (p_canal === 'push' ? [e(1, 'push'), e(2, 'push')] : []), notif_por_recibo: [] });
    await ejecutarCiclo({ rpc, push: pushExpo(async () => respuesta(st, {})), correo: null });
    const res = llamadas.filter((l) => l.n === 'notif_resultado').map((l) => l.a);
    assert.equal(res.length, 2);
    assert.ok(res.every((x) => x.p_ok === false && x.p_permanente === perm), `HTTP ${st}`);
  }
});

test('push: si el proveedor lanza una excepción, nada se pierde: todo queda como transitorio', async () => {
  const { llamadas, rpc } = rpcFalso({ notif_tomar: ({ p_canal }: any) => (p_canal === 'push' ? [e(7, 'push')] : []), notif_por_recibo: [] });
  await ejecutarCiclo({ rpc, push: pushExpo(async () => { throw new Error('sin red'); }), correo: null });
  const r = llamadas.find((l) => l.n === 'notif_resultado')!.a;
  assert.equal(r.p_ok, false); assert.equal(r.p_permanente, false); assert.match(r.p_error, /sin red/);
});

test('recibos: DELIVERED, token inválido, y los que Expo aún no tiene se dejan para otro ciclo', async () => {
  const { llamadas, rpc } = rpcFalso({ notif_tomar: [], notif_por_recibo: [{ id: 10, provider_ref: 'a' }, { id: 11, provider_ref: 'b' }, { id: 12, provider_ref: 'c' }] });
  const push = pushExpo(async (url) => url.endsWith('getReceipts')
    ? respuesta(200, { data: { a: { status: 'ok' }, b: { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } } } })
    : respuesta(200, { data: [] }));
  const r = await ejecutarCiclo({ rpc, push, correo: null });
  const rec = llamadas.filter((l) => l.n === 'notif_recibo').map((l) => l.a);
  assert.deepEqual(rec, [{ p_id: 10, p_ok: true }, { p_id: 11, p_ok: false, p_error: 'DeviceNotRegistered: x', p_token_invalido: true }]);
  assert.equal(r.recibos, 2);
});

test('correo: Resend con llave de idempotencia por entrega; 422 permanente, 403 y 429 reintentan', async () => {
  const peticiones: any[] = [];
  const estados = [200, 422, 403, 429];
  const { llamadas, rpc } = rpcFalso({ notif_tomar: ({ p_canal }: any) => (p_canal === 'email' ? [1, 2, 3, 4].map((i) => e(i, 'email', `d${i}@x.mx`)) : []) });
  const correo = correoResend(async (_u, init) => {
    peticiones.push({ headers: init!.headers, body: JSON.parse(String(init!.body)) });
    const st = estados[peticiones.length - 1];
    return st === 200 ? respuesta(200, { id: 're_1' }) : new Response('error', { status: st });
  }, 're_llave', 'Wybix <avisos@wybixpos.com.mx>');
  await ejecutarCiclo({ rpc, push: null, correo });
  assert.equal((peticiones[0].headers as any)['Idempotency-Key'], 'wybix-entrega-1');
  assert.deepEqual(peticiones[0].body.to, ['d1@x.mx']);
  assert.equal(peticiones[0].body.from, 'Wybix <avisos@wybixpos.com.mx>');
  const res = llamadas.filter((l) => l.n === 'notif_resultado').map((l) => l.a);
  assert.deepEqual(res.map((x) => x.p_ok ? 'ok' : x.p_permanente ? 'perm' : 'retry'), ['ok', 'perm', 'retry', 'retry']);
});

test('sin proveedor de correo configurado, el correo ni se toma (espera y vence en SQL)', async () => {
  const { llamadas, rpc } = rpcFalso({ notif_tomar: [], notif_por_recibo: [] });
  await ejecutarCiclo({ rpc, push: null, correo: null });
  assert.ok(!llamadas.some((l) => l.n === 'notif_tomar'));
  assert.ok(llamadas.some((l) => l.n === 'notif_planear') && llamadas.some((l) => l.n === 'notif_vencer'));
});

test('el HTML del correo escapa el contenido', () => {
  const h = correoHtml('<b>x</b>', 'a & "b"');
  assert.ok(h.includes('&lt;b&gt;x&lt;/b&gt;') && h.includes('a &amp; &quot;b&quot;') && !h.includes('<b>x</b>'));
});
