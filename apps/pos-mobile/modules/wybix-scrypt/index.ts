/**
 * scrypt nativo (Android). En otra plataforma no existe y quien lo usa cae al
 * scrypt de JavaScript (@noble), que da exactamente el mismo resultado.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

type Nativo = { scryptHex(password: string, salt: string, n: number, r: number, p: number, dkLen: number): Promise<string> };

export const scryptNativo: Nativo | null = requireOptionalNativeModule<Nativo>('WybixScrypt');
