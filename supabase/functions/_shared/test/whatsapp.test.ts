import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  PLANTILLAS, asegurarPlantillas, avisosWhatsapp, cicloWhatsApp, cifradorDe, conectarWhatsapp, entornoWhatsapp, grafoMeta,
  grafoSimulado, webhookWhatsapp, whatsappMeta, whatsappSimulado, type EntornoWa, type MensajeWa,
} from '../whatsapp.ts';

const fila = (id: number, extra: Partial<MensajeWa> = {}) =>
  ({ id, company_id: 'c-1', kind: 'PEDIDO_LISTO', phone: '525512345678', template: 'wybix_pedido_listo', lang: 'es_MX', params: ['12', 'I Do Nut'], attempts: 1, ...extra });
const respuesta = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const CLAVE = randomBytes(32).toString('base64');
const CUENTA = { phone_number_id: '1234567890', token: 'tok-del-negocio-123' };

function rpcFalso(colas: Record<string, any>) {
  const llamadas: Array<{ n: string; a: any }> = [];
  return { llamadas, rpc: async (n: string, a: any = {}) => { llamadas.push({ n, a }); const v = colas[n]; return typeof v === 'function' ? v(a) : v ?? null; } };
}

// ------------------------------------------------------------ entorno
test('falla cerrado: sin llave, sin proveedor o sin datos de la app no hay nada', async () => {
  const e = (o: Record<string, string>) => entornoWhatsapp((k) => o[k]);
  assert.equal((await e({})).wa, null);
  assert.equal((await e({ WHATSAPP_PROVEEDOR: 'simulado' })).wa, null, 'simulado sin llave');
  assert.equal((await e({ WHATSAPP_PROVEEDOR: 'simulado', WHATSAPP_CLAVE_TOKENS: 'corta' })).wa, null, 'llave que no mide 32 bytes');
  assert.equal((await e({ WHATSAPP_PROVEEDOR: 'meta', WHATSAPP_CLAVE_TOKENS: CLAVE })).wa, null, 'meta sin app');
  assert.equal((await e({ WHATSAPP_PROVEEDOR: 'meta', WHATSAPP_CLAVE_TOKENS: CLAVE, WHATSAPP_APP_ID: '123456', WHATSAPP_APP_SECRET: 'x'.repeat(32), WHATSAPP_CONFIG_ID: 'abc' })).grafo, null, 'config id inválido');
  assert.equal((await e({ WHATSAPP_PROVEEDOR: 'simulado', WHATSAPP_CLAVE_TOKENS: CLAVE })).wa?.nombre, 'simulado');
  const m = await e({ WHATSAPP_PROVEEDOR: 'meta', WHATSAPP_CLAVE_TOKENS: CLAVE, WHATSAPP_APP_ID: '123456', WHATSAPP_APP_SECRET: 'x'.repeat(32), WHATSAPP_CONFIG_ID: '7654321' });
  assert.equal(m.wa?.nombre, 'meta'); assert.equal(m.grafo?.nombre, 'meta'); assert.equal(m.app?.configId, '7654321');
});

test('cifrado: AES-GCM ida y vuelta; otra llave no descifra; el texto no aparece', async () => {
  const c = (await cifradorDe(CLAVE))!, otra = (await cifradorDe(randomBytes(32).toString('base64')))!;
  const s = await c.cifrar('EAAG-token-secreto');
  assert.match(s, /^v1\./); assert.ok(!s.includes('EAAG'));
  assert.notEqual(s, await c.cifrar('EAAG-token-secreto'), 'IV distinto cada vez');
  assert.equal(await c.descifrar(s), 'EAAG-token-secreto');
  await assert.rejects(otra.descifrar(s));
});

// ------------------------------------------------------------ Meta envío
test('Meta: sale por el número del negocio con SU token, plantilla y botón de baja', async () => {
  let pedido: any, url = '', auth = '';
  const wa = whatsappMeta(async (u, init) => { url = u; auth = String((init!.headers as any).Authorization); pedido = JSON.parse(String(init!.body)); return respuesta(200, { messages: [{ id: 'wamid.ABC' }] }); });
  const r = await wa.enviar(fila(41), CUENTA);
  assert.deepEqual(r, { ok: true, ref: 'wamid.ABC' });
  assert.equal(url, 'https://graph.facebook.com/v23.0/1234567890/messages');
  assert.equal(auth, 'Bearer tok-del-negocio-123');
  assert.equal(pedido.to, '525512345678');
  assert.equal(pedido.template.name, 'wybix_pedido_listo');
  assert.deepEqual(pedido.template.components[0].parameters.map((p: any) => p.text), ['12', 'I Do Nut']);
  assert.equal(pedido.template.components[1].parameters[0].payload, 'BAJA:41');
});

test('Meta: número sin WhatsApp o plantilla mala son permanentes; límite y 5xx reintentan; 190 marca token', async () => {
  for (const [st, code, perm] of [[400, 131026, true], [400, 132001, true], [429, 130429, false], [500, 1, false], [401, 190, false]] as const) {
    const wa = whatsappMeta(async () => respuesta(st, { error: { code, message: 'x' } }));
    const r = await wa.enviar(fila(1), CUENTA);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.permanente, perm, `código ${code}`);
    assert.equal(!r.ok && !!r.tokenInvalido, code === 190);
  }
});

// ------------------------------------------------------------ Graph
test('Graph: canje del código, suscripción, registro y plantillas en la WABA del negocio', async () => {
  const pasos: Array<{ m: string; u: string; b?: any; auth?: string }> = [];
  const g = grafoMeta(async (u, init) => {
    pasos.push({ m: init?.method ?? 'GET', u, b: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as any)?.Authorization });
    if (u.includes('/oauth/access_token')) return respuesta(200, { access_token: 'EAAG' + 'x'.repeat(40) });
    if (u.endsWith('/message_templates') && init?.method === 'POST') return respuesta(200, { id: '1', status: 'PENDING', category: 'UTILITY' });
    if (u.includes('/message_templates?')) return respuesta(200, { data: [{ name: 'wybix_pedido_listo', status: 'APPROVED', category: 'UTILITY', language: 'es_MX' }, { name: 'otra', status: 'APPROVED' }] });
    return respuesta(200, { success: true });
  }, { id: '111222', secreto: 's'.repeat(32) });
  const token = await g.canjear('CODIGO-DE-META');
  assert.match(pasos[0].u, /client_id=111222&client_secret=s+&code=CODIGO-DE-META/);
  assert.equal(pasos[0].auth, undefined, 'el canje no lleva token');
  await g.suscribir('99887766', token);
  assert.deepEqual([pasos[1].m, pasos[1].u.split('v23.0')[1]], ['POST', '/99887766/subscribed_apps']);
  await g.registrar('1234567890', token, '123456');
  assert.deepEqual(pasos[2].b, { messaging_product: 'whatsapp', pin: '123456' });
  const estado = await asegurarPlantillas(g, '99887766', token);
  assert.equal(estado.wybix_pedido_listo, 'APPROVED', 'la que ya existe no se crea otra vez');
  const creadas = pasos.filter((p) => p.m === 'POST' && p.u.endsWith('/message_templates')).map((p) => p.b);
  assert.deepEqual(creadas.map((c) => c.name), PLANTILLAS.slice(1).map((p) => p.nombre));
  assert.equal(creadas[0].category, 'UTILITY'); assert.equal(creadas[0].language, 'es_MX');
  assert.deepEqual(creadas[0].components.map((c: any) => c.type), ['BODY', 'FOOTER', 'BUTTONS']);
  assert.equal(creadas[0].components[2].buttons[0].type, 'QUICK_REPLY');
  assert.ok(pasos.every((p) => p.u.includes('/oauth/') || p.auth === `Bearer ${token}`), 'todo lo demás con el token del negocio');
});

test('Graph: una plantilla que Meta pasa a Marketing no se usa', async () => {
  const g = grafoMeta(async (u) => u.includes('?') ? respuesta(200, { data: [{ name: 'wybix_pedido_listo', status: 'APPROVED', category: 'MARKETING', language: 'es_MX' }] }) : respuesta(200, {}), { id: '1', secreto: 's'.repeat(32) });
  assert.equal((await g.plantillas('99887766', 't'.repeat(30))).wybix_pedido_listo, 'MARKETING');
});

// ------------------------------------------------------------------ ciclo
const entorno = async (o: Partial<EntornoWa> = {}): Promise<EntornoWa> =>
  ({ wa: whatsappSimulado(), grafo: grafoSimulado(), clave: await cifradorDe(CLAVE), app: { id: 'simulado', configId: 'simulado', version: 'v23.0' }, conectarUrl: 'https://web.test/whatsapp/conectar', ...o });

test('ciclo: sin proveedor o sin llave no planea ni toma nada', async () => {
  const { llamadas, rpc } = rpcFalso({});
  assert.deepEqual(await cicloWhatsApp({ rpc, wa: null, clave: await cifradorDe(CLAVE) }), { planeados: 0, ok: 0, fallo: 0 });
  assert.deepEqual(await cicloWhatsApp({ rpc, wa: whatsappSimulado(), clave: null }), { planeados: 0, ok: 0, fallo: 0 });
  assert.equal(llamadas.length, 0);
});

test('ciclo: cada aviso sale por la cuenta de SU negocio; sin cuenta falla sin mandar', async () => {
  const c = (await cifradorDe(CLAVE))!;
  const tokA = await c.cifrar('token-A'), tokB = await c.cifrar('token-B');
  const { llamadas, rpc } = rpcFalso({
    wa_planear_membresias: 2,
    wa_tomar: [fila(1), fila(2, { company_id: 'c-2' }), fila(3, { company_id: 'c-3' }), fila(4)],
    wa_credencial: (a: any) => ({ 'c-1': { status: 'ACTIVA', phone_number_id: '111111', token_cifrado: tokA },
                                   'c-2': { status: 'ACTIVA', phone_number_id: '222222', token_cifrado: tokB } } as any)[a.p_company] ?? null,
  });
  const wa = whatsappSimulado();
  const r = await cicloWhatsApp({ rpc, wa, clave: c });
  assert.deepEqual(r, { planeados: 2, ok: 3, fallo: 1 });
  assert.deepEqual(wa.enviados.map((m) => [m.id, m.desde]), [[1, '111111'], [2, '222222'], [4, '111111']]);
  assert.equal(llamadas.filter((l) => l.n === 'wa_credencial').length, 3, 'una vez por negocio');
  const sin = llamadas.find((l) => l.n === 'wa_resultado' && l.a.p_id === 3)!.a;
  assert.equal(sin.p_ok, false); assert.equal(sin.p_error, 'SIN_NUMERO'); assert.equal(sin.p_permanente, true);
});

test('ciclo: token rechazado por Meta pasa la cuenta a ERROR; excepción del proveedor es transitoria', async () => {
  const c = (await cifradorDe(CLAVE))!;
  const { llamadas, rpc } = rpcFalso({ wa_tomar: [fila(9), fila(10)], wa_credencial: { status: 'ACTIVA', phone_number_id: '111111', token_cifrado: await c.cifrar('t') } });
  await cicloWhatsApp({ rpc, clave: c, wa: { nombre: 'meta', enviar: async (m) => {
    if (m.id === 9) throw new Error('sin red');
    return { ok: false, error: 'meta 401 #190', permanente: false, tokenInvalido: true };
  } } });
  const r9 = llamadas.find((l) => l.n === 'wa_resultado' && l.a.p_id === 9)!.a;
  assert.equal(r9.p_permanente, false); assert.match(r9.p_error, /sin red/);
  const est = llamadas.find((l) => l.n === 'wa_cuenta_estado')!.a;
  assert.deepEqual([est.p_company, est.p_status], ['c-1', 'ERROR']);
});

// ------------------------------------------------------- whatsapp-avisos
const ID = '90000000-0000-4000-8000-000000000001';
const pedido = (b: any, token = '123456789012345678901') =>
  new Request('https://local.test/whatsapp-avisos', { method: 'POST', headers: { 'x-wybix-device': token }, body: JSON.stringify(b) });

async function depsAvisos(pl: any = { ok: true, code: 'ENCOLADO', message_id: 77 }, auth = true, extra: Record<string, any> = {}) {
  const c = (await cifradorDe(CLAVE))!;
  const { llamadas, rpc } = rpcFalso({
    device_autenticar: auth ? { ok: true, device_id: 'eq-1', company_id: 'c-1' } : { ok: false },
    wa_pedido_listo: pl, wa_tomar_uno: [fila(77)], wa_config: { ok: true, config: { pedido_listo: true }, principal: true },
    wa_credencial: { status: 'ACTIVA', waba_id: '99887766', phone_number_id: '111111', token_cifrado: await c.cifrar('token-A') },
    ...extra,
  });
  const e = await entorno();
  return { llamadas, wa: e.wa as ReturnType<typeof whatsappSimulado>, grafo: e.grafo as ReturnType<typeof grafoSimulado>, deps: { rpc, rpcArgs: rpc, entorno: e } };
}

test('pedido listo: equipo inválido no encola ni manda', async () => {
  const { llamadas, wa, deps } = await depsAvisos(undefined, false);
  assert.equal((await avisosWhatsapp(pedido({ action: 'pedido_listo', id: ID, numero: 12, telefono: '5512345678' }), deps)).status, 401);
  assert.equal(llamadas.some((l) => l.n === 'wa_pedido_listo'), false);
  assert.equal(wa.enviados.length, 0);
});

test('pedido listo: la empresa sale del equipo, se encola y sale en el acto por su número', async () => {
  const { llamadas, wa, deps } = await depsAvisos();
  const r = await avisosWhatsapp(pedido({ action: 'pedido_listo', id: ID, numero: 12, telefono: '55 1234 5678', url: 'http://192.168.1.20:8787/p/AB', company_id: 'otra' }), deps);
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.status, 'SENT'); assert.equal(j.proveedor, 'simulado');
  const enc = llamadas.find((l) => l.n === 'wa_pedido_listo')!.a;
  assert.equal(enc.device_id, 'eq-1'); assert.equal(enc.company_id, undefined);
  assert.deepEqual(wa.enviados.map((m) => [m.id, m.desde]), [[77, '111111']]);
});

test('pedido listo: repetido (YA), apagado, sin número, plantilla pendiente u opt-out no mandan', async () => {
  for (const pl of [{ ok: true, code: 'YA', message_id: 77, status: 'SENT' }, { ok: false, code: 'DESACTIVADO' }, { ok: false, code: 'SIN_NUMERO' },
                    { ok: false, code: 'PLANTILLA_PENDIENTE' }, { ok: false, code: 'OPT_OUT', message_id: 78 }]) {
    const { wa, deps } = await depsAvisos(pl);
    const j = await (await avisosWhatsapp(pedido({ action: 'pedido_listo', id: ID, numero: 12, telefono: '5512345678' }), deps)).json();
    assert.equal(j.success, true, pl.code); assert.equal(j.code, pl.code);
    assert.equal(wa.enviados.length, 0, `${pl.code} no manda`);
  }
});

test('pedido listo: datos inválidos son 400 sin tocar la base', async () => {
  const { llamadas, deps } = await depsAvisos();
  for (const b of [{ id: 'malo', numero: 1, telefono: '5512345678' }, { id: ID, numero: 1.5, telefono: '5512345678' }, { id: ID, numero: 1, telefono: 5512345678 }]) {
    assert.equal((await avisosWhatsapp(pedido({ action: 'pedido_listo', ...b }), deps)).status, 400);
  }
  assert.equal(llamadas.some((l) => l.n === 'wa_pedido_listo'), false);
});

test('config: guardar viaja con la acción; NOT_PRIMARY es 403', async () => {
  const { llamadas, deps } = await depsAvisos();
  const j = await (await avisosWhatsapp(pedido({ action: 'config', accion: 'guardar', config: { pedido_listo: true, dias_antes: 3 } }), deps)).json();
  assert.equal(j.success, true); assert.equal(j.conectable, true);
  assert.equal(llamadas.find((l) => l.n === 'wa_config')!.a.accion, 'guardar');
  const otro = await depsAvisos();
  (otro.deps as any).rpc = async (n: string) => (n === 'device_autenticar' ? { ok: true, device_id: 'eq-2' } : { ok: false, code: 'NOT_PRIMARY' });
  assert.equal((await avisosWhatsapp(pedido({ action: 'config', accion: 'guardar', config: {} }), otro.deps)).status, 403);
});

test('conexión: la caja recibe un enlace de un solo uso; a la base solo va el sha256', async () => {
  const { llamadas, deps } = await depsAvisos(undefined, true, { wa_conexion: { ok: true, cuenta: null, principal: true } });
  const j = await (await avisosWhatsapp(pedido({ action: 'conexion', accion: 'iniciar' }), deps)).json();
  const t = /#t=([0-9a-f]{64})$/.exec(j.url)![1];
  assert.ok(j.url.startsWith('https://web.test/whatsapp/conectar#t='));
  const h = llamadas.find((l) => l.n === 'wa_conexion')!.a.token_hash;
  assert.equal(h, createHash('sha256').update(t).digest('hex'));
  assert.notEqual(h, t);
});

test('conexión: sin llave o sin app de Meta no se ofrece el enlace', async () => {
  const { deps } = await depsAvisos(undefined, true, { wa_conexion: { ok: true } });
  deps.entorno = await entorno({ grafo: null, app: null });
  const r = await avisosWhatsapp(pedido({ action: 'conexion', accion: 'iniciar' }), deps);
  assert.equal(r.status, 503); assert.equal((await r.json()).code, 'NO_CONFIGURADO');
});

test('conexión: estado con plantillas pendientes pregunta a Meta y crea las que falten', async () => {
  const { llamadas, grafo, deps } = await depsAvisos(undefined, true, {
    wa_conexion: { ok: true, principal: true, company_id: 'c-1', cuenta: { status: 'ACTIVA', plantillas: { wybix_pedido_listo: 'PENDING' } } },
  });
  await avisosWhatsapp(pedido({ action: 'conexion', accion: 'estado' }), deps);
  assert.equal(grafo.llamadas.filter((n) => n === 'crearPlantilla').length, 4);
  const pl = llamadas.find((l) => l.n === 'wa_cuenta_plantillas')!.a;
  assert.equal(pl.p_company, 'c-1'); assert.equal(Object.keys(pl.p_plantillas).length, 4);
});

test('conexión: desconectar quita la suscripción en Meta y luego la cuenta', async () => {
  const { llamadas, grafo, deps } = await depsAvisos(undefined, true, { wa_conexion: (a: any) => ({ ok: true, principal: true, company_id: 'c-1', cuenta: a.accion === 'desconectar' ? null : { status: 'ACTIVA' } }) });
  const j = await (await avisosWhatsapp(pedido({ action: 'conexion', accion: 'desconectar' }), deps)).json();
  assert.equal(j.success, true); assert.deepEqual(grafo.llamadas, ['dessuscribir']);
  assert.deepEqual(llamadas.filter((l) => l.n === 'wa_conexion').map((l) => l.a.accion), ['estado', 'desconectar']);
});

// ----------------------------------------------------- whatsapp-conectar
const T = 'a'.repeat(64);
const conectar = (b: any) => new Request('https://web.test/backend/functions/v1/whatsapp-conectar', { method: 'POST', body: JSON.stringify(b) });

test('conectar: enlace vencido o malformado no llega a Meta', async () => {
  const { rpc } = rpcFalso({ wa_conexion_sesion: { ok: false, code: 'ENLACE_VENCIDO' } });
  const e = await entorno(); const g = e.grafo as ReturnType<typeof grafoSimulado>;
  assert.equal((await conectarWhatsapp(conectar({ action: 'finalizar', t: 'corto' }), { rpcArgs: rpc, entorno: e })).status, 401);
  assert.equal((await conectarWhatsapp(conectar({ action: 'finalizar', t: T, code: 'x'.repeat(20), waba_id: '99887766', phone_number_id: '1234567' }), { rpcArgs: rpc, entorno: e })).status, 401);
  assert.equal(g.llamadas.length, 0);
});

test('conectar: canjea, suscribe, registra, da de alta plantillas y guarda token y PIN cifrados', async () => {
  const { llamadas, rpc } = rpcFalso({ wa_conexion_sesion: { ok: true, negocio: 'I Do Nut', company_id: 'c-1' }, wa_conexion_guardar: { ok: true, cuenta: { status: 'ACTIVA' } } });
  const e = await entorno(); const g = e.grafo as ReturnType<typeof grafoSimulado>;
  const s = await (await conectarWhatsapp(conectar({ action: 'sesion', t: T }), { rpcArgs: rpc, entorno: e })).json();
  assert.equal(s.negocio, 'I Do Nut'); assert.equal(s.modo, 'simulado');
  const r = await conectarWhatsapp(conectar({ action: 'finalizar', t: T, code: 'CODIGO-META-1', waba_id: '99887766', phone_number_id: '1234567' }), { rpcArgs: rpc, entorno: e });
  assert.equal(r.status, 200);
  assert.deepEqual(g.llamadas.filter((n) => n !== 'crearPlantilla'), ['canjear', 'suscribir', 'registrar', 'numero', 'plantillas']);
  const gu = llamadas.find((l) => l.n === 'wa_conexion_guardar')!.a;
  assert.equal(gu.p_waba, '99887766'); assert.equal(gu.p_numero, '1234567');
  assert.ok(!gu.p_token_cifrado.includes('sim-token'), 'el token no viaja en claro');
  assert.match(await e.clave!.descifrar(gu.p_token_cifrado), /^sim-token-CODIGO-META-1/);
  assert.match(await e.clave!.descifrar(gu.p_pin_cifrado), /^\d{6}$/);
  assert.equal(Object.values(gu.p_plantillas).filter((v) => v === 'APPROVED').length, 4);
});

test('conectar: si Meta falla a medio camino no se guarda nada y se dice en qué paso', async () => {
  const { llamadas, rpc } = rpcFalso({ wa_conexion_sesion: { ok: true } });
  const e = await entorno({ grafo: grafoSimulado({ fallar: { registrar: 'número con 2FA de otro proveedor' } }) });
  const r = await conectarWhatsapp(conectar({ action: 'finalizar', t: T, code: 'CODIGO-META-1', waba_id: '99887766', phone_number_id: '1234567' }), { rpcArgs: rpc, entorno: e });
  const j = await r.json();
  assert.equal(r.status, 502); assert.equal(j.paso, 'registrar');
  assert.equal(llamadas.some((l) => l.n === 'wa_conexion_guardar'), false);
});

// ------------------------------------------------------ whatsapp-webhook
const SECRETO = 'secreto-de-la-app-de-meta-123', VERIFICA = 'token-de-verificacion-123';
const firmado = (cuerpo: unknown, firma?: string) => {
  const raw = JSON.stringify(cuerpo);
  return new Request('https://local.test/whatsapp-webhook', { method: 'POST', body: raw,
    headers: { 'x-hub-signature-256': firma ?? `sha256=${createHmac('sha256', SECRETO).update(raw).digest('hex')}` } });
};
const evento = (value: any, field = 'messages', waba = '99887766') => ({ object: 'whatsapp_business_account', entry: [{ id: waba, changes: [{ field, value }] }] });

test('webhook: sin secretos responde 503 (falla cerrado)', async () => {
  const { rpc } = rpcFalso({});
  assert.equal((await webhookWhatsapp(firmado({}), { rpc, rpcArgs: rpc })).status, 503);
});

test('webhook: verificación GET solo con el token correcto', async () => {
  const { rpc } = rpcFalso({});
  const d = { appSecret: SECRETO, verifyToken: VERIFICA, rpc, rpcArgs: rpc };
  const ok = await webhookWhatsapp(new Request(`https://x/?hub.mode=subscribe&hub.verify_token=${VERIFICA}&hub.challenge=987`), d);
  assert.equal(ok.status, 200); assert.equal(await ok.text(), '987');
  assert.equal((await webhookWhatsapp(new Request('https://x/?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1'), d)).status, 403);
});

test('webhook: firma inválida no toca la base', async () => {
  const { llamadas, rpc } = rpcFalso({});
  const r = await webhookWhatsapp(firmado(evento({ statuses: [{ id: 'wamid.A', status: 'read' }] }), 'sha256=00'), { appSecret: SECRETO, verifyToken: VERIFICA, rpc, rpcArgs: rpc });
  assert.equal(r.status, 401); assert.equal(llamadas.length, 0);
});

test('webhook: estados y bajas llevan el número del negocio que recibió la respuesta', async () => {
  const { llamadas, rpc } = rpcFalso({});
  const r = await webhookWhatsapp(firmado(evento({
    metadata: { phone_number_id: '1234567' },
    statuses: [{ id: 'wamid.A', status: 'read' }, { id: 'wamid.B', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] }],
    messages: [
      { from: '5215512345678', type: 'button', button: { payload: 'BAJA:41', text: 'Ya no recibir avisos' } },
      { from: '5215500000000', type: 'text', text: { body: 'Baja' } },
      { from: '5215511111111', type: 'text', text: { body: 'ALTA' } },
      { from: '5215522222222', type: 'text', text: { body: 'hola, ¿a qué hora abren?' } },
    ],
  })), { appSecret: SECRETO, verifyToken: VERIFICA, rpc, rpcArgs: rpc });
  assert.equal(r.status, 200);
  const est = llamadas.filter((l) => l.n === 'wa_estado').map((l) => l.a);
  assert.deepEqual(est[0], { p_ref: 'wamid.A', p_estado: 'read', p_error: null });
  assert.match(est[1].p_error, /131026/);
  const bajas = llamadas.filter((l) => l.n === 'wa_baja').map((l) => l.a);
  assert.deepEqual(bajas, [
    { phone: '5215512345678', phone_number_id: '1234567', message_id: 41, source: 'BOTON' },
    { phone: '5215500000000', phone_number_id: '1234567', source: 'TEXTO' },
    { phone: '5215511111111', phone_number_id: '1234567', source: 'TEXTO', alta: true },
  ], 'un mensaje cualquiera no es una baja');
});

test('webhook: plantilla aprobada y negocio que quita a Wybix se registran por WABA', async () => {
  const { llamadas, rpc } = rpcFalso({});
  const d = { appSecret: SECRETO, verifyToken: VERIFICA, rpc, rpcArgs: rpc };
  await webhookWhatsapp(firmado(evento({ event: 'APPROVED', message_template_name: 'wybix_pedido_listo', message_template_language: 'es_MX' }, 'message_template_status_update')), d);
  await webhookWhatsapp(firmado(evento({ event: 'PARTNER_REMOVED' }, 'account_update')), d);
  await webhookWhatsapp(firmado(evento({ event: 'VERIFIED_ACCOUNT' }, 'account_update')), d);
  assert.deepEqual(llamadas.find((l) => l.n === 'wa_cuenta_plantillas')!.a, { p_waba: '99887766', p_plantillas: { wybix_pedido_listo: 'APPROVED' } });
  const cu = llamadas.filter((l) => l.n === 'wa_cuenta_estado').map((l) => l.a);
  assert.equal(cu.length, 1, 'un evento informativo no cambia la cuenta');
  assert.deepEqual([cu[0].p_waba, cu[0].p_status], ['99887766', 'DESCONECTADA']);
});
