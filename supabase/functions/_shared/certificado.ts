// ============================================================================
//  CERTIFICADO DE LICENCIA FIRMADO (ES256)
// ----------------------------------------------------------------------------
//  El servidor firma con la CLAVE PRIVADA (secreto LICENSE_SIGNING_KEY, solo
//  en Supabase). El POS verifica con la CLAVE PÚBLICA que trae dentro. Editar
//  cualquier campo (cajas, fechas, giros, pantallas) invalida la firma.
//
//  Formato del archivo (.wybix-license):
//
//    { "format": "wybix-license", "v": 1, "kid": "...",
//      "payload": "<base64url del JSON>",
//      "sig": "<base64url de la firma ES256 (r||s, 64 bytes)>" }
//
//  Se firma el TEXTO base64url de `payload`, tal cual: así no hay dudas de
//  canonicalización JSON entre Deno y Node.
//
//  Solo contiene lo que decide qué puede hacer el POS (runtime). Nada
//  comercial: ni soporte, ni adaptaciones, ni precios.
//
//  Sin dependencias ni APIs de Deno: se prueba igual con Node.
// ============================================================================
import { GRACE_DAYS, OFFLINE_DAYS, SCHEMA } from './politica.ts';

const DIA = 86_400_000;

export interface Runtime {
  license_id: string;
  customer: string;
  edition: 'mono' | 'multi';
  registers_max: number | null;
  verticals: { vertical: string; screen_tier: string }[];
  entitlements: string[];
  screens: Record<string, number | null>;
  addons: string[];
  first_activated_at: string | null;
  paid_until: string | null;
  origin?: string | null;
}

export interface Payload {
  schema: number;
  kind: 'LICENSE' | 'TRIAL';
  license_id: string | null;
  customer: string;
  machine_id: string;
  edition: 'mono' | 'multi';
  registers_max: number | null;
  verticals: string[];
  screens: Record<string, number | null>;
  entitlements: string[];
  addons: string[];
  trial_started_at: string | null;
  trial_ends_at: string | null;
  first_activated_at: string | null;
  paid_until: string | null;
  grace_days: number;
  grace_until: string | null;
  offline_days: number;
  issued_at: string;
  valid_until: string;
  /** KIDs comprometidos: el POS deja de aceptarlos para siempre. */
  revoked_kids?: string[];
  /** PRODUCTION | INTERNAL | QA | TEST. Informativo: no otorga nada. */
  origin?: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** El certificado de una licencia comprada, para UNA computadora. */
export function payloadDeLicencia(rt: Runtime, machineId: string, ahora = Date.now()): Payload {
  const paid = rt.paid_until ? Date.parse(rt.paid_until) : null;
  return {
    schema: SCHEMA,
    kind: 'LICENSE',
    license_id: rt.license_id,
    customer: rt.customer ?? '',
    machine_id: machineId,
    edition: rt.edition,
    registers_max: rt.registers_max,
    verticals: (rt.verticals || []).map(v => v.vertical).sort(),
    screens: rt.screens || {},
    entitlements: [...(rt.entitlements || [])].sort(),
    addons: rt.addons || [],
    trial_started_at: null,
    trial_ends_at: null,
    first_activated_at: rt.first_activated_at,
    paid_until: paid ? iso(paid) : null,
    origin: rt.origin ?? null,
    grace_days: GRACE_DAYS,
    grace_until: paid ? iso(paid + GRACE_DAYS * DIA) : null,
    offline_days: OFFLINE_DAYS,
    issued_at: iso(ahora),
    valid_until: iso(ahora + OFFLINE_DAYS * DIA),
  };
}

/** Lo que otorga una prueba (license_trial_grants): MonoCaja + el giro elegido. */
export interface GrantsDePrueba {
  verticals: string[];
  entitlements: string[];
  screens: Record<string, number | null>;
}

/**
 * El certificado de la PRUEBA gratuita. Misma forma, `kind: TRIAL`: una
 * MonoCaja con el GIRO QUE ELIGIÓ EL NEGOCIO en su alta (y hasta elegirlo,
 * solo lo de la edición) durante 30 días. Nunca los tres giros a la vez. No
 * es otro sistema de licencia. Al terminar no hay gracia: una prueba no es
 * una suscripción pagada.
 */
export function payloadDePrueba(t: { machine_id: string; business_name?: string | null; started_at: string; expires_at: string },
                                grants: GrantsDePrueba, ahora = Date.now()): Payload {
  const fin = Date.parse(t.expires_at);
  return {
    schema: SCHEMA,
    kind: 'TRIAL',
    license_id: null,
    customer: t.business_name ?? '',
    machine_id: t.machine_id,
    edition: 'mono',
    registers_max: 1,
    verticals: [...(grants.verticals || [])].sort(),
    screens: grants.screens || {},
    entitlements: [...(grants.entitlements || [])].sort(),
    addons: [],
    trial_started_at: iso(Date.parse(t.started_at)),
    trial_ends_at: iso(fin),
    first_activated_at: null,
    paid_until: null,
    grace_days: 0,
    grace_until: null,
    offline_days: OFFLINE_DAYS,
    issued_at: iso(ahora),
    // La prueba no se refresca: vale hasta su último día y ahí termina.
    valid_until: iso(fin),
  };
}

// ---------------------------------------------------------------- firma
const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function pemABytes(pem: string): Uint8Array {
  const limpio = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(limpio);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Importa la clave privada PKCS8 (PEM) de LICENSE_SIGNING_KEY. */
export async function importarClavePrivada(pem: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey('pkcs8', pemABytes(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

export interface Certificado { format: 'wybix-license'; v: 1; kid: string; payload: string; sig: string; }

export async function firmar(payload: Payload, clave: CryptoKey, kid: string): Promise<Certificado> {
  const cuerpo = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const firma = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, clave, new TextEncoder().encode(cuerpo));
  return { format: 'wybix-license', v: 1, kid, payload: cuerpo, sig: b64url(new Uint8Array(firma)) };
}

/** Verifica un certificado con una clave pública SPKI (PEM). Para el servidor (liberar). */
export async function verificar(cert: Certificado, publicaPem: string): Promise<Payload | null> {
  try {
    if (!cert || cert.format !== 'wybix-license' || cert.v !== 1) return null;
    const clave = await crypto.subtle.importKey('spki', pemABytes(publicaPem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(cert.sig.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((cert.sig.length + 3) % 4)), c => c.charCodeAt(0));
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, clave, sig, new TextEncoder().encode(cert.payload));
    if (!ok) return null;
    const json = atob(cert.payload.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((cert.payload.length + 3) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, c => c.charCodeAt(0))));
  } catch {
    return null;
  }
}
