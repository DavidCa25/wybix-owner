// ============================================================
// Autenticación de webhooks internos (base de datos -> Edge Function).
//
// FALLA CERRADO: sin secreto configurado, NADIE pasa. Antes la regla era
// "si hay secreto, compáralo", así que una función desplegada sin
// WEBHOOK_SECRET quedaba abierta a cualquiera.
//
// La comparación es de tiempo constante (sobre los SHA-256 de ambos valores,
// para no filtrar la longitud). Nunca se registra ninguno de los dos valores.
// ============================================================

export const LONGITUD_MINIMA_SECRETO = 32;

export type ResultadoWebhook =
  | { ok: true }
  | { ok: false; status: 401 | 503; motivo: 'SIN_CONFIGURAR' | 'NO_AUTORIZADO' };

async function sha256(texto: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto)));
}

/** Compara en tiempo constante. */
export async function igualesSeguro(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/**
 * `configurado` es el secreto del entorno (WEBHOOK_SECRET); `recibido`, la
 * cabecera x-webhook-secret. Un secreto corto se trata como no configurado:
 * protege de "x" o "test" puestos a mano.
 */
export async function validarWebhook(configurado: string | undefined | null, recibido: string | undefined | null): Promise<ResultadoWebhook> {
  const secreto = (configurado ?? '').trim();
  if (secreto.length < LONGITUD_MINIMA_SECRETO) return { ok: false, status: 503, motivo: 'SIN_CONFIGURAR' };
  if (!recibido || !(await igualesSeguro(secreto, recibido))) return { ok: false, status: 401, motivo: 'NO_AUTORIZADO' };
  return { ok: true };
}
