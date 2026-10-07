/**
 * PIN OFFLINE DEL POS MOBILE.
 *
 * El PIN se verifica en la tablet, sin Internet, contra el MISMO hash que
 * guarda el POS de Windows (`electron/local-host/credenciales.js`):
 *
 *     scrypt(pin, sal, N=16384, r=8, p=1, 32 bytes) en hex
 *
 * con la SAL usada como TEXTO (la cadena hex, en UTF-8), igual que
 * `crypto.scryptSync(String(pin), sal, ...)` en Node. Nunca viaja ni se guarda
 * el PIN; nunca se escribe en un log.
 *
 * Intentos: 5 fallos seguidos bloquean 5 minutos a esa persona EN ESTA
 * tablet (mismo criterio que el POS de Windows). Cada intento queda en la
 * auditoría local, sin el PIN.
 */
import { scrypt, scryptAsync } from '@noble/hashes/scrypt';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';

export const FALLOS_MAX = 5;
export const BLOQUEO_MIN = 5;

export function parametros(algo: string) {
  const m = /^scrypt:(\d+):(\d+):(\d+):(\d+)$/.exec(algo ?? '');
  if (!m) throw new Error('Algoritmo de PIN no soportado.');
  return { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]), dkLen: Number(m[4]) };
}

export function hashPin(pin: string, salHex: string, algo = 'scrypt:16384:8:1:32'): string {
  const { N, r, p, dkLen } = parametros(algo);
  return bytesToHex(scrypt(utf8ToBytes(String(pin)), utf8ToBytes(salHex), { N, r, p, dkLen }));
}

/**
 * MOTOR DE scrypt. Mismo algoritmo y parámetros; solo cambia DÓNDE se calcula.
 * Por omisión, @noble en JavaScript cediendo el hilo cada 10 ms (no congela
 * la pantalla). La tablet Android registra el nativo (BouncyCastle en un hilo
 * de fondo): en Hermes, sin JIT, el de JavaScript tarda segundos.
 */
export type MotorScrypt = (password: string, salt: string, N: number, r: number, p: number, dkLen: number) => Promise<string>;

const motorJs: MotorScrypt = async (password, salt, N, r, p, dkLen) =>
  bytesToHex(await scryptAsync(utf8ToBytes(password), utf8ToBytes(salt), { N, r, p, dkLen, asyncTick: 10 }));
let motor: MotorScrypt = motorJs;
let nombreMotor = 'js';

export function usarMotorScrypt(m: MotorScrypt | null, nombre = 'nativo'): void {
  motor = m ?? motorJs;
  nombreMotor = m ? nombre : 'js';
}
export function motorScryptActual(): string { return nombreMotor; }

export async function hashPinAsync(pin: string, salHex: string, algo = 'scrypt:16384:8:1:32'): Promise<string> {
  const { N, r, p, dkLen } = parametros(algo);
  return motor(String(pin), salHex, N, r, p, dkLen);
}

/** Comparación en tiempo constante (no revela cuántos caracteres coinciden). */
export function iguales(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function pinValido(pin: string): string | null {
  const p = String(pin ?? '');
  if (!/^\d{4,8}$/.test(p)) return 'El PIN son de 4 a 8 números.';
  return null;
}

export interface Intentos { failures: number; locked_until: string | null; }

export type ResultadoPin =
  | { ok: true }
  | { ok: false; bloqueado: boolean; hasta?: string; error: string };

/** ¿Esta persona está bloqueada ahora? (antes de gastar un scrypt). */
export function bloqueoVigente(intentos: Intentos | null, ahora: Date): string | null {
  return intentos?.locked_until && new Date(intentos.locked_until) > ahora ? intentos.locked_until : null;
}

/**
 * La POLÍTICA de intentos, separada del cálculo: recibe si el PIN coincidió y
 * devuelve el resultado y el NUEVO estado de intentos (quien llama lo guarda
 * en la misma transacción en que lo releyó). Respuesta uniforme: no distingue
 * "persona sin PIN" de "PIN equivocado".
 */
export function evaluarIntento(coincide: boolean, persona: { active: boolean } | null,
  intentos: Intentos | null, ahora: Date): { resultado: ResultadoPin; intentos: Intentos } {
  const actual: Intentos = intentos ?? { failures: 0, locked_until: null };
  const hasta0 = bloqueoVigente(actual, ahora);
  if (hasta0) {
    return { resultado: { ok: false, bloqueado: true, hasta: hasta0, error: 'Demasiados intentos. Espera unos minutos.' }, intentos: actual };
  }
  if (coincide && !!persona && persona.active) return { resultado: { ok: true }, intentos: { failures: 0, locked_until: null } };
  const fallos = actual.failures + 1;
  if (fallos >= FALLOS_MAX) {
    const hasta = new Date(ahora.getTime() + BLOQUEO_MIN * 60_000).toISOString();
    return { resultado: { ok: false, bloqueado: true, hasta, error: 'Demasiados intentos. Espera unos minutos.' }, intentos: { failures: 0, locked_until: hasta } };
  }
  return { resultado: { ok: false, bloqueado: false, error: 'PIN incorrecto.' }, intentos: { failures: fallos, locked_until: null } };
}

/** ¿El PIN coincide? Asíncrono, con el motor registrado. Sin persona, se gasta igual un scrypt (tiempo uniforme). */
export async function pinCoincide(pin: string, persona: { pin_hash: string; pin_sal: string; pin_algo: string; active: boolean } | null): Promise<boolean> {
  if (!persona || !persona.active || pinValido(pin)) {
    await hashPinAsync('0000', '00000000000000000000000000000000');
    return false;
  }
  return iguales(await hashPinAsync(pin, persona.pin_sal, persona.pin_algo), persona.pin_hash);
}

/** Versión síncrona (pruebas y herramientas en Node). Misma política. */
export function verificarPin(pin: string, persona: { pin_hash: string; pin_sal: string; pin_algo: string; active: boolean } | null,
  intentos: Intentos | null, ahora: Date): { resultado: ResultadoPin; intentos: Intentos } {
  if (bloqueoVigente(intentos, ahora)) return evaluarIntento(false, persona, intentos, ahora);
  const ok = !!persona && persona.active && !pinValido(pin) && iguales(hashPin(pin, persona.pin_sal, persona.pin_algo), persona.pin_hash);
  return evaluarIntento(ok, persona, intentos, ahora);
}
