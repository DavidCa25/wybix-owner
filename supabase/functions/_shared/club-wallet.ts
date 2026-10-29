// ============================================================================
//  TARJETA DEL CLUB EN APPLE WALLET Y GOOGLE WALLET
// ----------------------------------------------------------------------------
//  El cliente recibe, por QR en la caja o por enlace, un pase con su
//  membresía, sus puntos y sus sellos. El pase se identifica por un SERIAL
//  aleatorio (24 hex) por empresa y teléfono; el código de barras del pase
//  dice `WXC-<serial>` y la caja lo resuelve a su cliente sin ver el teléfono
//  en el código.
//
//  Rutas (todas bajo /club-wallet):
//    POST  {action:'emitir'|'marca'|'resolver'}   la caja (x-wybix-device)
//    POST  {action:'notificar'}                   pg_cron (x-webhook-secret)
//    GET   /p/<serial>?k=<llave>[&w=apple|google] el enlace del cliente
//    GET   /logo/<empresa>.png                    logo para Google (público)
//    ...   /v1/...                                web service de PassKit (Apple)
//
//  FALLA CERRADO: sin WALLET_SECRET (>= 32) o sin URL pública, todo 503. Apple
//  y Google se encienden cada uno solo con TODOS sus secretos; a medias, se
//  quedan apagados y el motivo va al registro (nunca los valores).
//
//  Autorización: Postgres decide (funciones club_wallet_* con la service role,
//  migración 20261028120000_club_wallet.sql). Aquí solo se arma el pase.
// ============================================================================
import { CORS, equipoDe, json, negado, type Rpc } from './nube.ts';
import { validarWebhook } from './webhook.ts';
import { b64url, bytes, deB64, emisorYSerie, esPng, firmaCms, hex, hmac, jwtRs256, llavePrivada, pemBloques, pngLiso, rgb, sha, zip } from './wallet-firma.ts';

export interface ConfigApple { passTypeId: string; teamId: string; certPem: string; keyPem: string; wwdrPem: string; }
export interface ConfigGoogle { issuerId: string; email: string; keyPem: string; }
export interface ConfigWallet { secreto: string; base: string; apple: ConfigApple | null; google: ConfigGoogle | null; }

/** Lee los secretos. `falta` dice qué falta, por nombre, sin enseñar valores. */
export function configDesdeEnv(env: (k: string) => string | undefined): { cfg: ConfigWallet | null; falta: string[] } {
  const v = (k: string) => (env(k) ?? '').trim();
  const falta: string[] = [];
  const secreto = v('WALLET_SECRET');
  if (secreto.length < 32) falta.push('WALLET_SECRET');
  const base = (v('WALLET_PUBLIC_URL') || (v('SUPABASE_URL') ? `${v('SUPABASE_URL')}/functions/v1/club-wallet` : '')).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(base)) falta.push('WALLET_PUBLIC_URL');

  const ak = ['APPLE_PASS_TYPE_ID', 'APPLE_TEAM_ID', 'APPLE_PASS_CERT_PEM', 'APPLE_PASS_KEY_PEM', 'APPLE_WWDR_PEM'];
  const aFaltan = ak.filter((k) => !v(k));
  let apple: ConfigApple | null = null;
  if (aFaltan.length === 0) apple = { passTypeId: v(ak[0]), teamId: v(ak[1]), certPem: v(ak[2]), keyPem: v(ak[3]), wwdrPem: v(ak[4]) };
  else if (aFaltan.length < ak.length) falta.push(...aFaltan);

  let google: ConfigGoogle | null = null;
  const issuer = v('GOOGLE_WALLET_ISSUER_ID'), sa = v('GOOGLE_WALLET_SA_JSON');
  if (issuer && sa) {
    try {
      const j = JSON.parse(sa);
      if (typeof j.client_email === 'string' && typeof j.private_key === 'string') google = { issuerId: issuer, email: j.client_email, keyPem: j.private_key };
      else falta.push('GOOGLE_WALLET_SA_JSON');
    } catch { falta.push('GOOGLE_WALLET_SA_JSON'); }
  } else if (issuer || sa) falta.push(issuer ? 'GOOGLE_WALLET_SA_JSON' : 'GOOGLE_WALLET_ISSUER_ID');

  return { cfg: falta.some((k) => k === 'WALLET_SECRET' || k === 'WALLET_PUBLIC_URL') ? null : { secreto, base, apple, google }, falta };
}

/* ------------------------------------------------------------ el estado */

export interface MarcaPase { fondo: string; texto: string; etiqueta: string; logo_png?: string | null; icon_png?: string | null; }
export interface EstadoPase {
  serial: string; company_id: string; negocio: string; socio: string | null;
  marca: MarcaPase | null;
  puntos: { activo: boolean; saldo: number };
  sellos: { uuid: string; nombre: string; llevas: number; requeridos: number }[];
  membresias: { plan: string; hasta: string | null; estado: 'ACTIVA' | 'VENCIDA' | 'CANCELADA' }[];
  /** Cuándo cambió por última vez lo que el pase enseña (ISO). */
  actualizado: string;
}

export const SERIAL = /^[0-9a-f]{24}$/;
export const codigoDe = (serial: string) => `WXC-${serial}`;
/** Lo que lee el escáner de la caja -> serial (o null). */
export function serialDeCodigo(codigo: string): string | null {
  const m = /^\s*WXC-([0-9a-f]{24})\s*$/i.exec(codigo ?? '');
  return m ? m[1].toLowerCase() : null;
}
export function nuevoSerial(): string { return hex(crypto.getRandomValues(new Uint8Array(12))); }

/** El token que Apple manda en cada llamada (`ApplePass <token>`): derivado, nunca guardado. */
export const tokenApple = async (secreto: string, serial: string) => b64url(await hmac(secreto, `apple:${serial}`)).slice(0, 32);
/** La llave del enlace del cliente: sin ella, el serial solo no descarga nada. */
export const llaveEnlace = async (secreto: string, serial: string) => b64url(await hmac(secreto, `enlace:${serial}`)).slice(0, 22);

/** Huella de lo que el pase ENSEÑA: si no cambia, no se avisa a nadie. */
export async function huella(e: EstadoPase): Promise<string> {
  const { actualizado: _a, marca, ...resto } = e;
  const m = marca ? { ...marca, logo_png: marca.logo_png?.length ?? 0, icon_png: marca.icon_png?.length ?? 0 } : null;
  return hex(await sha('SHA-256', bytes(JSON.stringify({ ...resto, marca: m })))).slice(0, 32);
}

const MARCA_WYBIX: MarcaPase = { fondo: '#1f2430', texto: '#ffffff', etiqueta: '#b9c0cf' };
const color = (c: string) => { const [r, g, b] = rgb(c); return `rgb(${r}, ${g}, ${b})`; };
const fecha = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

/* ------------------------------------------------------------- Apple */

/** pass.json de una tarjeta del Club (storeCard). */
export async function passJson(e: EstadoPase, cfg: ConfigWallet & { apple: ConfigApple }): Promise<Record<string, unknown>> {
  const m = e.marca ?? MARCA_WYBIX;
  const activa = e.membresias.find((x) => x.estado === 'ACTIVA') ?? e.membresias[0];
  const sec: Record<string, unknown>[] = [];
  if (activa) sec.push({ key: 'membresia', label: activa.plan.toUpperCase(), value: activa.estado === 'ACTIVA' ? `Hasta ${fecha(activa.hasta)}` : activa.estado === 'VENCIDA' ? `Venció ${fecha(activa.hasta)}` : 'Cancelada', changeMessage: 'Tu membresía: %@' });
  const aux = e.sellos.slice(0, 4).map((s) => ({ key: `sellos-${s.uuid}`, label: s.nombre.toUpperCase(), value: `${Math.min(s.llevas, s.requeridos)}/${s.requeridos}`, changeMessage: `${s.nombre}: %@ sellos` }));
  return {
    formatVersion: 1,
    passTypeIdentifier: cfg.apple.passTypeId,
    teamIdentifier: cfg.apple.teamId,
    serialNumber: e.serial,
    organizationName: e.negocio,
    description: `Tarjeta del Club de ${e.negocio}`,
    logoText: e.negocio,
    foregroundColor: color(m.texto), backgroundColor: color(m.fondo), labelColor: color(m.etiqueta),
    webServiceURL: `${cfg.base}/`,
    authenticationToken: await tokenApple(cfg.secreto, e.serial),
    sharingProhibited: true,
    barcodes: [{ format: 'PKBarcodeFormatQR', message: codigoDe(e.serial), messageEncoding: 'iso-8859-1', altText: e.serial.slice(-6).toUpperCase() }],
    storeCard: {
      headerFields: e.puntos.activo ? [{ key: 'puntos', label: 'PUNTOS', value: e.puntos.saldo, changeMessage: 'Ahora tienes %@ puntos' }] : [],
      primaryFields: [{ key: 'socio', label: 'SOCIO', value: e.socio || 'Cliente' }],
      secondaryFields: sec,
      auxiliaryFields: aux,
      backFields: [
        { key: 'como', label: 'Cómo se usa', value: 'Enseña este código en caja: te identifica para sumar puntos y sellos y para usar tu membresía.' },
        ...e.sellos.map((s) => ({ key: `det-${s.uuid}`, label: s.nombre, value: `${s.llevas} de ${s.requeridos} sellos` })),
        { key: 'actualizado', label: 'Actualizado', value: e.actualizado, dateStyle: 'PKDateStyleMedium', timeStyle: 'PKDateStyleShort' },
      ],
    },
  };
}

/** El .pkpass firmado: pass.json + imágenes + manifest.json (SHA-1) + signature (CMS). */
export async function pkpass(e: EstadoPase, cfg: ConfigWallet & { apple: ConfigApple }, ahora = new Date()): Promise<Uint8Array> {
  const m = e.marca ?? MARCA_WYBIX;
  const icono = m.icon_png && esPng(deB64(m.icon_png)) ? deB64(m.icon_png) : await pngLiso(87, m.fondo);
  const archivos: Record<string, Uint8Array> = { 'pass.json': bytes(JSON.stringify(await passJson(e, cfg))), 'icon.png': icono, 'icon@2x.png': icono, 'icon@3x.png': icono };
  if (m.logo_png && esPng(deB64(m.logo_png))) for (const n of ['logo.png', 'logo@2x.png', 'logo@3x.png']) archivos[n] = deB64(m.logo_png);
  const manifiesto: Record<string, string> = {};
  for (const [n, d] of Object.entries(archivos)) manifiesto[n] = hex(await sha('SHA-1', d));
  const man = bytes(JSON.stringify(manifiesto));
  const [cert] = pemBloques(cfg.apple.certPem, 'CERTIFICATE');
  const [wwdr] = pemBloques(cfg.apple.wwdrPem, 'CERTIFICATE');
  if (!cert || !wwdr) throw new Error('Certificado de Apple ilegible.');
  const firma = await firmaCms(man, await llavePrivada(cfg.apple.keyPem), [cert.der, wwdr.der], ahora);
  return zip([...Object.entries(archivos).map(([nombre, datos]) => ({ nombre, datos })), { nombre: 'manifest.json', datos: man }, { nombre: 'signature', datos: firma }]);
}

/** Comprobación de arranque: el certificado de Apple corresponde al Pass Type ID. */
export function revisarCertApple(a: ConfigApple): string | null {
  const [cert] = pemBloques(a.certPem, 'CERTIFICATE');
  if (!cert) return 'APPLE_PASS_CERT_PEM no trae un CERTIFICATE';
  if (!pemBloques(a.wwdrPem, 'CERTIFICATE').length) return 'APPLE_WWDR_PEM no trae un CERTIFICATE';
  const sujeto = new TextDecoder('latin1').decode(emisorYSerie(cert.der).sujeto);
  return sujeto.includes(a.passTypeId) ? null : 'el certificado no es del APPLE_PASS_TYPE_ID configurado';
}

/* ------------------------------------------------------------- Google */

const idClase = (g: ConfigGoogle, e: EstadoPase) => `${g.issuerId}.wybix-club-${e.company_id.replace(/-/g, '')}`;
const idObjeto = (g: ConfigGoogle, serial: string) => `${g.issuerId}.wybix-${serial}`;

export function claseGoogle(e: EstadoPase, cfg: ConfigWallet & { google: ConfigGoogle }) {
  return {
    id: idClase(cfg.google, e), issuerName: e.negocio, programName: `Club ${e.negocio}`,
    programLogo: { sourceUri: { uri: `${cfg.base}/logo/${e.company_id}.png` }, contentDescription: { defaultValue: { language: 'es-MX', value: e.negocio } } },
    hexBackgroundColor: (e.marca ?? MARCA_WYBIX).fondo, reviewStatus: 'UNDER_REVIEW', countryCode: 'MX',
  };
}

/** Lo que cambia con el tiempo (lo mismo va en el alta y en cada actualización). */
function camposObjeto(e: EstadoPase) {
  const mods = [
    ...e.membresias.slice(0, 2).map((x, i) => ({ id: `membresia-${i}`, header: x.plan, body: x.estado === 'ACTIVA' ? `Hasta ${fecha(x.hasta)}` : x.estado === 'VENCIDA' ? `Venció ${fecha(x.hasta)}` : 'Cancelada' })),
    ...e.sellos.slice(0, 6).map((s) => ({ id: `sellos-${s.uuid.replace(/-/g, '')}`, header: s.nombre, body: `${Math.min(s.llevas, s.requeridos)} de ${s.requeridos} sellos` })),
  ];
  return {
    accountName: e.socio || 'Cliente',
    loyaltyPoints: e.puntos.activo ? { label: 'Puntos', balance: { int: e.puntos.saldo } } : undefined,
    textModulesData: mods,
  };
}

export function objetoGoogle(e: EstadoPase, cfg: ConfigWallet & { google: ConfigGoogle }) {
  return {
    id: idObjeto(cfg.google, e.serial), classId: idClase(cfg.google, e), state: 'ACTIVE', accountId: e.serial,
    barcode: { type: 'QR_CODE', value: codigoDe(e.serial), alternateText: e.serial.slice(-6).toUpperCase() },
    ...camposObjeto(e),
  };
}

/** El enlace «Guardar en Google Wallet». La clase y el objeto viajan dentro: se crean al guardar. */
export async function enlaceGoogle(e: EstadoPase, cfg: ConfigWallet & { google: ConfigGoogle }, ahora = Date.now()): Promise<string> {
  const jwt = await jwtRs256({
    iss: cfg.google.email, aud: 'google', typ: 'savetowallet', iat: Math.floor(ahora / 1000), origins: [],
    payload: { loyaltyClasses: [claseGoogle(e, cfg)], loyaltyObjects: [objetoGoogle(e, cfg)] },
  }, await llavePrivada(cfg.google.keyPem));
  return `https://pay.google.com/gp/v/save/${jwt}`;
}

/** Token OAuth de la cuenta de servicio (JWT bearer, RFC 7523). */
export async function tokenGoogle(g: ConfigGoogle, f: typeof fetch, ahora = Date.now()): Promise<string> {
  const iat = Math.floor(ahora / 1000);
  const assertion = await jwtRs256({ iss: g.email, scope: 'https://www.googleapis.com/auth/wallet_object.issuer', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }, await llavePrivada(g.keyPem));
  const r = await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
  const j = await r.json().catch(() => null);
  if (!r.ok || typeof j?.access_token !== 'string') throw new Error(`Google OAuth: HTTP ${r.status}`);
  return j.access_token;
}

/** Actualiza el objeto guardado. 404 = el cliente nunca lo guardó: no es error. */
export async function actualizarGoogle(e: EstadoPase, cfg: ConfigWallet & { google: ConfigGoogle }, token: string, f: typeof fetch): Promise<'OK' | 'NO_GUARDADO'> {
  const r = await f(`https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${encodeURIComponent(idObjeto(cfg.google, e.serial))}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(camposObjeto(e)),
  });
  if (r.status === 404) return 'NO_GUARDADO';
  if (!r.ok) throw new Error(`Google Wallet: HTTP ${r.status}`);
  return 'OK';
}

/* ------------------------------------------------------------- la función */

/** Aviso a un dispositivo con el pase (APNs, tema = Pass Type ID, cuerpo `{}`). */
export type Apns = (pushToken: string, tema: string) => Promise<{ status: number }>;
export interface DepsWallet { rpc: Rpc; fetch: typeof fetch; cfg: ConfigWallet | null; falta: string[]; webhookSecret?: string; apns?: Apns; ahora?: () => Date; log?: (m: string) => void; }

const pkpassResp = (b: Uint8Array, mod: string) => new Response(b, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.pkpass', 'Content-Disposition': 'attachment; filename="club.pkpass"', 'Last-Modified': new Date(mod).toUTCString(), 'Cache-Control': 'no-store' } });
const vacio = (s: number) => new Response(null, { status: s });
const COLOR = /^#[0-9a-f]{6}$/i;

export async function clubWallet(req: Request, d: DepsWallet): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const log = d.log ?? (() => {});
  if (!d.cfg) { log(`club-wallet sin configurar: falta ${d.falta.join(', ')}`); return json({ success: false, code: 'WALLET_NOT_CONFIGURED', error: 'La tarjeta en Wallet todavía no está configurada.' }, 503); }
  const cfg = d.cfg;
  const url = new URL(req.url);
  const i = url.pathname.indexOf('/club-wallet');
  const ruta = (i >= 0 ? url.pathname.slice(i + '/club-wallet'.length) : url.pathname).replace(/\/+$/, '') || '/';
  const partes = ruta.split('/').filter(Boolean);
  const estado = async (serial: string): Promise<EstadoPase | null> => { const r = await d.rpc('club_wallet_estado', { serial }); return r?.ok ? (r as EstadoPase) : null; };

  /* ---------- Apple: web service de PassKit (Apple llama solo; sin CORS) */
  if (partes[0] === 'v1') {
    if (!cfg.apple) return vacio(404);
    const apple = cfg as ConfigWallet & { apple: ConfigApple };
    const autorizado = async (serial: string) => SERIAL.test(serial) && (req.headers.get('Authorization') ?? '') === `ApplePass ${await tokenApple(cfg.secreto, serial)}`;
    if (partes[1] === 'log' && req.method === 'POST') { const t = (await req.text()).slice(0, 2000); log(`passkit log: ${t}`); return vacio(200); }
    if (partes[1] === 'devices' && partes[3] === 'registrations') {
      const [, , dli, , pt, serial] = partes;
      if (pt !== apple.apple.passTypeId || !/^[0-9a-zA-Z]{1,64}$/.test(dli ?? '')) return vacio(404);
      if (serial) {
        if (!(await autorizado(serial))) return vacio(401);
        if (req.method === 'POST') {
          const b = await req.json().catch(() => null);
          if (typeof b?.pushToken !== 'string' || b.pushToken.length > 200) return vacio(400);
          const r = await d.rpc('club_wallet_registrar', { device_library_id: dli, serial, push_token: b.pushToken });
          return vacio(r?.ok ? (r.nuevo ? 201 : 200) : 401);
        }
        if (req.method === 'DELETE') { await d.rpc('club_wallet_baja', { device_library_id: dli, serial }); return vacio(200); }
        return vacio(405);
      }
      if (req.method !== 'GET') return vacio(405);
      const desde = url.searchParams.get('passesUpdatedSince');
      const r = await d.rpc('club_wallet_seriales', { device_library_id: dli, desde: desde && /^\d{1,16}$/.test(desde) ? Number(desde) : null });
      if (!r?.serials?.length) return vacio(204);
      return new Response(JSON.stringify({ serialNumbers: r.serials, lastUpdated: String(r.ultimo) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (partes[1] === 'passes' && req.method === 'GET') {
      const [, , pt, serial] = partes;
      if (pt !== apple.apple.passTypeId) return vacio(404);
      if (!(await autorizado(serial))) return vacio(401);
      const e = await estado(serial);
      if (!e) return vacio(404);
      const ims = Date.parse(req.headers.get('If-Modified-Since') ?? '');
      if (ims && Math.floor(Date.parse(e.actualizado) / 1000) <= Math.floor(ims / 1000)) return vacio(304);
      return pkpassResp(await pkpass(e, apple, d.ahora?.()), e.actualizado);
    }
    return vacio(404);
  }

  /* ---------- el enlace del cliente */
  if (partes[0] === 'p' && req.method === 'GET') {
    const serial = partes[1] ?? '';
    if (!SERIAL.test(serial) || url.searchParams.get('k') !== (await llaveEnlace(cfg.secreto, serial))) return json({ success: false, error: 'Enlace inválido.' }, 404);
    const e = await estado(serial);
    if (!e) return json({ success: false, error: 'Esta tarjeta ya no existe.' }, 404);
    const ua = req.headers.get('User-Agent') ?? '';
    const w = url.searchParams.get('w') ?? (/iPhone|iPad|iPod|Macintosh/.test(ua) ? 'apple' : /Android/.test(ua) ? 'google' : '');
    if (w === 'apple' && cfg.apple) return pkpassResp(await pkpass(e, cfg as ConfigWallet & { apple: ConfigApple }, d.ahora?.()), e.actualizado);
    if (w === 'google' && cfg.google) return new Response(null, { status: 302, headers: { Location: await enlaceGoogle(e, cfg as ConfigWallet & { google: ConfigGoogle }) } });
    /* Sin HTML: Supabase sirve text/html como texto. La página bonita vive en la web; aquí, las dos opciones. */
    const k = url.searchParams.get('k');
    return json({ success: true, negocio: e.negocio,
      apple: cfg.apple ? `${cfg.base}/p/${serial}?k=${k}&w=apple` : null,
      google: cfg.google ? `${cfg.base}/p/${serial}?k=${k}&w=google` : null });
  }

  /* ---------- logo para la clase de Google (público, como cualquier logo) */
  if (partes[0] === 'logo' && req.method === 'GET') {
    const m = /^([0-9a-f-]{36})\.png$/i.exec(partes[1] ?? '');
    const r = m ? await d.rpc('club_wallet_logo', { company_id: m[1] }) : null;
    const png = r?.logo_png ? deB64(r.logo_png) : null;
    return esPng(png) ? new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' } }) : vacio(404);
  }

  if (req.method !== 'POST') return json({ success: false, error: 'Método no permitido.' }, 405);
  const raw = await req.text();
  if (raw.length > 600000) return json({ success: false, error: 'Datos demasiado grandes.' }, 413);
  let b: any; try { b = JSON.parse(raw || '{}'); } catch { return json({ success: false, error: 'Datos inválidos.' }, 400); }

  /* ---------- el ciclo de avisos (pg_cron) */
  if (b.action === 'notificar') {
    const w = await validarWebhook(d.webhookSecret, req.headers.get('x-webhook-secret'));
    if (!w.ok) return json({ success: false, error: 'no autorizado' }, w.status);
    return json({ success: true, ...(await notificar(d)) });
  }

  /* ---------- la caja */
  const eq = await equipoDe(req, d.rpc);
  if (!eq) return negado('BAD_TOKEN');

  if (b.action === 'emitir') {
    const tel = String(b.phone ?? '').replace(/\D/g, '').slice(-10);
    if (tel.length !== 10) return json({ success: false, code: 'BAD_PHONE', error: 'El cliente necesita un teléfono de 10 dígitos para su tarjeta.' }, 400);
    if (!cfg.apple && !cfg.google) return json({ success: false, code: 'WALLET_NOT_CONFIGURED', error: 'La tarjeta en Wallet todavía no está configurada.' }, 503);
    const r = await d.rpc('club_wallet_emitir', { device_id: eq.device_id, serial: nuevoSerial(), phone: tel, customer_name: typeof b.customer_name === 'string' ? b.customer_name.slice(0, 120) : null });
    if (!r?.ok) return negado(r?.code);
    const k = await llaveEnlace(cfg.secreto, r.serial);
    return json({ success: true, serial: r.serial, codigo: codigoDe(r.serial), url: `${cfg.base}/p/${r.serial}?k=${k}`,
      apple: cfg.apple ? `${cfg.base}/p/${r.serial}?k=${k}&w=apple` : null, google: cfg.google ? `${cfg.base}/p/${r.serial}?k=${k}&w=google` : null });
  }

  if (b.action === 'marca') {
    const png = (x: unknown) => (typeof x === 'string' && x.length < 250000 && esPng(deB64(x)) ? x : null);
    if (![b.fondo, b.texto, b.etiqueta].every((c) => typeof c === 'string' && COLOR.test(c))) return json({ success: false, error: 'Colores inválidos.' }, 400);
    const r = await d.rpc('club_wallet_marca', { device_id: eq.device_id, fondo: b.fondo, texto: b.texto, etiqueta: b.etiqueta, logo_png: png(b.logo_png), icon_png: png(b.icon_png) });
    return r?.ok ? json({ success: true }) : negado(r?.code);
  }

  if (b.action === 'resolver') {
    const serial = serialDeCodigo(String(b.codigo ?? ''));
    if (!serial) return json({ success: false, code: 'BAD_CODE', error: 'Ese código no es una tarjeta del Club.' }, 400);
    const r = await d.rpc('club_wallet_resolver', { device_id: eq.device_id, serial });
    if (!r?.ok) return json({ success: false, code: 'NOT_FOUND', error: 'La tarjeta no es de este negocio o ya no existe.' }, 404);
    return json({ success: true, serial, phone: r.phone, customer_name: r.customer_name });
  }

  return json({ success: false, error: 'Acción desconocida.' }, 400);
}

/**
 * Un ciclo: los pases cuyo Club cambió. Se recalcula lo que enseñan; si su
 * huella cambió, se avisa a cada iPhone (APNs) y se actualiza el objeto de
 * Google. Un aviso que falla no frena a los demás.
 */
export async function notificar(d: DepsWallet): Promise<{ revisados: number; cambiados: number; avisos: number; google: number; errores: number }> {
  const cfg = d.cfg!;
  const out = { revisados: 0, cambiados: 0, avisos: 0, google: 0, errores: 0 };
  const r = await d.rpc('club_wallet_pendientes', { limite: 200 });
  let tokenG: string | null = null;
  for (const p of (r?.pases ?? []) as { serial: string; tokens: string[]; visto: string | null }[]) {
    out.revisados++;
    try {
      const e = await d.rpc('club_wallet_estado', { serial: p.serial });
      if (!e?.ok) continue;
      const m = await d.rpc('club_wallet_marcar', { serial: p.serial, huella: await huella(e), visto: p.visto });
      if (!m?.cambio) continue;
      out.cambiados++;
      if (cfg.apple && d.apns) for (const t of p.tokens ?? []) {
        try {
          const a = await d.apns(t, cfg.apple.passTypeId);
          if (a.status === 200) out.avisos++;
          else if (a.status === 410) await d.rpc('club_wallet_baja_token', { push_token: t });
          else out.errores++;
        } catch { out.errores++; }
      }
      if (cfg.google) {
        try {
          tokenG ??= await tokenGoogle(cfg.google, d.fetch);
          if ((await actualizarGoogle({ ...e, actualizado: m.actualizado ?? e.actualizado }, cfg as ConfigWallet & { google: ConfigGoogle }, tokenG, d.fetch)) === 'OK') out.google++;
        } catch { out.errores++; }
      }
    } catch { out.errores++; }
  }
  return out;
}

