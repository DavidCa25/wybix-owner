// ============================================================================
//  CONFIGURACIÓN DE FIRMA: qué clave firma, con qué KID, y en qué claves se
//  confía. Todo sale del gestor de secretos de Supabase; nada de archivos.
// ----------------------------------------------------------------------------
//  Secretos:
//    LICENSE_SIGNING_KEY   PKCS8 PEM de la clave privada ACTIVA (P-256).
//    LICENSE_SIGNING_KID   su identificador. OBLIGATORIO: sin él no se firma
//                          (antes caía en 'wybix-lic-1' por omisión, y una
//                          clave nueva con el KID viejo produce certificados
//                          que ningún POS puede verificar).
//    LICENSE_PUBLIC_KEYS   JSON { "<kid>": "<SPKI PEM>", ... }: TODAS las
//                          claves vigentes (la activa y las que aún tienen
//                          certificados vivos). Para verificar al liberar un
//                          equipo y para la autocomprobación.
//    LICENSE_REVOKED_KIDS  KIDs comprometidos, separados por coma. Viajan en
//                          cada certificado nuevo (`revoked_kids`) y el POS
//                          deja de aceptarlos para siempre.
//
//  ROTACIÓN (sin cortar a nadie):
//    1. Generar el par nuevo (kid N+1) fuera del repositorio.
//    2. Publicar un POS que conozca las públicas N y N+1.
//    3. LICENSE_PUBLIC_KEYS con N y N+1; LICENSE_SIGNING_KEY/KID -> N+1.
//       Desde ese momento todo certificado nuevo sale con N+1; los de N
//       siguen verificando en los POS.
//    4. Pasados OFFLINE_DAYS (45) desde el cambio, todo POS en uso ya
//       refrescó; N se puede retirar del POS en una versión posterior.
//
//  Sin dependencias de Deno: se prueba igual con Node (probar-certificado).
// ============================================================================
import { firmar, importarClavePrivada, verificar, type Certificado, type Payload } from './certificado.ts';

export type Env = (nombre: string) => string | undefined;

export interface Firma {
  ok: boolean;
  kid: string | null;
  motivo: string | null;          // por qué no se puede firmar (sin datos secretos)
  revocadas: string[];
  publicas: Record<string, string>;
  firmar(p: Payload): Promise<Certificado | null>;
  verificar(c: Certificado): Promise<Payload | null>;
}

const KID_VALIDO = /^wybix-(lic|dev)-[0-9]+$/;

function leerPublicas(env: Env, kid: string | null): Record<string, string> {
  const crudo = env('LICENSE_PUBLIC_KEYS');
  if (crudo) {
    try {
      const o = JSON.parse(crudo);
      if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).filter(([k, v]) => KID_VALIDO.test(k) && typeof v === 'string')) as Record<string, string>;
    } catch { /* se informa abajo como SIN_PUBLICA */ }
  }
  // Compatibilidad: una sola pública (configuración anterior).
  const una = env('LICENSE_PUBLIC_KEY');
  return una && kid ? { [kid]: una } : {};
}

/** Carga y AUTOCOMPRUEBA la configuración. Nunca devuelve ni registra la clave privada. */
export async function cargarFirma(env: Env): Promise<Firma> {
  const pem = env('LICENSE_SIGNING_KEY') ?? '';
  const kidCrudo = (env('LICENSE_SIGNING_KID') ?? '').trim();
  const kid = KID_VALIDO.test(kidCrudo) ? kidCrudo : null;
  const revocadas = (env('LICENSE_REVOKED_KIDS') ?? '').split(',').map(s => s.trim()).filter(s => KID_VALIDO.test(s));
  const publicas = leerPublicas(env, kid);

  const verificarCon = async (c: Certificado) => {
    if (!c || revocadas.includes(c.kid) || !publicas[c.kid]) return null;
    return await verificar(c, publicas[c.kid]);
  };
  const sinFirma = (motivo: string): Firma => ({
    ok: false, kid, motivo, revocadas, publicas, firmar: async () => null, verificar: verificarCon,
  });

  if (!pem) return sinFirma('SIN_CLAVE');
  if (!kidCrudo) return sinFirma('SIN_KID');
  if (!kid) return sinFirma('KID_INVALIDO');
  if (revocadas.includes(kid)) return sinFirma('KID_REVOCADO');
  if (!publicas[kid]) return sinFirma('SIN_PUBLICA');

  let clave: CryptoKey;
  try { clave = await importarClavePrivada(pem); } catch { return sinFirma('CLAVE_ILEGIBLE'); }

  // Autocomprobación: lo que firma la privada activa lo verifica la pública
  // publicada con ESE kid. Si no, no se firma nada: un certificado que ningún
  // POS puede verificar es peor que no emitirlo.
  const prueba = await firmar({ schema: 0 } as unknown as Payload, clave, kid);
  if (!(await verificar(prueba, publicas[kid]))) return sinFirma('PAR_INCORRECTO');

  return {
    ok: true, kid, motivo: null, revocadas, publicas,
    firmar: (p: Payload) => firmar({ ...p, revoked_kids: revocadas }, clave, kid),
    verificar: verificarCon,
  };
}
