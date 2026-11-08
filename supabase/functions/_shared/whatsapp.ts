// ============================================================================
//  AVISOS POR WHATSAPP AL CLIENTE FINAL (migración 20261028140000)
// ----------------------------------------------------------------------------
//  NÚMERO DEL NEGOCIO (opción B): cada negocio conecta su propia cuenta de
//  WhatsApp Business (WABA) con Embedded Signup de Meta; Wybix es Tech
//  Provider. El aviso sale con el nombre y el número del negocio y Meta le
//  factura al negocio.
//
//  Qué avisar, a quién y si ya se avisó vive en Postgres (wa_*). Aquí solo:
//    · la caja encola «pedido listo» y se intenta mandar en el acto, y pide
//      el enlace para conectar su WhatsApp (avisosWhatsapp, whatsapp-avisos);
//    · la página de conexión canjea el código de Meta, registra el número,
//      da de alta las plantillas y guarda el token CIFRADO
//      (conectarWhatsapp, whatsapp-conectar);
//    · el ciclo de cada minuto planea las membresías y manda/reintenta la
//      cola, cada aviso por la cuenta de SU negocio (cicloWhatsApp);
//    · Meta reporta entregado/leído/fallido, bajas, plantillas aprobadas y
//      cuentas desconectadas (webhookWhatsapp, whatsapp-webhook).
//
//  FALLA CERRADO: sin WHATSAPP_PROVEEDOR, sin WHATSAPP_CLAVE_TOKENS o (con
//  Meta) sin los datos de la app, no se conecta ni sale nada.
//
//  Sin nada de Deno: se prueba en Node (test/whatsapp.test.ts).
// ============================================================================
import { CORS, equipoDe, json, negado, type Rpc } from './nube.ts';
import { igualesSeguro } from './webhook.ts';
import type { ResultadoEnvio } from './notificaciones.ts';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Llama a una función con argumentos con nombre (p_id, p_ok...). */
export type RpcArgs = (fn: string, args?: Record<string, unknown>) => Promise<any>;

export function rpcArgsPostgrest(url: string, serviceKey: string, f: Fetch = fetch): RpcArgs {
  return async (fn, args = {}) => {
    const r = await f(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`rpc ${fn}: HTTP ${r.status}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
}

/** Una fila de wa_messages, lo que el proveedor necesita. */
export interface MensajeWa {
  id: number; company_id: string; kind: string; phone: string; template: string; lang: string; params: string[]; attempts: number;
}

/** La cuenta del negocio por la que sale el aviso (token ya descifrado). */
export interface CuentaWa { phone_number_id: string; token: string }

export interface ProveedorWhatsApp {
  nombre: 'meta' | 'simulado';
  enviar(m: MensajeWa, cuenta: CuentaWa): Promise<ResultadoEnvio>;
}

/** El payload del botón «Ya no recibir avisos»: vuelve en el webhook. */
export const payloadBaja = (id: number) => `BAJA:${id}`;

// -------------------------------------------------------------- plantillas
/* Las cuatro plantillas que se dan de alta en la WABA de cada negocio al
   conectar. Categoría Utilidad, es_MX. El texto es el de
   docs/whatsapp-avisos.md: cambiar uno obliga a cambiar el otro. */
export const PIE_PLANTILLA = 'Responde BAJA si ya no quieres recibir estos avisos.';
export const BOTON_BAJA = 'Ya no recibir avisos';
export const PLANTILLAS: ReadonlyArray<{ nombre: string; cuerpo: string; ejemplo: string[] }> = [
  { nombre: 'wybix_pedido_listo',
    cuerpo: '¡Hola! Tu pedido *#{{1}}* en *{{2}}* ya está listo. Pasa a recogerlo al mostrador.',
    ejemplo: ['27', 'I Do Nut'] },
  { nombre: 'wybix_pedido_listo_seguimiento',
    cuerpo: '¡Hola! Tu pedido *#{{1}}* en *{{2}}* ya está listo. Si estás conectado al Wi-Fi del local, puedes verlo aquí: {{3}} Pasa a recogerlo al mostrador.',
    ejemplo: ['27', 'I Do Nut', 'http://192.168.1.20:8787/p/0123456789ABCDEF0123456789ABCDEF'] },
  { nombre: 'wybix_membresia_por_vencer',
    cuerpo: 'Hola. Tu membresía *{{1}}* en *{{2}}* vence el {{3}}. Para renovarla: {{4}}. Si ya la renovaste, ignora este mensaje.',
    ejemplo: ['Club Donut', 'I Do Nut', '31/10/2026', 'paga tu mensualidad en caja'] },
  { nombre: 'wybix_membresia_vence_hoy',
    cuerpo: 'Hola. Tu membresía *{{1}}* en *{{2}}* vence hoy. Para renovarla: {{3}}. Si ya la renovaste, ignora este mensaje.',
    ejemplo: ['Club Donut', 'I Do Nut', 'paga tu mensualidad en caja'] },
];

export function cuerpoPlantilla(p: (typeof PLANTILLAS)[number]) {
  return {
    name: p.nombre, language: 'es_MX', category: 'UTILITY',
    components: [
      { type: 'BODY', text: p.cuerpo, example: { body_text: [p.ejemplo] } },
      { type: 'FOOTER', text: PIE_PLANTILLA },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: BOTON_BAJA }] },
    ],
  };
}

/* Meta puede pasar una plantilla de Utilidad a Marketing (cuesta ~5×). Esa
   no se usa: queda como MARKETING hasta que alguien la revise. */
const estadoPlantilla = (status: unknown, category: unknown) =>
  category && String(category).toUpperCase() !== 'UTILITY' ? 'MARKETING' : String(status ?? 'PENDING').toUpperCase();

// -------------------------------------------------------------- cifrado
/** AES-256-GCM con la llave WHATSAPP_CLAVE_TOKENS (base64 de 32 bytes). La
 *  llave vive solo en los secretos de las funciones, nunca en la base. */
export interface Cifrador { cifrar(texto: string): Promise<string>; descifrar(c: string): Promise<string> }

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function cifradorDe(claveB64: string | undefined): Promise<Cifrador | null> {
  let bytes: Uint8Array;
  try { bytes = deB64((claveB64 ?? '').trim()); } catch { return null; }
  if (bytes.length !== 32) return null;
  const k = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return {
    async cifrar(texto) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(texto)));
      return `v1.${b64(iv)}.${b64(c)}`;
    },
    async descifrar(s) {
      const [v, iv, c] = String(s).split('.');
      if (v !== 'v1' || !iv || !c) throw new Error('cifrado desconocido');
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(iv) }, k, deB64(c)));
    },
  };
}

async function sha256Hex(texto: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto)));
  return Array.from(d, (v) => v.toString(16).padStart(2, '0')).join('');
}

const aleatorioHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (v) => v.toString(16).padStart(2, '0')).join('');

// ------------------------------------------------------------ Graph de Meta
/** Lo que Wybix le pide a Meta sobre la cuenta de un negocio. */
export interface GrafoWhatsApp {
  nombre: 'meta' | 'simulado';
  canjear(code: string): Promise<string>;
  suscribir(waba: string, token: string): Promise<void>;
  dessuscribir(waba: string, token: string): Promise<void>;
  registrar(numero: string, token: string, pin: string): Promise<void>;
  numero(numero: string, token: string): Promise<{ telefono: string | null; nombre: string | null }>;
  plantillas(waba: string, token: string): Promise<Record<string, string>>;
  crearPlantilla(waba: string, token: string, p: (typeof PLANTILLAS)[number]): Promise<string>;
}

export class ErrorMeta extends Error {
  status: number; codigo: number;
  constructor(status: number, codigo: number, mensaje: string) { super(mensaje); this.status = status; this.codigo = codigo; }
}

export function grafoMeta(f: Fetch, app: { id: string; secreto: string }, version = 'v23.0'): GrafoWhatsApp {
  const base = `https://graph.facebook.com/${version}`;
  const llamar = async (ruta: string, token: string | null, init: RequestInit = {}) => {
    const r = await f(`${base}${ruta}`, {
      ...init,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) {
      throw new ErrorMeta(r.status, Number(j?.error?.code ?? 0), `meta ${r.status}${j?.error?.code ? ` #${j.error.code}` : ''}: ${String(j?.error?.error_user_msg ?? j?.error?.message ?? '').slice(0, 200)}`);
    }
    return j;
  };
  const id = encodeURIComponent;
  return {
    nombre: 'meta',
    async canjear(code) {
      const q = new URLSearchParams({ client_id: app.id, client_secret: app.secreto, code });
      const j = await llamar(`/oauth/access_token?${q}`, null);
      if (typeof j?.access_token !== 'string' || j.access_token.length < 20) throw new ErrorMeta(502, 0, 'Meta no devolvió el token del negocio.');
      return j.access_token;
    },
    async suscribir(waba, token) { await llamar(`/${id(waba)}/subscribed_apps`, token, { method: 'POST' }); },
    async dessuscribir(waba, token) { await llamar(`/${id(waba)}/subscribed_apps`, token, { method: 'DELETE' }); },
    async registrar(numero, token, pin) {
      await llamar(`/${id(numero)}/register`, token, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', pin }) });
    },
    async numero(numero, token) {
      const j = await llamar(`/${id(numero)}?fields=display_phone_number,verified_name`, token);
      return { telefono: j?.display_phone_number ?? null, nombre: j?.verified_name ?? null };
    },
    async plantillas(waba, token) {
      const j = await llamar(`/${id(waba)}/message_templates?fields=name,status,category,language&limit=200`, token);
      const nuestras = new Set(PLANTILLAS.map((p) => p.nombre));
      const out: Record<string, string> = {};
      for (const t of Array.isArray(j?.data) ? j.data : []) {
        if (nuestras.has(t?.name) && (t?.language ?? 'es_MX') === 'es_MX') out[t.name] = estadoPlantilla(t.status, t.category);
      }
      return out;
    },
    async crearPlantilla(waba, token, p) {
      const j = await llamar(`/${id(waba)}/message_templates`, token, { method: 'POST', body: JSON.stringify(cuerpoPlantilla(p)) });
      return estadoPlantilla(j?.status, j?.category);
    },
  };
}

/** Graph de pruebas: «conecta» sin salir a internet; las plantillas quedan
 *  aprobadas al momento (o como diga `estadoPlantillas`). */
export function grafoSimulado(o: { estadoPlantillas?: string; fallar?: Partial<Record<keyof GrafoWhatsApp, string>> } = {}) {
  const creadas = new Map<string, Record<string, string>>();
  const llamadas: string[] = [];
  const paso = (n: keyof GrafoWhatsApp) => { llamadas.push(n); if (o.fallar?.[n]) throw new ErrorMeta(400, 100, o.fallar[n]!); };
  const g: GrafoWhatsApp & { llamadas: string[]; creadas: typeof creadas } = {
    nombre: 'simulado', llamadas, creadas,
    async canjear(code) { paso('canjear'); return `sim-token-${code}-${'x'.repeat(20)}`; },
    async suscribir() { paso('suscribir'); },
    async dessuscribir() { paso('dessuscribir'); },
    async registrar() { paso('registrar'); },
    async numero(numero) { paso('numero'); return { telefono: `+52 55 0000 ${numero.slice(-4)}`, nombre: 'Negocio de prueba' }; },
    async plantillas(waba) { paso('plantillas'); return { ...(creadas.get(waba) ?? {}) }; },
    async crearPlantilla(waba, _t, p) {
      paso('crearPlantilla');
      const e = o.estadoPlantillas ?? 'APPROVED';
      creadas.set(waba, { ...(creadas.get(waba) ?? {}), [p.nombre]: e });
      return e;
    },
  };
  return g;
}

/** Da de alta lo que falte de las cuatro plantillas y devuelve el estado de
 *  todas. Una que no se pudo crear queda NO_CREADA (se reintenta al refrescar). */
export async function asegurarPlantillas(g: GrafoWhatsApp, waba: string, token: string, log?: (m: string) => void): Promise<Record<string, string>> {
  const estado = await g.plantillas(waba, token);
  for (const p of PLANTILLAS) {
    if (estado[p.nombre] && estado[p.nombre] !== 'NO_CREADA') continue;
    try { estado[p.nombre] = await g.crearPlantilla(waba, token, p); }
    catch (e) { estado[p.nombre] = 'NO_CREADA'; log?.(`plantilla ${p.nombre}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return estado;
}

// ------------------------------------------------------------------- Meta
/* Códigos de error de la Cloud API que NO mejoran reintentando: número que no
   tiene WhatsApp, plantilla inexistente/pausada/con parámetros mal, número
   del negocio no registrado. Lo demás (límites 130429/131056/80007, 5xx) se
   reintenta con espera. 190 = token del negocio inválido: la cuenta pasa a
   ERROR y el negocio la vuelve a conectar. */
const META_PERMANENTES = new Set([100, 131008, 131009, 131021, 131026, 131030, 131031, 131051, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 133010]);

export function whatsappMeta(f: Fetch, version = 'v23.0'): ProveedorWhatsApp {
  return {
    nombre: 'meta',
    async enviar(m, cuenta) {
      const cuerpo = {
        messaging_product: 'whatsapp', recipient_type: 'individual', to: m.phone, type: 'template',
        template: {
          name: m.template, language: { code: m.lang || 'es_MX' },
          components: [
            { type: 'body', parameters: m.params.map((text) => ({ type: 'text', text: String(text) })) },
            { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: payloadBaja(m.id) }] },
          ],
        },
        biz_opaque_callback_data: `wybix-${m.id}`,
      };
      const r = await f(`https://graph.facebook.com/${version}/${encodeURIComponent(cuenta.phone_number_id)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cuenta.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.messages?.[0]?.id) return { ok: true, ref: String(j.messages[0].id) };
      const code = Number(j?.error?.code ?? 0);
      const error = `meta ${r.status}${code ? ` #${code}` : ''}: ${String(j?.error?.message ?? '').slice(0, 200)}`;
      return { ok: false, error, permanente: META_PERMANENTES.has(code), tokenInvalido: code === 190 };
    },
  };
}

// --------------------------------------------------------------- simulado
/** Proveedor de pruebas: no sale nada a internet. Guarda lo «enviado» y por
 *  qué número del negocio salió. */
export function whatsappSimulado(opciones: { fallar?: (m: MensajeWa) => ResultadoEnvio | null } = {}) {
  const enviados: Array<MensajeWa & { desde: string }> = [];
  const p: ProveedorWhatsApp & { enviados: typeof enviados } = {
    nombre: 'simulado',
    enviados,
    async enviar(m, cuenta) {
      const f = opciones.fallar?.(m);
      if (f) return f;
      enviados.push({ ...m, desde: cuenta.phone_number_id });
      return { ok: true, ref: `sim-${m.id}` };
    },
  };
  return p;
}

// ---------------------------------------------------------------- entorno
/** Todo lo que piden las funciones, desde los secretos. */
export interface EntornoWa {
  wa: ProveedorWhatsApp | null;
  grafo: GrafoWhatsApp | null;
  clave: Cifrador | null;
  /** Para la página de conexión (Embedded Signup). */
  app: { id: string; configId: string; version: string } | null;
  conectarUrl: string;
}

/**
 *   WHATSAPP_PROVEEDOR      meta | simulado (pruebas: nada sale a internet)
 *   WHATSAPP_CLAVE_TOKENS   base64 de 32 bytes: cifra los tokens de los negocios
 *   WHATSAPP_APP_ID         app de Meta de Wybix (Tech Provider)       [meta]
 *   WHATSAPP_APP_SECRET     su secreto: canje del código y firma webhook [meta]
 *   WHATSAPP_CONFIG_ID      configuración de Embedded Signup           [meta]
 *   WHATSAPP_CONECTAR_URL   la página de conexión (opcional)
 *   WHATSAPP_GRAPH_VERSION  opcional (v23.0)
 * Falta algo -> el proveedor (y el grafo) quedan en null. Nunca hay un
 * proveedor «por defecto».
 */
export async function entornoWhatsapp(env: (k: string) => string | undefined, f: Fetch = fetch): Promise<EntornoWa> {
  const tipo = (env('WHATSAPP_PROVEEDOR') ?? '').trim().toLowerCase();
  const clave = await cifradorDe(env('WHATSAPP_CLAVE_TOKENS'));
  const version = (env('WHATSAPP_GRAPH_VERSION') ?? '').trim() || 'v23.0';
  const conectarUrl = (env('WHATSAPP_CONECTAR_URL') ?? '').trim() || 'https://wybix-landing.vercel.app/whatsapp/conectar';
  const nada: EntornoWa = { wa: null, grafo: null, clave, app: null, conectarUrl };
  if (!clave) return nada;
  if (tipo === 'simulado') return { wa: whatsappSimulado(), grafo: grafoSimulado(), clave, app: { id: 'simulado', configId: 'simulado', version }, conectarUrl };
  if (tipo !== 'meta') return nada;
  const id = (env('WHATSAPP_APP_ID') ?? '').trim(), secreto = (env('WHATSAPP_APP_SECRET') ?? '').trim(), configId = (env('WHATSAPP_CONFIG_ID') ?? '').trim();
  if (!/^\d{5,25}$/.test(id) || secreto.length < 16 || !/^\d{5,25}$/.test(configId)) return nada;
  return { wa: whatsappMeta(f, version), grafo: grafoMeta(f, { id, secreto }, version), clave, app: { id, configId, version }, conectarUrl };
}

// ------------------------------------------------------------------ envío
const aMensaje = (x: any): MensajeWa => ({
  id: Number(x.id), company_id: String(x.company_id), kind: String(x.kind), phone: String(x.phone), template: String(x.template),
  lang: String(x.lang || 'es_MX'), params: Array.isArray(x.params) ? x.params.map(String) : [], attempts: Number(x.attempts) || 0,
});

/** La cuenta de cada negocio, descifrada una vez por ciclo. */
function cuentas(rpc: RpcArgs, clave: Cifrador) {
  const cache = new Map<string, Promise<CuentaWa | null>>();
  return (company: string) => {
    if (!cache.has(company)) {
      cache.set(company, (async () => {
        const c = await rpc('wa_credencial', { p_company: company });
        if (c?.status !== 'ACTIVA' || !c.token_cifrado) return null;
        try { return { phone_number_id: String(c.phone_number_id), token: await clave.descifrar(c.token_cifrado) }; }
        catch { return null; }   // otra llave: como si no hubiera cuenta
      })());
    }
    return cache.get(company)!;
  };
}

async function mandar(rpc: RpcArgs, wa: ProveedorWhatsApp, m: MensajeWa, cuenta: CuentaWa | null): Promise<boolean> {
  let r: ResultadoEnvio;
  if (!cuenta) r = { ok: false, error: 'SIN_NUMERO', permanente: true };
  else {
    try { r = await wa.enviar(m, cuenta); }
    catch (e) { r = { ok: false, error: `whatsapp: ${e instanceof Error ? e.message : String(e)}`, permanente: false }; }
  }
  if (r.ok) await rpc('wa_resultado', { p_id: m.id, p_ok: true, p_ref: r.ref, p_proveedor: wa.nombre });
  else {
    await rpc('wa_resultado', { p_id: m.id, p_ok: false, p_error: r.error, p_permanente: r.permanente, p_proveedor: wa.nombre });
    if (r.tokenInvalido) await rpc('wa_cuenta_estado', { p_company: m.company_id, p_status: 'ERROR', p_error: 'Meta rechazó el token: vuelve a conectar WhatsApp.' });
  }
  return r.ok;
}

export interface ResumenWa { planeados: number; ok: number; fallo: number }

/** Un ciclo: planear membresías, tomar la cola, mandar y reportar. */
export async function cicloWhatsApp(d: { rpc: RpcArgs; wa: ProveedorWhatsApp | null; clave: Cifrador | null; limite?: number }): Promise<ResumenWa> {
  const res: ResumenWa = { planeados: 0, ok: 0, fallo: 0 };
  /* Sin proveedor o sin llave no se planea: lo planeado solo esperaría para vencer. */
  if (!d.wa || !d.clave) return res;
  res.planeados = Number(await d.rpc('wa_planear_membresias', { p_forzar: false })) || 0;
  const cuentaDe = cuentas(d.rpc, d.clave);
  const lote = ((await d.rpc('wa_tomar', { p_limite: d.limite ?? 50 })) ?? []).map(aMensaje);
  for (const m of lote) { if (await mandar(d.rpc, d.wa, m, await cuentaDe(m.company_id))) res.ok++; else res.fallo++; }
  return res;
}

// ------------------------------------------------- función whatsapp-avisos
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MENSAJES: Record<string, string> = {
  DESACTIVADO: 'El aviso de pedido listo está apagado para este negocio.',
  SIN_NUMERO: 'El WhatsApp del negocio no está conectado.',
  PLANTILLA_PENDIENTE: 'Meta todavía no aprueba la plantilla de este aviso.',
  OPT_OUT: 'Este cliente pidió no recibir avisos por WhatsApp.',
  TEL_INVALIDO: 'El teléfono del cliente no es válido para WhatsApp.',
  RATE_LIMIT: 'Se alcanzó el límite por hora.',
  NOT_PRIMARY: 'Solo la caja principal cambia los avisos por WhatsApp.',
  NO_CONFIGURADO: 'WhatsApp todavía no está habilitado en Wybix.',
};

const listoParaConectar = (e: EntornoWa) => !!(e.clave && e.grafo && e.app);

/**
 * La caja (credencial del equipo). Acciones:
 *   config        { accion: 'leer' | 'guardar', config? }
 *   conexion      { accion: 'iniciar' | 'estado' | 'desconectar' }
 *   pedido_listo  { id, numero, telefono, url? }  encola y manda en el acto
 *   registro      { limite? }
 *   telefono      { accion: 'baja' | 'alta' | 'estado_tel', telefono }
 * La empresa SIEMPRE sale del equipo, nunca del cuerpo.
 */
export async function avisosWhatsapp(req: Request, deps: { rpc: Rpc; rpcArgs: RpcArgs; entorno: EntornoWa; log?: (m: string) => void }): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'Método no permitido.' }, 405);
  const eq = await equipoDe(req, deps.rpc);
  if (!eq) return negado('BAD_TOKEN');
  const raw = await req.text();
  if (raw.length > 8000) return json({ success: false, error: 'Petición demasiado grande.' }, 413);
  let b: any;
  try { b = JSON.parse(raw); } catch { return json({ success: false, error: 'Datos inválidos.' }, 400); }
  const base = { device_id: eq.device_id };
  const { wa, clave, grafo } = deps.entorno;
  const proveedor = wa && clave ? wa.nombre : null;
  const noPrincipal = () => json({ success: false, code: 'NOT_PRIMARY', error: MENSAJES.NOT_PRIMARY }, 403);

  if (b?.action === 'config') {
    const r = await deps.rpc('wa_config', { ...base, accion: b.accion === 'guardar' ? 'guardar' : 'leer', config: b.config ?? null });
    if (!r?.ok) return r?.code === 'NOT_PRIMARY' ? noPrincipal() : negado(r?.code);
    return json({ success: true, config: r.config, principal: r.principal, cuenta: r.cuenta, proveedor, conectable: listoParaConectar(deps.entorno) });
  }

  if (b?.action === 'conexion') {
    const accion = ['iniciar', 'estado', 'desconectar'].includes(b.accion) ? b.accion : null;
    if (!accion) return json({ success: false, error: 'Acción desconocida.' }, 400);
    if (accion === 'iniciar') {
      if (!listoParaConectar(deps.entorno)) return json({ success: false, code: 'NO_CONFIGURADO', error: MENSAJES.NO_CONFIGURADO }, 503);
      /* El enlace lleva el secreto en el fragmento (#): no llega a ningún servidor ni a los registros. */
      const t = aleatorioHex(32);
      const r = await deps.rpc('wa_conexion', { ...base, accion, token_hash: await sha256Hex(t) });
      if (r?.code === 'NOT_PRIMARY') return noPrincipal();
      if (r?.code === 'RATE_LIMIT') return json({ success: false, code: r.code, error: 'Demasiados intentos de conexión. Espera una hora.' }, 429);
      if (!r?.ok) return negado(r?.code);
      return json({ success: true, url: `${deps.entorno.conectarUrl}#t=${t}`, vence_min: 30 });
    }
    if (accion === 'desconectar') {
      const r0 = await deps.rpc('wa_conexion', { ...base, accion: 'estado' });
      if (!r0?.ok) return negado(r0?.code);
      if (!r0.principal) return noPrincipal();
      /* Que Meta deje de mandarnos eventos de esa WABA. Si falla, se desconecta igual. */
      const c = await deps.rpcArgs('wa_credencial', { p_company: r0.company_id });
      if (c?.token_cifrado && clave && grafo) {
        try { await grafo.dessuscribir(c.waba_id, await clave.descifrar(c.token_cifrado)); }
        catch (e) { deps.log?.(`dessuscribir: ${e instanceof Error ? e.message : String(e)}`); }
      }
      const r = await deps.rpc('wa_conexion', { ...base, accion });
      if (!r?.ok) return negado(r?.code);
      return json({ success: true, cuenta: r.cuenta });
    }
    // estado: si hay plantillas sin decisión de Meta, se pregunta (y se crean las que falten).
    let r = await deps.rpc('wa_conexion', { ...base, accion: 'estado' });
    if (!r?.ok) return negado(r?.code);
    const pendientes = Object.values(r.cuenta?.plantillas ?? {}).some((s) => s === 'PENDING' || s === 'NO_CREADA')
      || (r.cuenta && Object.keys(r.cuenta.plantillas ?? {}).length < PLANTILLAS.length);
    if (r.cuenta?.status === 'ACTIVA' && pendientes && clave && grafo) {
      const c = await deps.rpcArgs('wa_credencial', { p_company: r.company_id });
      try {
        const estado = await asegurarPlantillas(grafo, c.waba_id, await clave.descifrar(c.token_cifrado), deps.log);
        await deps.rpcArgs('wa_cuenta_plantillas', { p_company: r.company_id, p_plantillas: estado });
        r = await deps.rpc('wa_conexion', { ...base, accion: 'estado' });
      } catch (e) { deps.log?.(`plantillas: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return json({ success: true, cuenta: r.cuenta, principal: r.principal, conectable: listoParaConectar(deps.entorno) });
  }

  if (b?.action === 'pedido_listo') {
    if (!UUID.test(b.id ?? '') || !Number.isSafeInteger(b.numero) || typeof b.telefono !== 'string' || b.telefono.length > 30
        || (b.url != null && (typeof b.url !== 'string' || b.url.length > 200))) {
      return json({ success: false, error: 'Datos del aviso inválidos.' }, 400);
    }
    const r = await deps.rpc('wa_pedido_listo', { ...base, id: b.id, numero: b.numero, telefono: b.telefono, url: b.url ?? null });
    if (r?.code === 'DENIED') return negado('DENIED');
    if (r?.code === 'BAD_REQUEST') return json({ success: false, code: r.code, error: 'Datos del aviso inválidos.' }, 400);
    /* Lo que no va a salir (apagado, sin número, baja, teléfono malo) no es un
       error de red: la caja lo anota como OMITIDO y no reintenta. */
    if (!r?.ok) return json({ success: true, code: r?.code, enviado: false, error: MENSAJES[r?.code] ?? 'No se encoló el aviso.' });
    let estado = r.status ?? 'PENDING';
    if (r.code === 'ENCOLADO' && wa && clave) {
      const tomado = ((await deps.rpcArgs('wa_tomar_uno', { p_id: r.message_id })) ?? []).map(aMensaje);
      if (tomado.length) estado = (await mandar(deps.rpcArgs, wa, tomado[0], await cuentas(deps.rpcArgs, clave)(tomado[0].company_id))) ? 'SENT' : 'PENDING';
    }
    return json({ success: true, code: r.code, enviado: true, message_id: r.message_id, status: estado, proveedor });
  }

  if (b?.action === 'registro') {
    const r = await deps.rpc('wa_caja', { ...base, accion: 'registro', limite: Number(b.limite) || 100 });
    if (!r?.ok) return negado(r?.code);
    return json({ success: true, resumen: r.resumen, bajas: r.bajas, avisos: r.avisos, proveedor });
  }

  if (b?.action === 'telefono') {
    const accion = ['baja', 'alta', 'estado_tel'].includes(b.accion) ? b.accion : null;
    if (!accion || typeof b.telefono !== 'string' || b.telefono.length > 30) return json({ success: false, error: 'Indica el teléfono.' }, 400);
    const r = await deps.rpc('wa_caja', { ...base, accion, telefono: b.telefono });
    if (r?.code === 'TEL_INVALIDO') return json({ success: false, code: r.code, error: MENSAJES.TEL_INVALIDO }, 400);
    if (!r?.ok) return negado(r?.code);
    return json({ success: true, baja: !!r.baja });
  }

  return json({ success: false, error: 'Acción desconocida.' }, 400);
}

// ----------------------------------------------- función whatsapp-conectar
const ERRORES_CONEXION: Record<string, string> = {
  ENLACE_VENCIDO: 'Este enlace ya no sirve. Pide uno nuevo desde la caja (Configuración → Avisos por WhatsApp).',
  NUMERO_OCUPADO: 'Ese número de WhatsApp ya está conectado a otro negocio en Wybix.',
  NO_CONFIGURADO: 'WhatsApp todavía no está habilitado en Wybix.',
};

/**
 * La página «Conectar WhatsApp» (sin sesión: la autoriza el enlace de un
 * solo uso que generó la caja principal). Acciones:
 *   sesion     { t }                                -> negocio y datos para FB.login
 *   finalizar  { t, code, waba_id, phone_number_id } -> canje, suscripción,
 *              registro del número, plantillas y cuenta guardada.
 */
export async function conectarWhatsapp(req: Request, deps: { rpcArgs: RpcArgs; entorno: EntornoWa; log?: (m: string) => void }): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'Método no permitido.' }, 405);
  const { grafo, clave, app } = deps.entorno;
  if (!grafo || !clave || !app) return json({ success: false, code: 'NO_CONFIGURADO', error: ERRORES_CONEXION.NO_CONFIGURADO }, 503);
  const raw = await req.text();
  if (raw.length > 4000) return json({ success: false, error: 'Petición demasiado grande.' }, 413);
  let b: any;
  try { b = JSON.parse(raw); } catch { return json({ success: false, error: 'Datos inválidos.' }, 400); }
  if (typeof b?.t !== 'string' || !/^[0-9a-f]{64}$/.test(b.t)) return json({ success: false, code: 'ENLACE_VENCIDO', error: ERRORES_CONEXION.ENLACE_VENCIDO }, 401);
  const hash = await sha256Hex(b.t);
  const fallo = (code: string, status = 400) => json({ success: false, code, error: ERRORES_CONEXION[code] ?? 'No se pudo conectar.' }, status);

  const s = await deps.rpcArgs('wa_conexion_sesion', { p_hash: hash });
  if (!s?.ok) return fallo('ENLACE_VENCIDO', 401);

  if (b.action === 'sesion') {
    return json({ success: true, negocio: s.negocio, cuenta: s.cuenta, modo: grafo.nombre, app_id: app.id, config_id: app.configId, graph_version: app.version });
  }
  if (b.action !== 'finalizar') return json({ success: false, error: 'Acción desconocida.' }, 400);

  const waba = String(b.waba_id ?? ''), numero = String(b.phone_number_id ?? ''), code = String(b.code ?? '');
  if (!/^\d{5,25}$/.test(waba) || !/^\d{5,25}$/.test(numero) || code.length < 10 || code.length > 2000) {
    return json({ success: false, error: 'Meta no devolvió los datos de la cuenta. Vuelve a intentarlo.' }, 400);
  }
  let paso = 'canjear';
  try {
    const token = await grafo.canjear(code);
    paso = 'suscribir'; await grafo.suscribir(waba, token);
    /* PIN de verificación en dos pasos del número: lo pone Wybix y se guarda
       cifrado (hace falta para volver a registrarlo). */
    const pin = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    paso = 'registrar'; await grafo.registrar(numero, token, pin);
    paso = 'numero'; const datos = await grafo.numero(numero, token);
    paso = 'plantillas'; const plantillas = await asegurarPlantillas(grafo, waba, token, deps.log);
    const r = await deps.rpcArgs('wa_conexion_guardar', {
      p_hash: hash, p_waba: waba, p_numero: numero, p_telefono: datos.telefono, p_nombre: datos.nombre,
      p_token_cifrado: await clave.cifrar(token), p_pin_cifrado: await clave.cifrar(pin), p_plantillas: plantillas,
    });
    if (!r?.ok) return fallo(r?.code ?? 'ERROR', r?.code === 'ENLACE_VENCIDO' ? 401 : 409);
    return json({ success: true, cuenta: r.cuenta });
  } catch (e) {
    deps.log?.(`${paso}: ${e instanceof Error ? e.message : String(e)}`);
    const detalle = e instanceof ErrorMeta ? e.message : 'error de red';
    return json({ success: false, code: 'META', paso, error: `Meta no completó la conexión (${paso}). ${detalle}` }, 502);
  }
}

// ------------------------------------------------ función whatsapp-webhook
async function hmacHex(secreto: string, cuerpo: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(cuerpo)));
  return Array.from(s, (v) => v.toString(16).padStart(2, '0')).join('');
}

const PALABRAS_BAJA = /^\s*(baja|alto|stop|cancelar|no más avisos|no mas avisos)\s*[.!]*\s*$/i;
const PALABRAS_ALTA = /^\s*(alta|reanudar)\s*[.!]*\s*$/i;
/* account_update que dejan a Wybix sin acceso a la WABA del negocio. */
const CUENTA_FUERA: Record<string, 'DESCONECTADA' | 'ERROR'> = { PARTNER_REMOVED: 'DESCONECTADA', ACCOUNT_DELETED: 'DESCONECTADA', DISABLED_UPDATE: 'ERROR' };

/**
 * El webhook de Meta (uno para todas las WABA de los negocios: Meta lo manda
 * al webhook de la app de Wybix).
 *   GET   verificación (hub.verify_token = WHATSAPP_VERIFY_TOKEN).
 *   POST  firmado con X-Hub-Signature-256 = HMAC-SHA256(WHATSAPP_APP_SECRET, cuerpo).
 * Campos: messages (estados, bajas), message_template_status_update,
 * account_update. Sin secretos (o cortos) responde 503 a todo: falla cerrado.
 * Siempre 200 a un POST firmado aunque algo no se entienda: Meta reintenta lo
 * que no recibe 200 y no hay nada que ganar repitiendo un evento raro.
 */
export async function webhookWhatsapp(req: Request, deps: { appSecret?: string; verifyToken?: string; rpc: Rpc; rpcArgs: RpcArgs; log?: (m: string) => void }): Promise<Response> {
  const secreto = (deps.appSecret ?? '').trim(), verifica = (deps.verifyToken ?? '').trim();
  if (secreto.length < 16 || verifica.length < 16) return new Response('no configurado', { status: 503 });

  if (req.method === 'GET') {
    const u = new URL(req.url);
    const ok = u.searchParams.get('hub.mode') === 'subscribe' && await igualesSeguro(verifica, u.searchParams.get('hub.verify_token') ?? '');
    return ok ? new Response(u.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('prohibido', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('método no permitido', { status: 405 });

  const raw = await req.text();
  if (raw.length > 1_000_000) return new Response('demasiado grande', { status: 413 });
  const firma = (req.headers.get('x-hub-signature-256') ?? '').replace(/^sha256=/i, '');
  if (!firma || !(await igualesSeguro(await hmacHex(secreto, raw), firma.toLowerCase()))) return new Response('firma inválida', { status: 401 });

  let b: any;
  try { b = JSON.parse(raw); } catch { return new Response('ok', { status: 200 }); }
  const res = { estados: 0, bajas: 0, altas: 0, plantillas: 0, cuentas: 0 };
  const intenta = async (que: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { deps.log?.(`${que}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  for (const entry of Array.isArray(b?.entry) ? b.entry : []) {
    const waba = String(entry?.id ?? '');
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = ch?.value ?? {};
      if (ch?.field === 'message_template_status_update') {
        const nombre = String(v.message_template_name ?? ''), evento = String(v.event ?? '').toUpperCase();
        if (nombre && evento && (v.message_template_language ?? 'es_MX') === 'es_MX') {
          await intenta('plantilla', async () => { await deps.rpcArgs('wa_cuenta_plantillas', { p_waba: waba, p_plantillas: { [nombre]: evento } }); res.plantillas++; });
        }
        continue;
      }
      if (ch?.field === 'account_update') {
        const nuevo = CUENTA_FUERA[String(v.event ?? '').toUpperCase()];
        if (nuevo) await intenta('cuenta', async () => { await deps.rpcArgs('wa_cuenta_estado', { p_waba: waba, p_status: nuevo, p_error: `Meta: ${v.event}` }); res.cuentas++; });
        continue;
      }
      const numeroNegocio = String(v.metadata?.phone_number_id ?? '');
      for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
        await intenta('estado', async () => {
          const err = Array.isArray(s.errors) && s.errors[0] ? `#${s.errors[0].code ?? ''} ${String(s.errors[0].title ?? s.errors[0].message ?? '').slice(0, 200)}` : null;
          await deps.rpcArgs('wa_estado', { p_ref: String(s.id ?? ''), p_estado: String(s.status ?? ''), p_error: err });
          res.estados++;
        });
      }
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        await intenta('mensaje', async () => {
          const de = String(m.from ?? '');
          const payload = m.type === 'button' ? String(m.button?.payload ?? '')
            : m.type === 'interactive' ? String(m.interactive?.button_reply?.id ?? '') : '';
          const texto = m.type === 'text' ? String(m.text?.body ?? '') : '';
          const boton = /^BAJA:(\d{1,18})$/.exec(payload);
          const base = { phone: de, phone_number_id: numeroNegocio };
          if (boton) { await deps.rpc('wa_baja', { ...base, message_id: Number(boton[1]), source: 'BOTON' }); res.bajas++; }
          else if (PALABRAS_BAJA.test(texto)) { await deps.rpc('wa_baja', { ...base, source: 'TEXTO' }); res.bajas++; }
          else if (PALABRAS_ALTA.test(texto)) { await deps.rpc('wa_baja', { ...base, source: 'TEXTO', alta: true }); res.altas++; }
        });
      }
    }
  }
  return new Response(JSON.stringify({ ok: true, ...res }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
