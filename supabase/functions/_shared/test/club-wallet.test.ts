import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clubWallet, configDesdeEnv, codigoDe, enlaceGoogle, huella, llaveEnlace, pkpass, revisarCertApple, serialDeCodigo, tokenApple, type EstadoPase } from '../club-wallet.ts';
import { bytes, deB64, esPng, hex, hijos, leer, sha, unzip, zip, crc32, pkcs1APkcs8, pemBloques } from '../wallet-firma.ts';
import { certificadosDePrueba } from './wallet-certs.ts';

const P = await certificadosDePrueba();
const ENV: Record<string, string> = {
  WALLET_SECRET: 'x'.repeat(40), SUPABASE_URL: 'https://prueba.supabase.co',
  APPLE_PASS_TYPE_ID: P.passTypeId, APPLE_TEAM_ID: 'PRUEBA0000', APPLE_PASS_CERT_PEM: P.certPem, APPLE_PASS_KEY_PEM: P.keyPem, APPLE_WWDR_PEM: P.wwdrPem,
  GOOGLE_WALLET_ISSUER_ID: '3388000000000000000', GOOGLE_WALLET_SA_JSON: P.googleSaJson,
};
const { cfg } = configDesdeEnv((k) => ENV[k]);
const BASE = 'https://prueba.supabase.co/functions/v1/club-wallet';
const SERIAL = 'a1b2c3d4e5f60718293a4b5c';
const ESTADO: EstadoPase & { ok: true } = {
  ok: true, serial: SERIAL, company_id: '11111111-2222-4333-8444-555555555555', negocio: 'Negocio de Prueba', socio: 'Mariana López',
  marca: { fondo: '#d0466c', texto: '#ffffff', etiqueta: '#ffe3ea', logo_png: null, icon_png: null },
  puntos: { activo: true, saldo: 120 },
  sellos: [{ uuid: '99999999-0000-4000-8000-000000000001', nombre: 'Café 9+1', llevas: 3, requeridos: 10 }],
  membresias: [{ plan: 'Club Café', hasta: '2026-11-26', estado: 'ACTIVA' }],
  actualizado: '2026-10-28T12:00:00Z',
};

/* ------------------------------------------------------------ configuración */

test('configuración: falla cerrado sin secreto; Apple/Google a medias se apagan y se dice qué falta', () => {
  assert.equal(configDesdeEnv((k) => ({ ...ENV, WALLET_SECRET: 'corto' } as any)[k]).cfg, null);
  const sinApple = configDesdeEnv((k) => (k === 'APPLE_WWDR_PEM' ? undefined : ENV[k]));
  assert.equal(sinApple.cfg?.apple, null);
  assert.deepEqual(sinApple.falta, ['APPLE_WWDR_PEM']);
  assert.ok(sinApple.cfg?.google);
  const nada = configDesdeEnv((k) => (k === 'WALLET_SECRET' || k === 'SUPABASE_URL' ? ENV[k] : undefined));
  assert.equal(nada.cfg?.apple, null); assert.equal(nada.cfg?.google, null); assert.deepEqual(nada.falta, []);
  assert.equal(cfg?.base, BASE);
  assert.equal(revisarCertApple(cfg!.apple!), null);
  assert.match(String(revisarCertApple({ ...cfg!.apple!, passTypeId: 'pass.otro' })), /no es del APPLE_PASS_TYPE_ID/);
});

test('código del pase: WXC-<serial>, sin teléfono, tolerante a mayúsculas del escáner', () => {
  assert.equal(codigoDe(SERIAL), `WXC-${SERIAL}`);
  assert.equal(serialDeCodigo(`wxc-${SERIAL.toUpperCase()}\n`), SERIAL);
  for (const malo of ['WXC-123', `WXC-${SERIAL}0`, '4771234567', `XXC-${SERIAL}`]) assert.equal(serialDeCodigo(malo), null);
});

/* ------------------------------------------------------------ .pkpass */

test('pkpass: ZIP válido, manifest con SHA-1 de cada archivo y pass.json del Club con marca', async () => {
  const z = unzip(await pkpass(ESTADO, cfg as any, new Date('2026-10-28T12:00:00Z')));
  assert.deepEqual([...z.keys()].sort(), ['icon.png', 'icon@2x.png', 'icon@3x.png', 'manifest.json', 'pass.json', 'signature']);
  const man = JSON.parse(new TextDecoder().decode(z.get('manifest.json')));
  for (const [n, h] of Object.entries(man)) assert.equal(hex(await sha('SHA-1', z.get(n)!)), h, n);
  assert.equal(Object.keys(man).includes('signature'), false);
  assert.ok(esPng(z.get('icon.png')), 'icono de reserva en el color de la marca');
  const pj = JSON.parse(new TextDecoder().decode(z.get('pass.json')));
  assert.equal(pj.formatVersion, 1);
  assert.equal(pj.passTypeIdentifier, P.passTypeId);
  assert.equal(pj.serialNumber, SERIAL);
  assert.equal(pj.organizationName, 'Negocio de Prueba');
  assert.equal(pj.backgroundColor, 'rgb(208, 70, 108)');
  assert.equal(pj.webServiceURL, `${BASE}/`);
  assert.equal(pj.authenticationToken, await tokenApple(ENV.WALLET_SECRET, SERIAL));
  assert.ok(pj.authenticationToken.length >= 16);
  assert.deepEqual(pj.barcodes[0], { format: 'PKBarcodeFormatQR', message: `WXC-${SERIAL}`, messageEncoding: 'iso-8859-1', altText: SERIAL.slice(-6).toUpperCase() });
  assert.equal(pj.storeCard.headerFields[0].value, 120);
  assert.equal(pj.storeCard.primaryFields[0].value, 'Mariana López');
  assert.equal(pj.storeCard.auxiliaryFields[0].value, '3/10');
  assert.match(pj.storeCard.secondaryFields[0].value, /^Hasta 26 nov/);
  assert.equal(JSON.stringify(pj).includes('4773'), false, 'el teléfono no viaja en el pase');
});

test('pkpass: logo e icono de la marca cuando los hay', async () => {
  const png = Buffer.from(await (await import('../wallet-firma.ts')).pngLiso(10, '#00ff00')).toString('base64');
  const z = unzip(await pkpass({ ...ESTADO, marca: { ...ESTADO.marca!, logo_png: png, icon_png: png } }, cfg as any));
  for (const n of ['logo.png', 'logo@2x.png', 'icon.png']) assert.equal(Buffer.from(z.get(n)!).toString('base64'), png, n);
});

test('pkpass: firma CMS separada, SHA-256, verificable con la llave del certificado y por OpenSSL', async () => {
  const z = unzip(await pkpass(ESTADO, cfg as any));
  const sig = z.get('signature')!, man = z.get('manifest.json')!;
  const ci = hijos(leer(sig));
  assert.deepEqual([...ci[0].valor], [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02], 'ContentInfo = signedData');
  const sd = hijos(hijos(ci[1])[0]);
  assert.equal(hijos(sd[2]).length, 1, 'separada: encapContentInfo sin contenido');
  assert.equal(hijos(sd[3]).length, 2, 'certificado del pase + WWDR');
  const si = hijos(hijos(sd[4])[0]);
  const attrs = si[3];
  assert.equal(attrs.tag, 0xa0);
  const firmados = new Uint8Array(attrs.crudo); firmados[0] = 0x31;
  const md = hijos(attrs).map((a) => hijos(a)).find((a) => a[0].valor.length === 9 && a[0].valor[8] === 4)!;
  assert.deepEqual([...hijos(md[1])[0].valor], [...(await sha('SHA-256', man))], 'messageDigest = SHA-256(manifest.json)');
  assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', P.passPub, si[5].valor, firmados), 'firma RSA válida');

  const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (openssl.status !== 0) return; // sin OpenSSL en este equipo: basta la verificación de arriba
  const dir = mkdtempSync(join(tmpdir(), 'wallet-'));
  try {
    writeFileSync(join(dir, 'signature'), sig); writeFileSync(join(dir, 'manifest.json'), man); writeFileSync(join(dir, 'ca.pem'), P.caPem);
    const r = spawnSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', join(dir, 'signature'), '-content', join(dir, 'manifest.json'),
      '-CAfile', join(dir, 'ca.pem'), '-purpose', 'any', '-out', join(dir, 'salida')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Verification successful/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('llave PKCS#1 (la que deja openssl pkcs12) también firma', async () => {
  const der = pemBloques(P.keyPem, 'PRIVATE KEY')[0].der;
  const pkcs1 = hijos(leer(der))[2].valor; // PrivateKeyInfo.privateKey
  assert.deepEqual([...pkcs1APkcs8(pkcs1)], [...der]);
});

test('zip determinista y con CRC correcto', () => {
  const a = zip([{ nombre: 'x.txt', datos: bytes('hola') }]);
  assert.deepEqual([...a], [...zip([{ nombre: 'x.txt', datos: bytes('hola') }])]);
  assert.equal(crc32(bytes('123456789')), 0xcbf43926);
});

/* ------------------------------------------------------------ Google */

test('Google: JWT RS256 «savetowallet» con clase y objeto de lealtad, firmado con la cuenta de servicio', async () => {
  const url = await enlaceGoogle(ESTADO, cfg as any, Date.parse('2026-10-28T12:00:00Z'));
  assert.match(url, /^https:\/\/pay\.google\.com\/gp\/v\/save\/[\w-]+\.[\w-]+\.[\w-]+$/);
  const [h, c, s] = url.split('/').at(-1)!.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(deB64(h))), { alg: 'RS256', typ: 'JWT' });
  assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', P.googlePub, deB64(s), bytes(`${h}.${c}`)), 'firma válida');
  const claims = JSON.parse(new TextDecoder().decode(deB64(c)));
  assert.equal(claims.iss, 'wallet@prueba.iam.gserviceaccount.com');
  assert.equal(claims.aud, 'google'); assert.equal(claims.typ, 'savetowallet');
  const [clase] = claims.payload.loyaltyClasses, [obj] = claims.payload.loyaltyObjects;
  assert.equal(obj.classId, clase.id);
  assert.equal(obj.id, `3388000000000000000.wybix-${SERIAL}`);
  assert.equal(obj.loyaltyPoints.balance.int, 120);
  assert.deepEqual(obj.barcode, { type: 'QR_CODE', value: `WXC-${SERIAL}`, alternateText: SERIAL.slice(-6).toUpperCase() });
  assert.equal(clase.hexBackgroundColor, '#d0466c');
  assert.equal(clase.programLogo.sourceUri.uri, `${BASE}/logo/${ESTADO.company_id}.png`);
});

/* ------------------------------------------------------------ la función */

function deps(extra: Partial<Record<string, any>> = {}) {
  const calls: any[] = [];
  const estado = { ...ESTADO };
  const rpc = async (fn: string, p: any) => {
    calls.push([fn, p]);
    if (fn === 'device_autenticar') return p.token === 'credencial-de-equipo-valida' ? { ok: true, device_id: 'eq-1', company_id: 'c-1' } : { ok: false };
    if (fn === 'club_wallet_estado') return p.serial === SERIAL ? estado : { ok: false };
    if (fn === 'club_wallet_emitir') return { ok: true, serial: SERIAL, nuevo: true };
    if (fn === 'club_wallet_resolver') return p.serial === SERIAL ? { ok: true, phone: '4773124588', customer_name: 'Mariana López' } : { ok: false };
    if (fn === 'club_wallet_registrar') return { ok: true, nuevo: true };
    if (fn === 'club_wallet_seriales') return p.desde && p.desde >= 1761652800000 ? { ok: true, serials: [], ultimo: 0 } : { ok: true, serials: [SERIAL], ultimo: 1761652800000 };
    if (fn === 'club_wallet_pendientes') return { ok: true, pases: [{ serial: SERIAL, visto: '2026-10-28T12:00:00.123456+00:00', tokens: ['tok-vivo', 'tok-muerto'] }] };
    if (fn === 'club_wallet_marcar') return { ok: true, cambio: true, actualizado: '2026-10-28T12:05:00Z' };
    return { ok: true };
  };
  const fetchs: any[] = [];
  const f = async (url: any, init: any) => {
    fetchs.push([String(url), init]);
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok-google' }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const apns = async (t: string, tema: string) => { calls.push(['apns', t, tema]); return { status: t === 'tok-muerto' ? 410 : 200 }; };
  return { calls, fetchs, d: { rpc, fetch: f as any, cfg, falta: [], webhookSecret: 'w'.repeat(40), apns, ...extra } };
}
const caja = (b: any, token = 'credencial-de-equipo-valida') => new Request(`${BASE}`, { method: 'POST', headers: { 'x-wybix-device': token }, body: JSON.stringify(b) });

test('función: sin configuración responde 503 a todo', async () => {
  const { d } = deps({ cfg: null, falta: ['WALLET_SECRET'] });
  assert.equal((await clubWallet(caja({ action: 'emitir', phone: '4773124588' }), d as any)).status, 503);
  assert.equal((await clubWallet(new Request(`${BASE}/p/${SERIAL}`), d as any)).status, 503);
});

test('caja: emitir exige equipo y teléfono de 10 dígitos; devuelve enlace con llave y el código', async () => {
  const { d, calls } = deps();
  assert.equal((await clubWallet(caja({ action: 'emitir', phone: '4773124588' }, 'otra-credencial-invalida-xx'), d as any)).status, 401);
  assert.equal((await clubWallet(caja({ action: 'emitir', phone: '12345' }), d as any)).status, 400);
  const r = await (await clubWallet(caja({ action: 'emitir', phone: '+52 (477) 312-4588', customer_name: 'Mariana' }), d as any)).json();
  assert.equal(r.success, true);
  assert.equal(r.codigo, `WXC-${SERIAL}`);
  assert.equal(r.url, `${BASE}/p/${SERIAL}?k=${await llaveEnlace(ENV.WALLET_SECRET, SERIAL)}`);
  const em = calls.find((x) => x[0] === 'club_wallet_emitir')[1];
  assert.equal(em.phone, '4773124588'); assert.equal(em.device_id, 'eq-1'); assert.match(em.serial, /^[0-9a-f]{24}$/);
});

test('caja: resolver un código escaneado; marca valida colores y PNG', async () => {
  const { d, calls } = deps();
  const r = await (await clubWallet(caja({ action: 'resolver', codigo: `WXC-${SERIAL}` }), d as any)).json();
  assert.deepEqual(r, { success: true, serial: SERIAL, phone: '4773124588', customer_name: 'Mariana López' });
  assert.equal((await clubWallet(caja({ action: 'resolver', codigo: 'hola' }), d as any)).status, 400);
  assert.equal((await clubWallet(caja({ action: 'marca', fondo: 'rojo', texto: '#fff', etiqueta: '#fff' }), d as any)).status, 400);
  assert.equal((await clubWallet(caja({ action: 'marca', fondo: '#d0466c', texto: '#ffffff', etiqueta: '#ffe3ea', logo_png: 'bm8tcG5n' }), d as any)).status, 200);
  assert.equal(calls.find((x) => x[0] === 'club_wallet_marca')[1].logo_png, null, 'lo que no es PNG no se guarda');
});

test('enlace del cliente: sin llave 404; iPhone recibe .pkpass; Android va a Google; otro, las dos opciones', async () => {
  const { d } = deps();
  const k = await llaveEnlace(ENV.WALLET_SECRET, SERIAL);
  assert.equal((await clubWallet(new Request(`${BASE}/p/${SERIAL}?k=mala`), d as any)).status, 404);
  const ios = await clubWallet(new Request(`${BASE}/p/${SERIAL}?k=${k}`, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } }), d as any);
  assert.equal(ios.status, 200); assert.equal(ios.headers.get('Content-Type'), 'application/vnd.apple.pkpass');
  assert.ok(unzip(new Uint8Array(await ios.arrayBuffer())).has('signature'));
  const and = await clubWallet(new Request(`${BASE}/p/${SERIAL}?k=${k}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 15)' } }), d as any);
  assert.equal(and.status, 302); assert.match(and.headers.get('Location')!, /^https:\/\/pay\.google\.com\/gp\/v\/save\//);
  const pc = await (await clubWallet(new Request(`${BASE}/p/${SERIAL}?k=${k}`), d as any)).json();
  assert.equal(pc.apple, `${BASE}/p/${SERIAL}?k=${k}&w=apple`);
});

test('PassKit: registro con ApplePass token, seriales con passesUpdatedSince, pase con If-Modified-Since y baja', async () => {
  const { d, calls } = deps();
  const tok = await tokenApple(ENV.WALLET_SECRET, SERIAL);
  const reg = (auth: string) => new Request(`${BASE}/v1/devices/abc123/registrations/${P.passTypeId}/${SERIAL}`, { method: 'POST', headers: { Authorization: auth }, body: JSON.stringify({ pushToken: 'tok-vivo' }) });
  assert.equal((await clubWallet(reg('ApplePass malo'), d as any)).status, 401);
  assert.equal((await clubWallet(reg(`ApplePass ${tok}`), d as any)).status, 201);
  assert.deepEqual(calls.find((x) => x[0] === 'club_wallet_registrar')[1], { device_library_id: 'abc123', serial: SERIAL, push_token: 'tok-vivo' });
  assert.equal((await clubWallet(new Request(`${BASE}/v1/devices/abc123/registrations/pass.otro/${SERIAL}`, { method: 'POST', headers: { Authorization: `ApplePass ${tok}` }, body: '{}' }), d as any)).status, 404);

  const lista = await clubWallet(new Request(`${BASE}/v1/devices/abc123/registrations/${P.passTypeId}`), d as any);
  assert.deepEqual(await lista.json(), { serialNumbers: [SERIAL], lastUpdated: '1761652800000' });
  assert.equal((await clubWallet(new Request(`${BASE}/v1/devices/abc123/registrations/${P.passTypeId}?passesUpdatedSince=1761652800000`), d as any)).status, 204);

  const pase = (h: Record<string, string>) => new Request(`${BASE}/v1/passes/${P.passTypeId}/${SERIAL}`, { headers: h });
  assert.equal((await clubWallet(pase({}), d as any)).status, 401);
  const ok = await clubWallet(pase({ Authorization: `ApplePass ${tok}` }), d as any);
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('Last-Modified'), new Date(ESTADO.actualizado).toUTCString());
  assert.equal((await clubWallet(pase({ Authorization: `ApplePass ${tok}`, 'If-Modified-Since': ok.headers.get('Last-Modified')! }), d as any)).status, 304);

  assert.equal((await clubWallet(new Request(`${BASE}/v1/devices/abc123/registrations/${P.passTypeId}/${SERIAL}`, { method: 'DELETE', headers: { Authorization: `ApplePass ${tok}` } }), d as any)).status, 200);
  assert.equal((await clubWallet(new Request(`${BASE}/v1/log`, { method: 'POST', body: '{"logs":["x"]}' }), d as any)).status, 200);
});

test('notificar: exige secreto; avisa a Apple, da de baja tokens muertos (410) y actualiza Google', async () => {
  const { d, calls, fetchs } = deps();
  assert.equal((await clubWallet(new Request(BASE, { method: 'POST', body: '{"action":"notificar"}' }), d as any)).status, 401);
  const r = await (await clubWallet(new Request(BASE, { method: 'POST', headers: { 'x-webhook-secret': 'w'.repeat(40) }, body: '{"action":"notificar"}' }), d as any)).json();
  assert.deepEqual({ ...r, success: undefined }, { success: undefined, revisados: 1, cambiados: 1, avisos: 1, google: 1, errores: 0 });
  assert.deepEqual(calls.filter((x) => x[0] === 'apns').map((x) => [x[1], x[2]]), [['tok-vivo', P.passTypeId], ['tok-muerto', P.passTypeId]]);
  assert.deepEqual(calls.find((x) => x[0] === 'club_wallet_baja_token')[1], { push_token: 'tok-muerto' });
  const marcar = calls.find((x) => x[0] === 'club_wallet_marcar')[1];
  assert.equal(marcar.visto, '2026-10-28T12:00:00.123456+00:00', 'solo limpia lo que vio');
  assert.equal(marcar.huella, await huella(ESTADO));
  const patch = fetchs.find((x) => x[1]?.method === 'PATCH');
  assert.match(patch[0], /loyaltyObject\/3388000000000000000\.wybix-a1b2c3d4e5f60718293a4b5c$/);
  assert.equal(JSON.parse(patch[1].body).loyaltyPoints.balance.int, 120);
  assert.equal(patch[1].headers.Authorization, 'Bearer tok-google');
});

test('huella: cambia con puntos o sellos, no con la fecha', async () => {
  const h = await huella(ESTADO);
  assert.equal(await huella({ ...ESTADO, actualizado: '2030-01-01T00:00:00Z' }), h);
  assert.notEqual(await huella({ ...ESTADO, puntos: { activo: true, saldo: 121 } }), h);
  assert.notEqual(await huella({ ...ESTADO, sellos: [{ ...ESTADO.sellos[0], llevas: 4 }] }), h);
});
