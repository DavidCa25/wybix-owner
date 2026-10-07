/**
 * MFA DEL DUEÑO (Fase 3): TOTP de Supabase Auth.
 *
 * La regla vive en la nube (wx_actor_admin exige una sesión AAL2 para
 * administrar). Esta capa solo guía: enrola, pide el código y recupera. Si
 * alguien se salta una pantalla, el backend igual dice que no.
 */
import { supabase } from './supabase';

export type Nivel = { actual: 'aal1' | 'aal2' | null; siguiente: 'aal1' | 'aal2' | null };
export type Resultado<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

export const CODIGOS_MFA = ['MFA_REQUIRED', 'MFA_ENROLL_REQUIRED'] as const;
export const esCodigoMfa = (c: string | null | undefined) => !!c && (CODIGOS_MFA as readonly string[]).includes(c);

const MENSAJES: Record<string, string> = {
  INVALID_CODE: 'El código no es correcto.',
  RATE_LIMITED: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.',
  NO_SESSION: 'Tu sesión terminó. Vuelve a iniciar sesión.',
  PARTIAL: 'Se usó tu código pero no se pudo terminar. Intenta de nuevo o contacta a soporte.',
  MFA_REQUIRED: 'Confirma con tu código de verificación para hacer cambios.',
  MFA_ENROLL_REQUIRED: 'Para hacer cambios, activa la verificación en dos pasos.',
};
export const mensajeMfa = (c: string) => MENSAJES[c] ?? 'No se pudo completar. Intenta de nuevo.';

/** Lo dice el JWT de la sesión (no hace llamadas de red). */
export async function nivel(): Promise<Nivel> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return { actual: null, siguiente: null };
  return { actual: data.currentLevel as Nivel['actual'], siguiente: data.nextLevel as Nivel['siguiente'] };
}

async function factorVerificado(): Promise<string | null> {
  const { data } = await supabase.auth.mfa.listFactors();
  return data?.totp?.find((f) => f.status === 'verified')?.id ?? null;
}

const soloDigitos = (c: string) => c.replace(/\D/g, '');

/** La nube anota el cambio con lo que ELLA ve (no con lo que dice la app). */
async function registrar(evento: 'ENROLLED' | 'UNENROLLED' | 'VERIFIED' | 'SIGNED_OUT_OTHERS') {
  await supabase.rpc('mfa_registrar', { p_evento: evento }).then(() => undefined, () => undefined);
}

/** Sube la sesión a AAL2 con el código de la app autenticadora. */
export async function verificar(codigo: string): Promise<Resultado> {
  const factorId = await factorVerificado();
  if (!factorId) return { ok: false, error: 'No tienes la verificación en dos pasos activada.' };
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: soloDigitos(codigo) });
  if (error) return { ok: false, error: mensajeMfa('INVALID_CODE') };
  await registrar('VERIFIED');
  return { ok: true };
}

export type Enrolamiento = { factorId: string; secreto: string; uri: string; qr: string };

/**
 * Supabase entrega el QR como `data:image/svg+xml;utf-8,<svg …>` sin codificar.
 * En la web, React Native lo pinta como fondo CSS y un `#` (los colores del
 * SVG) corta la URL: el QR sale en blanco. Se recodifica completo.
 */
export function qrComoUri(qr: string): string {
  const m = /^data:image\/svg\+xml;(?:utf-?8|charset=utf-?8),([\s\S]*)$/i.exec(qr);
  if (!m) return qr;
  let svg = m[1];
  try { svg = decodeURIComponent(svg); } catch { /* ya venía sin codificar */ }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Empieza un enrolamiento nuevo (borra los que quedaron a medias). */
export async function iniciarEnrolamiento(): Promise<Resultado<{ enrolamiento: Enrolamiento }>> {
  const { data: lista } = await supabase.auth.mfa.listFactors();
  for (const f of lista?.all ?? []) {
    if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Wybix ${new Date().toISOString().slice(0, 16)}` });
  if (error || !data) return { ok: false, error: 'No se pudo iniciar. Intenta de nuevo.' };
  return { ok: true, enrolamiento: { factorId: data.id, secreto: data.totp.secret, uri: data.totp.uri, qr: data.totp.qr_code } };
}

/** Confirma el factor con el primer código y genera los códigos de recuperación. */
export async function confirmarEnrolamiento(factorId: string, codigo: string): Promise<Resultado<{ codigos: string[] }>> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: soloDigitos(codigo) });
  if (error) return { ok: false, error: mensajeMfa('INVALID_CODE') };
  await registrar('ENROLLED');
  return generarCodigos();
}

/** Genera 10 códigos nuevos (invalida los anteriores). Exige AAL2 en la nube. */
export async function generarCodigos(): Promise<Resultado<{ codigos: string[] }>> {
  const { data, error } = await supabase.rpc('mfa_generar_codigos');
  if (error || !data?.ok) return { ok: false, error: mensajeMfa(data?.code ?? 'ERROR') };
  return { ok: true, codigos: data.codigos as string[] };
}

export type Estado = { factores: number; aal: string | null; codigos_restantes: number };
export async function estado(): Promise<Estado | null> {
  const { data, error } = await supabase.rpc('mfa_estado');
  return error ? null : (data as Estado);
}

/** Quita el segundo factor. Supabase exige AAL2 para hacerlo. */
export async function quitarFactor(): Promise<Resultado> {
  const factorId = await factorVerificado();
  if (!factorId) return { ok: true };
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) return { ok: false, error: 'Confirma primero con tu código de verificación.' };
  await registrar('UNENROLLED');
  await supabase.auth.refreshSession();
  return { ok: true };
}

/** Cierra las sesiones en otros teléfonos o navegadores (no esta). */
export async function cerrarOtrasSesiones(): Promise<Resultado> {
  const { error } = await supabase.auth.signOut({ scope: 'others' });
  if (error) return { ok: false, error: 'No se pudieron cerrar las otras sesiones.' };
  await registrar('SIGNED_OUT_OTHERS');
  return { ok: true };
}

/** Perdiste el teléfono: un código de recuperación quita el factor; luego te enrolas de nuevo. */
export async function recuperar(codigo: string): Promise<Resultado> {
  const { data, error } = await supabase.functions.invoke('owner-mfa', { body: { action: 'recuperar', codigo } });
  if (error) {
    const cuerpo = await (error as { context?: Response }).context?.json?.().catch(() => null);
    return { ok: false, error: mensajeMfa(cuerpo?.code ?? 'ERROR') };
  }
  if (!data?.ok) return { ok: false, error: mensajeMfa(data?.code ?? 'ERROR') };
  await supabase.auth.refreshSession();
  return { ok: true };
}
