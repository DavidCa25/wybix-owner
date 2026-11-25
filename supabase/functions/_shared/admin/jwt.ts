// ============================================================================
//  VERIFICACIÓN LOCAL DEL JWT DE SUPABASE AUTH (ES256 / RS256 vía JWKS)
// ----------------------------------------------------------------------------
//  Evita el viaje a Auth (`getUser`) en cada petición del panel: la firma se
//  comprueba aquí con las llaves públicas del proyecto
//  (`/auth/v1/.well-known/jwks.json`, en memoria 10 min). Que la sesión siga
//  viva (no cerrada) lo confirma `admin_gate` contra auth.sessions.
//
//  Sin Deno: usa WebCrypto, se prueba en Node. Un token con otro algoritmo
//  (HS256 legado) devuelve `null` y el llamador decide el respaldo.
// ============================================================================

export interface Claims {
  sub: string; email: string | null; aal: string | null; session_id: string | null;
  exp: number; iss: string; role: string;
}

interface Jwk { kid?: string; kty: string; alg?: string; crv?: string; x?: string; y?: string; n?: string; e?: string }

const ALGS: Record<string, { importar: (jwk: Jwk) => Promise<CryptoKey>; verificar: AlgorithmIdentifier | EcdsaParams }> = {
  ES256: {
    importar: (jwk) => crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']),
    verificar: { name: 'ECDSA', hash: 'SHA-256' },
  },
  RS256: {
    importar: (jwk) => crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
    verificar: { name: 'RSASSA-PKCS1-v1_5' },
  },
};

const b64url = (s: string): Uint8Array => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b.padEnd(b.length + ((4 - (b.length % 4)) % 4), '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const json = (s: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(b64url(s)));

export interface OpcionesVerificador {
  /** `https://<ref>.supabase.co` */
  supabaseUrl: string;
  /** Inyectable para pruebas. */
  descargarLlaves?: () => Promise<Jwk[]>;
  ahora?: () => number;
  vidaCacheMs?: number;
}

/** Fábrica: un verificador por isolate, con su caché de llaves. */
export function crearVerificador(o: OpcionesVerificador) {
  const emisor = `${o.supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  const descargar = o.descargarLlaves ?? (async () => {
    const r = await fetch(`${emisor}/.well-known/jwks.json`);
    if (!r.ok) throw new Error(`JWKS ${r.status}`);
    return ((await r.json()) as { keys: Jwk[] }).keys ?? [];
  });
  const ahora = o.ahora ?? (() => Date.now());
  const vida = o.vidaCacheMs ?? 600_000;
  let cache: { en: number; llaves: Map<string, Promise<CryptoKey>>; jwks: Jwk[] } | null = null;

  async function llave(kid: string, alg: string, forzar = false): Promise<CryptoKey | null> {
    if (forzar || !cache || ahora() - cache.en > vida) cache = { en: ahora(), llaves: new Map(), jwks: await descargar() };
    const jwk = cache.jwks.find((k) => k.kid === kid);
    if (!jwk) return null;
    let p = cache.llaves.get(kid);
    if (!p) { p = ALGS[alg].importar(jwk); cache.llaves.set(kid, p); }
    return p;
  }

  /** Claims verificados, o `null` si el token no es válido (o es HS256). */
  return async function verificar(token: string): Promise<Claims | null> {
    const partes = token.split('.');
    if (partes.length !== 3) return null;
    let cab: Record<string, unknown>, cuerpo: Record<string, unknown>;
    try { cab = json(partes[0]); cuerpo = json(partes[1]); } catch { return null; }
    const alg = String(cab.alg ?? ''), kid = String(cab.kid ?? '');
    if (!ALGS[alg] || !kid) return null;

    // Llave desconocida: puede haber rotado; se vuelve a descargar una vez.
    let k = await llave(kid, alg).catch(() => null);
    if (!k) k = await llave(kid, alg, true).catch(() => null);
    if (!k) return null;

    const firma = b64url(partes[2]);
    const datos = new TextEncoder().encode(`${partes[0]}.${partes[1]}`);
    const valida = await crypto.subtle.verify(ALGS[alg].verificar, k, firma, datos).catch(() => false);
    if (!valida) return null;

    const exp = Number(cuerpo.exp);
    const aud = cuerpo.aud;
    const audOk = aud === 'authenticated' || (Array.isArray(aud) && aud.includes('authenticated'));
    if (!Number.isFinite(exp) || exp * 1000 <= ahora()) return null;
    if (cuerpo.iss !== emisor || !audOk || cuerpo.role !== 'authenticated') return null;
    if (typeof cuerpo.sub !== 'string' || !/^[0-9a-f-]{36}$/i.test(cuerpo.sub)) return null;

    return {
      sub: cuerpo.sub, exp, iss: emisor, role: 'authenticated',
      email: typeof cuerpo.email === 'string' ? cuerpo.email : null,
      aal: typeof cuerpo.aal === 'string' ? cuerpo.aal : null,
      session_id: typeof cuerpo.session_id === 'string' ? cuerpo.session_id : null,
    };
  };
}
