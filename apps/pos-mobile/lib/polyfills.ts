/**
 * Hermes no trae crypto.getRandomValues. UUIDv7 y las llaves lo necesitan:
 * se toma de expo-crypto (generador seguro del sistema). Se importa PRIMERO.
 */
import { getRandomValues } from 'expo-crypto';

const g = globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) g.crypto.getRandomValues = (a: Uint8Array) => getRandomValues(a as never) as unknown as Uint8Array;

/*
 * scrypt del PIN: en Android, nativo (BouncyCastle, hilo de fondo). Hermes no
 * tiene JIT y el de JavaScript tarda segundos. Mismo algoritmo y parámetros:
 * los hashes del POS de Windows verifican igual (ver la pantalla /spike).
 */
import { usarMotorScrypt } from '@wybix/auth';
import { scryptNativo } from '../modules/wybix-scrypt';

const nativo = scryptNativo;
if (nativo) {
  usarMotorScrypt((pw, salt, N, r, p, dkLen) => nativo.scryptHex(pw, salt, N, r, p, dkLen), 'nativo');
}
