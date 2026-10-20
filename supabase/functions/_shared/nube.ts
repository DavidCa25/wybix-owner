// ============================================================================
//  PIEZAS COMUNES DE LAS EDGE FUNCTIONS (sin nada de Deno: se prueban en Node)
// ----------------------------------------------------------------------------
//  Toda decisión de autorización vive en Postgres (funciones SECURITY DEFINER
//  de supabase/migrations/20261002120000_fase1_multiempresa.sql). Aquí solo:
//    · se llama a esas funciones (rpc),
//    · se saca la credencial del equipo de la petición,
//    · se arma la respuesta HTTP.
// ============================================================================

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wybix-sync, x-wybix-device',
};

export const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

/** Llama a una función `public.<fn>(p jsonb) returns jsonb`. */
export type Rpc = (fn: string, p: Record<string, unknown>) => Promise<any>;

/** RPC por PostgREST con la service role (solo existe en el servidor). */
export function rpcPostgrest(url: string, serviceKey: string, f: typeof fetch = fetch): Rpc {
  return async (fn, p) => {
    const r = await f(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p }),
    });
    if (!r.ok) throw new Error(`rpc ${fn}: HTTP ${r.status}`);
    return r.json();
  };
}

/** La credencial del equipo. Nunca viaja en el cuerpo ni en la URL. */
export function credencialDe(req: Request): string {
  return String(req.headers.get('x-wybix-device') ?? req.headers.get('x-wybix-sync') ?? '').trim();
}

export interface Equipo { device_id: string; company_id: string; location_id: string; kind: string; legacy: boolean; }

/** Credencial -> equipo activo (o null). */
export async function equipoDe(req: Request, rpc: Rpc): Promise<Equipo | null> {
  const token = credencialDe(req);
  if (token.length < 20) return null;
  const r = await rpc('device_autenticar', { token, app_version: req.headers.get('x-wybix-version') ?? '' });
  return r?.ok ? (r as Equipo) : null;
}

/** Usuario de Supabase Auth a partir de su JWT (app del dueño). */
export async function usuarioDe(req: Request, url: string, anonOrService: string, f: typeof fetch = fetch): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await f(`${url}/auth/v1/user`, { headers: { apikey: anonOrService, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return typeof u?.id === 'string' ? u.id : null;
}

/** Respuestas uniformes para lo que niega la base. */
export function negado(code?: string): Response {
  const s = code === 'NO_TOKEN' || code === 'BAD_TOKEN' ? 401 : code === 'BAD_REQUEST' ? 400 : 403;
  const msg: Record<string, string> = {
    NO_TOKEN: 'Falta la credencial del equipo.',
    BAD_TOKEN: 'Credencial del equipo inválida.',
    BAD_REQUEST: 'Petición incompleta.',
    NO_ISSUER: 'Esta empresa no tiene emisor registrado.',
    ISSUER_REQUIRED: 'Indica el emisor.',
    ISSUER_CONFLICT: 'El emisor está en revisión: dos empresas lo reclaman. Contacta a soporte.',
    // Fase 2
    DEVICE_REVOKED: 'Este equipo fue dado de baja.',
    NOT_PRIMARY: 'Solo la caja principal puede hacer esto.',
    ENVELOPE_MISMATCH: 'Los datos no corresponden a la empresa o la ubicación de este equipo.',
    CLONE_SUSPECTED: 'Esta base parece copiada de otro servidor. El dueño debe confirmarlo antes de sincronizar.',
    NO_LICENSE: 'La empresa no tiene una licencia ligada.',
    LIMIT_LOCATIONS: 'Ya se usaron todas las sucursales de la licencia.',
    NO_ENTITLEMENT_TEMPORARY_LOCATIONS: 'La licencia no incluye eventos.',
    NO_ENTITLEMENT_MOBILE_POS: 'La licencia no incluye Wybix POS Mobile.',
    LIMIT_MOBILE_POS: 'Ya se usaron todas las tablets de la licencia.',
    EVENT_NOT_OPEN: 'El evento no está abierto.',
    // Fase 3 · autorización a distancia
    NOT_REMOTE: 'Esta acción no se puede autorizar a distancia.',
    CONFLICT: 'Ya existe otra solicitud con ese identificador.',
    NOT_FOUND: 'No se encontró la solicitud.',
    NOT_APPROVED: 'La solicitud no está aprobada.',
    NOT_PENDING: 'La solicitud ya no está pendiente.',
    PAYLOAD_CHANGED: 'La operación cambió después de pedir la autorización. Pide una nueva.',
    // MultiSucursal
    NO_ENTITLEMENT_MULTIBRANCH: 'La licencia de la empresa no incluye MultiSucursal.',
    NOT_MATRIZ: 'Solo la matriz puede hacer esto.',
    BAD_PRICE: 'Un precio especial no puede ser negativo.',
    CANCELLED: 'Quien lo envió canceló este traspaso.',
    ALREADY_RECEIVED: 'El traspaso ya se recibió: no se puede cancelar.',
  };
  return json({ success: false, code: code ?? 'DENIED', error: msg[code ?? ''] ?? 'No autorizado.' }, s);
}
