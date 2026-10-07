import { readText, writeText } from './web-vault';
const pending = new Map<string, Promise<string>>();
function once(name: string, generate: () => string): Promise<string> {
  let p = pending.get(name);
  if (!p) { p = (async () => { const existing = await readText(name); if (existing) return existing; const value = generate(); await writeText(name, value); return value; })(); pending.set(name, p); p.catch(() => pending.delete(name)); }
  return p;
}
export const deviceUuid = () => once('device_uuid', () => crypto.randomUUID());
export const llaveBase = () => once('db_compat_key', () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join(''));
export const credencial = { leer: () => readText('device_token'), guardar: (token: string) => writeText('device_token', token) };
