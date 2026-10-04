/**
 * UUIDv7: 48 bits de milisegundos + 74 bits aleatorios.
 *
 * Se ordenan aproximadamente por tiempo (útil para índices), pero la
 * unicidad la dan los 74 bits aleatorios: un reloj mal puesto en la tablet no
 * produce choques. El ORDEN de los hechos de una tablet NO sale del UUID ni
 * del reloj, sino de su `local_sequence`.
 */
type Aleatorio = (n: number) => Uint8Array;

const aleatorioPorDefecto: Aleatorio = (n) => {
  const b = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new Error('No hay generador aleatorio seguro.');
  c.getRandomValues(b);
  return b;
};

export function uuidv7(ms: number = Date.now(), aleatorio: Aleatorio = aleatorioPorDefecto): string {
  const b = aleatorio(16);
  let t = BigInt(Math.max(0, Math.floor(ms)));
  for (let i = 5; i >= 0; i--) { b[i] = Number(t & 0xffn); t >>= 8n; }
  b[6] = (b[6] & 0x0f) | 0x70;   // versión 7
  b[8] = (b[8] & 0x3f) | 0x80;   // variante RFC 4122
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const esUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
