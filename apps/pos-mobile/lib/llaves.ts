/**
 * SECRETOS DE LA TABLET, en SecureStore (Keystore de Android / Keychain de iOS).
 *
 *   llave de la base   32 bytes aleatorios; abre el SQLite cifrado (SQLCipher).
 *                      Sin ella, el archivo copiado no se puede abrir.
 *   credencial         la del equipo para hablar con la nube.
 *   device_uuid        identidad de ESTA tablet (no el ID del hardware).
 *
 * Nada de esto se escribe en logs ni viaja en la sincronización.
 */
import * as SecureStore from 'expo-secure-store';
import { getRandomBytes, randomUUID } from 'expo-crypto';

const OPC: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/*
 * Crear un secreto es "leer y, si no hay, generar y guardar": dos llamadas a la
 * vez en el primer arranque (la app y la tarea de fondo, o un efecto que corre
 * dos veces) generarían DOS llaves; la base quedaría cifrada con la primera y
 * guardada la segunda: ilegible para siempre. Por eso cada secreto se crea en
 * una sola promesa compartida.
 */
const enCurso = new Map<string, Promise<string>>();
function unaVez(clave: string, generar: () => string): Promise<string> {
  let p = enCurso.get(clave);
  if (!p) {
    p = (async () => {
      let v = await SecureStore.getItemAsync(clave, OPC);
      if (!v) { v = generar(); await SecureStore.setItemAsync(clave, v, OPC); }
      return v;
    })();
    p.catch(() => enCurso.delete(clave));
    enCurso.set(clave, p);
  }
  return p;
}

export const llaveBase = () => unaVez('wx_db_key', () => hex(getRandomBytes(32)));
export const deviceUuid = () => unaVez('wx_device_uuid', () => randomUUID());
export const credencial = {
  leer: () => SecureStore.getItemAsync('wx_device_token', OPC),
  guardar: (t: string) => SecureStore.setItemAsync('wx_device_token', t, OPC),
};
