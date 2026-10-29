// ============================================================================
//  menu-publico: la página del menú en el celular del cliente (POS 0067)
// ----------------------------------------------------------------------------
//  Sin credencial: la usa cualquiera que escanee el QR. Por eso solo hay:
//
//    GET  ?slug=<s>                    el menú publicado y si recibe pedidos
//    GET  ?slug=<s>&img=<id>[&v=<n>]   la miniatura de un producto
//    GET  ?slug=<s>&foto=<clave>[&v=<n>] una foto grande (0070): portada, logo, promo-<id>, producto-<id>
//    GET  ?pedido=<token>              el estado de UN pedido (token de 128 bits)
//    POST { slug, cliente_nombre, cliente_telefono, nota?, origen?, idem, lineas }
//
//  Todo lo decide Postgres (20261028130000_menu_en_linea.sql): el precio sale
//  del catálogo publicado, no del cuerpo. Aquí solo se acota la entrada y la IP
//  se convierte en hash (con sal) antes de salir de la función.
//
//  Este módulo no importa nada de Deno: scripts/probar-menu-en-linea.mjs lo prueba.
// ============================================================================
import type { Rpc } from './nube.ts';

export interface DepsMenu {
  rpc: Rpc;
  /** sha-256 en hex. */
  hash(texto: string): Promise<string>;
  /** Sal del hash de la IP (secret MENU_IP_SALT). */
  sal: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const TOKEN = /^[0-9a-f]{32}$/;
const MAX_CUERPO = 16384;

const CABECERAS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const responder = (b: unknown, s = 200, cache = 'no-store') =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CABECERAS, 'Cache-Control': cache } });

const MENSAJES: Record<string, string> = {
  NOT_FOUND: 'Este menú no existe o ya no está publicado.',
  CLOSED: 'Por ahora este negocio no está recibiendo pedidos en línea.',
  BAD_NAME: 'Escribe tu nombre para que te llamen al recoger.',
  BAD_PHONE: 'Escribe tu teléfono a 10 dígitos.',
  BAD_REQUEST: 'Revisa tu pedido: algo no está completo.',
  BAD_OPTIONS: 'Elige las opciones que pide cada producto.',
  UNAVAILABLE: 'Uno de los productos ya no está disponible. Revisa tu pedido.',
  RATE_LIMIT: 'Ya tienes pedidos en espera. Espera a que el negocio los atienda.',
  BUSY: 'El negocio tiene muchos pedidos en este momento. Intenta en unos minutos.',
};
const fallo = (r: any, s = 409) => responder({ success: false, code: r?.code ?? 'DENIED', error: MENSAJES[r?.code] ?? 'No se pudo completar.',
  linea: r?.linea ?? null, grupo: r?.grupo ?? null }, r?.code === 'NOT_FOUND' ? 404 : s);

const str = (v: unknown, max: number) => (v == null ? null : String(v).slice(0, max));

/** La IP del cliente: la primera de x-forwarded-for (la pone el proxy). */
export function ipDe(req: Request): string {
  const xff = req.headers.get('x-forwarded-for') ?? '';
  return (xff.split(',')[0] || req.headers.get('x-real-ip') || '').trim();
}

function base64ABytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function manejarMenuPublico(req: Request, deps: DepsMenu): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const pedido = url.searchParams.get('pedido');
    if (pedido != null) {
      if (!TOKEN.test(pedido)) return fallo({ code: 'NOT_FOUND' });
      const r = await deps.rpc('menu_pedido_estado', { token: pedido });
      return r?.ok ? responder({ success: true, ...r, ok: undefined }) : fallo(r);
    }
    const slug = String(url.searchParams.get('slug') ?? '').toLowerCase();
    if (!SLUG.test(slug)) return fallo({ code: 'NOT_FOUND' });
    /* 0070 · Fotos grandes de la plantilla (portada, logo, promos, productos). */
    const foto = url.searchParams.get('foto');
    if (foto != null) {
      if (!/^(portada|logo|promo-[0-9]{1,9}|producto-[0-9]{1,9})$/.test(foto)) return fallo({ code: 'NOT_FOUND' });
      const r = await deps.rpc('menu_foto_publica', { slug, clave: foto });
      if (!r?.ok) return new Response('', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
      const fija = url.searchParams.get('v') === String(r.version);
      return new Response(base64ABytes(String(r.data)), {
        status: 200,
        headers: { 'Content-Type': String(r.mime), 'X-Content-Type-Options': 'nosniff',
                   'Cache-Control': fija ? 'public, max-age=31536000, immutable' : 'public, max-age=300' },
      });
    }
    const img = url.searchParams.get('img');
    if (img != null) {
      if (!/^[0-9]{1,9}$/.test(img)) return fallo({ code: 'NOT_FOUND' });
      const r = await deps.rpc('menu_imagen_publica', { slug, product_id: Number(img) });
      if (!r?.ok) return new Response('', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
      /* Con la versión en la URL la foto no cambia nunca: caché larga. */
      const fija = url.searchParams.get('v') === String(r.version);
      return new Response(base64ABytes(String(r.data)), {
        status: 200,
        headers: { 'Content-Type': String(r.mime), 'X-Content-Type-Options': 'nosniff',
                   'Cache-Control': fija ? 'public, max-age=31536000, immutable' : 'public, max-age=300' },
      });
    }
    const r = await deps.rpc('menu_publico', { slug });
    /* Unos segundos de caché: la disponibilidad cambia, pero no a cada toque. */
    return r?.ok ? responder({ success: true, ...r, ok: undefined }, 200, 'public, max-age=10') : fallo(r);
  }

  if (req.method !== 'POST') return responder({ success: false, error: 'Método no permitido.' }, 405);
  const largo = Number(req.headers.get('content-length') ?? 0);
  if (largo > MAX_CUERPO) return fallo({ code: 'BAD_REQUEST' }, 413);
  const texto = await req.text().catch(() => '');
  if (texto.length > MAX_CUERPO) return fallo({ code: 'BAD_REQUEST' }, 413);
  let body: any;
  try { body = JSON.parse(texto); } catch { return fallo({ code: 'BAD_REQUEST' }, 400); }
  if (!body || typeof body !== 'object') return fallo({ code: 'BAD_REQUEST' }, 400);
  const slug = String(body.slug ?? '').toLowerCase();
  if (!SLUG.test(slug)) return fallo({ code: 'NOT_FOUND' });

  const lineas = Array.isArray(body.lineas) ? body.lineas.slice(0, 31).map((l: any) => ({
    product_id: Number(l?.product_id) || null,
    cantidad: Number.isInteger(l?.cantidad) ? l.cantidad : null,
    nota: str(l?.nota, 120),
    opciones: Array.isArray(l?.opciones) ? l.opciones.slice(0, 21).map((o: unknown) => Number(o) || 0) : [],
  })) : null;
  const ip = ipDe(req);
  const r = await deps.rpc('menu_pedido_crear', {
    slug, lineas,
    cliente_nombre: str(body.cliente_nombre, 80), cliente_telefono: str(body.cliente_telefono, 30),
    nota: str(body.nota, 200), origen: str(body.origen, 12), idem: str(body.idem, 36),
    ip_hash: ip ? await deps.hash(`${deps.sal}|${ip}`) : null,
  });
  if (!r?.ok) return fallo(r, r?.code === 'RATE_LIMIT' || r?.code === 'BUSY' ? 429 : 409);
  return responder({ success: true, token: r.token, total: r.total ?? null, repetido: !!r.repetido }, 201);
}
