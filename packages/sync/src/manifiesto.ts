/**
 * SPIKE 2.4 · COMPROBANTE DE TRANSFERENCIA FIRMADO (QR).
 *
 * Caso: Centro manda 40 donas a la feria, pero la tablet perdió Internet
 * antes de descargar la transferencia. Para no detener la recepción, el POS
 * de Centro muestra/imprime un QR con el manifiesto FIRMADO.
 *
 *     WXT1.<manifiesto en base64url>.<firma Ed25519 en base64url>
 *
 * Quién firma: la caja principal de la sucursal con SU llave de equipo
 * (Ed25519; la privada nunca sale de esa computadora, cifrada con
 * safeStorage). La pública se registró en la nube y llega a la tablet en el
 * snapshot como "llave de confianza" de su empresa.
 *
 * La tablet acepta el QR solo si:
 *   - la firma es válida con una llave de confianza de SU empresa,
 *   - el manifiesto es para SU empresa y SU evento,
 *   - no lo recibió antes (idempotente por transfer_uuid).
 * Cambiar un solo carácter (una cantidad, un producto) invalida la firma.
 * Un QR nunca es fuente de verdad por sí mismo: es un comprobante verificable.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { utf8ToBytes } from '@noble/hashes/utils';

export const PREFIJO = 'WXT1';

export interface Manifiesto {
  v: 1;
  t: string;            // transfer_uuid
  c: string;            // company_uuid
  f: string;            // from_location_uuid (sucursal)
  to: string;           // to_location_uuid (evento)
  k: string;            // key_id de quien firma
  at: string;           // fecha de envío (informativa)
  l: Array<[string, string]>;   // [product_uuid, qty_sent]
}

const b64 = {
  enc(b: Uint8Array): string {
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(s: string): Uint8Array {
    const t = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};
export const base64url = b64;

/** UTF-8 -> texto sin TextDecoder (Hermes no siempre lo trae). */
function utf8(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += '%' + b[i].toString(16).padStart(2, '0');
  return decodeURIComponent(s);
}

/** Lo que se firma: el texto exacto "WXT1.<manifiesto>" (sin re-serializar JSON). */
export function cuerpoFirmado(m: Manifiesto): string {
  return `${PREFIJO}.${b64.enc(utf8ToBytes(JSON.stringify(m)))}`;
}

/** Arma el QR con una firma ya calculada (el POS de Windows firma con node:crypto). */
export function armarQr(m: Manifiesto, firma: Uint8Array): string {
  return `${cuerpoFirmado(m)}.${b64.enc(firma)}`;
}

export function firmarQr(m: Manifiesto, privada: Uint8Array): string {
  return armarQr(m, ed25519.sign(utf8ToBytes(cuerpoFirmado(m)), privada));
}

export type ResultadoQr =
  | { ok: true; manifiesto: Manifiesto; firma: string }
  | { ok: false; code: 'FORMATO' | 'LLAVE_DESCONOCIDA' | 'FIRMA' | 'AJENO'; error: string };

export function verificarQr(texto: string, llaves: Array<{ key_id: string; public_key: string }>, esperado: { company_uuid: string; location_uuid: string }): ResultadoQr {
  const partes = String(texto ?? '').trim().split('.');
  if (partes.length !== 3 || partes[0] !== PREFIJO) return { ok: false, code: 'FORMATO', error: 'Ese código no es un comprobante de transferencia de Wybix.' };
  let m: Manifiesto;
  try { m = JSON.parse(utf8(b64.dec(partes[1]))); }
  catch { return { ok: false, code: 'FORMATO', error: 'El comprobante está dañado.' }; }
  const llave = llaves.find((k) => k.key_id === m.k);
  if (!llave) return { ok: false, code: 'LLAVE_DESCONOCIDA', error: 'El comprobante lo firmó un equipo que este evento no conoce.' };
  let valida = false;
  try { valida = ed25519.verify(b64.dec(partes[2]), utf8ToBytes(`${partes[0]}.${partes[1]}`), b64.dec(llave.public_key)); }
  catch { valida = false; }
  if (!valida) return { ok: false, code: 'FIRMA', error: 'La firma no coincide: el comprobante fue modificado.' };
  if (m.c !== esperado.company_uuid || m.to !== esperado.location_uuid) return { ok: false, code: 'AJENO', error: 'Ese comprobante es para otra empresa u otro evento.' };
  return { ok: true, manifiesto: m, firma: partes[2] };
}

/** Manifiesto -> forma que guarda la base local. */
export function aTransferencia(m: Manifiesto) {
  return { transfer_uuid: m.t, company_uuid: m.c, from_location_uuid: m.f, to_location_uuid: m.to, lines: m.l.map(([product_uuid, qty_sent]) => ({ product_uuid, qty_sent })) };
}
