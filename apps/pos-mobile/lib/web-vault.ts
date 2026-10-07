// Credenciales y SQLite web se guardan cifrados; la llave AES no es exportable.
// El navegador administra su propio almacenamiento: no equivale al Keystore nativo.
let opening: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!opening) opening = new Promise((resolve, reject) => {
    if (!globalThis.crypto?.subtle || !globalThis.indexedDB) { reject(new Error('Abre la app por HTTPS en Safari actualizado.')); return; }
    const r = indexedDB.open('wybix-pos-vault', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('values'); r.result.createObjectStore('keys'); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  return opening;
}
let keyPromise: Promise<CryptoKey> | null = null;
async function key(): Promise<CryptoKey> {
  if (!keyPromise) keyPromise = (async () => {
    const db = await open();
    const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite'), store = tx.objectStore('keys'), r = store.get('aes');
      let value: CryptoKey;
      r.onsuccess = () => { value = r.result ?? candidate; if (!r.result) store.put(value, 'aes'); };
      tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  })();
  return keyPromise;
}
export async function readVault(name: string): Promise<Uint8Array | null> {
  const db = await open();
  const record = await new Promise<{ iv: Uint8Array; data: ArrayBuffer } | undefined>((resolve, reject) => {
    const r = db.transaction('values').objectStore('values').get(name);
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  if (!record) return null;
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv as BufferSource, additionalData: new TextEncoder().encode(name) }, await key(), record.data)); }
  catch { throw new Error('No se pudo abrir el almacenamiento de esta app. No borres sus datos si hay ventas pendientes.'); }
}
export async function writeVault(name: string, value: Uint8Array): Promise<void> {
  const db = await open(), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) }, await key(), value as BufferSource);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('values', 'readwrite'); tx.objectStore('values').put({ iv, data }, name);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('No se pudo guardar. Libera espacio antes de continuar.')); tx.onabort = () => reject(tx.error);
  });
}
export const readText = async (name: string) => { const b = await readVault(name); return b ? new TextDecoder().decode(b) : null; };
export const writeText = (name: string, value: string) => writeVault(name, new TextEncoder().encode(value));
