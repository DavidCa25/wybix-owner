import { supabase } from './supabase';
import { loadPairing, savePairing, PairingData } from './pairing';

/*
 * FASE 1: vincular = aceptar la INVITACIÓN del QR (un solo uso, 30 min).
 * Conocer el negocio ya no da acceso: la membresía la crea la base solo con un
 * código vigente. Se usa al crear la cuenta y al iniciar sesión con un QR
 * recién escaneado (una persona puede pertenecer a varias empresas).
 */
export async function vincularConPairing(p?: PairingData | null): Promise<{ ok: boolean; error?: string }> {
  const pairing = p ?? (await loadPairing());
  if (!pairing?.codigo) return { ok: true };
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) return { ok: false, error: 'Inicia sesión para vincular el negocio.' };
  try {
    const res = await fetch(`${pairing.url}/functions/v1/link-owner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: pairing.anonKey },
      body: JSON.stringify({ codigo: pairing.codigo }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: out?.message || out?.error || 'No se pudo vincular el negocio.' };
    // El código ya se usó: se olvida para no reintentarlo.
    await savePairing({ ...pairing, codigo: undefined });
    return { ok: true };
  } catch {
    return { ok: false, error: 'No se pudo vincular. Revisa tu conexión.' };
  }
}
