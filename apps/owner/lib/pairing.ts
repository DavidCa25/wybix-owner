import AsyncStorage from '@react-native-async-storage/async-storage';

export interface PairingData {
  url: string;
  anonKey: string;
  negocioId: string;
  sucursalId: string;
  nombre?: string;
  /** Fase 1: invitación de un solo uso. Sin ella el QR no da acceso. */
  codigo?: string;
}

const KEY = 'wybix_pairing';

export async function savePairing(data: PairingData): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(data));
}

export async function loadPairing(): Promise<PairingData | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PairingData) : null;
  } catch {
    return null;
  }
}

export async function clearPairing(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}

// Valida el texto del QR y lo convierte en PairingData
export function parseQr(text: string): PairingData | null {
  try {
    const d = JSON.parse(text);
    if (d?.url && d?.anonKey && d?.negocioId && d?.sucursalId) {
      return {
        url: String(d.url),
        anonKey: String(d.anonKey),
        negocioId: String(d.negocioId),
        sucursalId: String(d.sucursalId),
        nombre: d.nombre ? String(d.nombre) : undefined,
        codigo: d.codigo ? String(d.codigo) : undefined
      };
    }
    return null;
  } catch {
    return null;
  }
}