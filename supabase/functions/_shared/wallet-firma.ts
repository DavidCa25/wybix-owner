// ============================================================================
//  PIEZAS DE BAJO NIVEL DE LA TARJETA EN WALLET (sin Deno ni npm: se prueban
//  en Node y corren igual en la Edge Function).
// ----------------------------------------------------------------------------
//  · DER mínimo: lo justo para leer un certificado (emisor y número de serie)
//    y escribir una firma PKCS#7/CMS separada, que es lo que Apple pide en el
//    archivo `signature` de un .pkpass.
//  · ZIP sin compresión (método 0): un .pkpass es un ZIP y Wallet no exige
//    compresión.
//  · PNG de un color: el icono de reserva cuando la marca no trae uno.
//  · JWT RS256: lo que Google Wallet firma con la cuenta de servicio.
//
//  Todo usa WebCrypto (crypto.subtle), que existe en Node y en Deno.
// ============================================================================

const te = new TextEncoder();
export const bytes = (s: string) => te.encode(s);

export function concat(...xs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) { out.set(x, o); o += x.length; }
  return out;
}

export const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

export function b64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function deB64(s: string): Uint8Array {
  const t = atob(s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, ''));
  const out = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i);
  return out;
}

export async function sha(alg: 'SHA-1' | 'SHA-256', data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg, data));
}

export async function hmac(clave: string, texto: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', bytes(clave), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, bytes(texto)));
}

/* --------------------------------------------------------------------- PEM */

/** Todos los bloques `-----BEGIN <tipo>-----` de un texto, en orden. */
export function pemBloques(pem: string, tipo?: string): { tipo: string; der: Uint8Array }[] {
  const out: { tipo: string; der: Uint8Array }[] = [];
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  for (let m; (m = re.exec(pem.replace(/\\n/g, '\n')));) if (!tipo || m[1] === tipo) out.push({ tipo: m[1], der: deB64(m[2]) });
  return out;
}

export function pem(tipo: string, der: Uint8Array): string {
  return `-----BEGIN ${tipo}-----\n${b64(der).replace(/.{64}/g, '$&\n').replace(/\n$/, '')}\n-----END ${tipo}-----\n`;
}

/* --------------------------------------------------------------------- DER */

export interface Nodo { tag: number; inicio: number; cab: number; len: number; crudo: Uint8Array; valor: Uint8Array; }

/** Lee el elemento DER que empieza en `o`. */
export function leer(b: Uint8Array, o = 0): Nodo {
  const tag = b[o];
  let len = b[o + 1], cab = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new Error('DER: longitud no soportada');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[o + 2 + i];
    cab = 2 + n;
  }
  if (o + cab + len > b.length) throw new Error('DER: elemento truncado');
  return { tag, inicio: o, cab, len, crudo: b.subarray(o, o + cab + len), valor: b.subarray(o + cab, o + cab + len) };
}

/** Los hijos de un SEQUENCE/SET (o de un [n] construido). */
export function hijos(n: Nodo): Nodo[] {
  const out: Nodo[] = [];
  for (let o = 0; o < n.valor.length;) { const h = leer(n.valor, o); out.push(h); o += h.crudo.length; }
  return out;
}

function largo(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const xs: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) xs.unshift(v & 0xff);
  return Uint8Array.of(0x80 | xs.length, ...xs);
}

export const tlv = (tag: number, ...valor: Uint8Array[]) => { const v = concat(...valor); return concat(Uint8Array.of(tag), largo(v.length), v); };
export const seq = (...xs: Uint8Array[]) => tlv(0x30, ...xs);
export const set = (...xs: Uint8Array[]) => tlv(0x31, ...xs);
export const nulo = () => Uint8Array.of(0x05, 0x00);
export const octetos = (v: Uint8Array) => tlv(0x04, v);
export const utf8 = (s: string) => tlv(0x0c, bytes(s));
export const ctx = (n: number, ...xs: Uint8Array[]) => tlv(0xa0 + n, ...xs);

export function entero(v: number | Uint8Array): Uint8Array {
  let b = typeof v === 'number' ? (() => { const xs: number[] = []; let x = v; do { xs.unshift(x & 0xff); x = Math.floor(x / 256); } while (x > 0); return Uint8Array.from(xs); })() : v;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = concat(Uint8Array.of(0), b);
  return tlv(0x02, b);
}

export function oid(s: string): Uint8Array {
  const p = s.split('.').map(Number);
  const out: number[] = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) {
    const xs: number[] = [];
    let v = n;
    do { xs.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    for (let i = 0; i < xs.length - 1; i++) xs[i] |= 0x80;
    out.push(...xs);
  }
  return tlv(0x06, Uint8Array.from(out));
}

/** UTCTime (YYMMDDHHMMSSZ): lo que usan signingTime y los certificados antes de 2050. */
export function utcTime(d: Date): Uint8Array {
  const z = (n: number) => String(n).padStart(2, '0');
  return tlv(0x17, bytes(`${z(d.getUTCFullYear() % 100)}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`));
}

export const OID = {
  rsa: '1.2.840.113549.1.1.1',
  sha256Rsa: '1.2.840.113549.1.1.11',
  sha256: '2.16.840.1.101.3.4.2.1',
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
};

/** Emisor y número de serie de un certificado X.509 (DER), tal cual vienen. */
export function emisorYSerie(cert: Uint8Array): { emisor: Uint8Array; serie: Uint8Array; sujeto: Uint8Array } {
  const tbs = hijos(hijos(leer(cert))[0]);
  const i = tbs[0].tag === 0xa0 ? 1 : 0; // [0] version es opcional
  return { serie: tbs[i].crudo, emisor: tbs[i + 2].crudo, sujeto: tbs[i + 4].crudo };
}

/* ------------------------------------------------------------- llave RSA */

/** PKCS#1 (`BEGIN RSA PRIVATE KEY`, lo que suele dejar `openssl pkcs12`) -> PKCS#8. */
export function pkcs1APkcs8(pkcs1: Uint8Array): Uint8Array {
  return seq(entero(0), seq(oid(OID.rsa), nulo()), octetos(pkcs1));
}

/** Importa una llave privada RSA en PEM (PKCS#8 o PKCS#1) para firmar RS256. */
export async function llavePrivada(pemTexto: string): Promise<CryptoKey> {
  const [p8] = pemBloques(pemTexto, 'PRIVATE KEY');
  const [p1] = pemBloques(pemTexto, 'RSA PRIVATE KEY');
  const der = p8?.der ?? (p1 ? pkcs1APkcs8(p1.der) : null);
  if (!der) throw new Error('La llave privada no es PEM RSA (PKCS#8 o PKCS#1).');
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

export async function firmarRs256(llave: CryptoKey, datos: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', llave, datos));
}

/* ------------------------------------------------- PKCS#7 / CMS separada */

/**
 * Firma CMS SignedData SEPARADA (sin el contenido) de `contenido`, con
 * atributos firmados (contentType, signingTime, messageDigest) y SHA-256.
 * `certs[0]` es el certificado que firma; el resto viaja como cadena (Apple:
 * el intermedio WWDR).
 */
export async function firmaCms(contenido: Uint8Array, llave: CryptoKey, certs: Uint8Array[], ahora = new Date()): Promise<Uint8Array> {
  const { emisor, serie } = emisorYSerie(certs[0]);
  const algSha = seq(oid(OID.sha256), nulo());
  const attrs = [
    seq(oid(OID.contentType), set(oid(OID.data))),
    seq(oid(OID.signingTime), set(utcTime(ahora))),
    seq(oid(OID.messageDigest), set(octetos(await sha('SHA-256', contenido)))),
  ].sort(compararDer); // DER: los elementos de un SET van ordenados
  const firmados = set(...attrs);
  const firma = await firmarRs256(llave, firmados);
  const firmante = seq(
    entero(1),
    seq(emisor, serie),
    algSha,
    tlv(0xa0, ...attrs), // [0] IMPLICIT: mismo contenido que el SET firmado
    seq(oid(OID.rsa), nulo()),
    octetos(firma),
  );
  const signedData = seq(entero(1), set(algSha), seq(oid(OID.data)), tlv(0xa0, ...certs), set(firmante));
  return seq(oid(OID.signedData), ctx(0, signedData));
}

function compararDer(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/* --------------------------------------------------------------------- ZIP */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP sin compresión. Fecha fija: el mismo contenido da los mismos bytes. */
export function zip(archivos: { nombre: string; datos: Uint8Array }[]): Uint8Array {
  const partes: Uint8Array[] = [], central: Uint8Array[] = [];
  let o = 0;
  for (const a of archivos) {
    const nombre = bytes(a.nombre), crc = crc32(a.datos), n = a.datos.length;
    const loc = new DataView(new ArrayBuffer(30));
    loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint16(6, 0x0800, true);
    loc.setUint16(10, 0, true); loc.setUint16(12, 0x5b21, true); // 2025-08-01
    loc.setUint32(14, crc, true); loc.setUint32(18, n, true); loc.setUint32(22, n, true); loc.setUint16(26, nombre.length, true);
    partes.push(new Uint8Array(loc.buffer), nombre, a.datos);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(14, 0x5b21, true); cen.setUint32(16, crc, true); cen.setUint32(20, n, true); cen.setUint32(24, n, true);
    cen.setUint16(28, nombre.length, true); cen.setUint32(42, o, true);
    central.push(new Uint8Array(cen.buffer), nombre);
    o += 30 + nombre.length + n;
  }
  const dir = concat(...central);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true); fin.setUint16(8, archivos.length, true); fin.setUint16(10, archivos.length, true);
  fin.setUint32(12, dir.length, true); fin.setUint32(16, o, true);
  return concat(...partes, dir, new Uint8Array(fin.buffer));
}

/** Lee un ZIP sin compresión (el que escribe `zip`). Para pruebas y verificación. */
export function unzip(b: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), out = new Map<string, Uint8Array>();
  let o = 0;
  while (o + 30 <= b.length && v.getUint32(o, true) === 0x04034b50) {
    if (v.getUint16(o + 8, true) !== 0) throw new Error('ZIP: solo método 0');
    const n = v.getUint32(o + 18, true), ln = v.getUint16(o + 26, true), lx = v.getUint16(o + 28, true);
    const nombre = new TextDecoder().decode(b.subarray(o + 30, o + 30 + ln));
    const datos = b.subarray(o + 30 + ln + lx, o + 30 + ln + lx + n);
    if (crc32(datos) !== v.getUint32(o + 14, true)) throw new Error(`ZIP: CRC de ${nombre}`);
    out.set(nombre, datos);
    o += 30 + ln + lx + n;
  }
  return out;
}

/* --------------------------------------------------------------------- PNG */

async function deflate(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** PNG de `lado`×`lado` de un solo color (#rrggbb). */
export async function pngLiso(lado: number, color: string): Promise<Uint8Array> {
  const [r, g, bl] = rgb(color);
  const fila = new Uint8Array(1 + lado * 3);
  for (let x = 0; x < lado; x++) fila.set([r, g, bl], 1 + x * 3);
  const crudo = new Uint8Array(fila.length * lado);
  for (let y = 0; y < lado; y++) crudo.set(fila, y * fila.length);
  const trozo = (tipo: string, d: Uint8Array) => {
    const t = concat(bytes(tipo), d), c = new DataView(new ArrayBuffer(4)), l = new DataView(new ArrayBuffer(4));
    l.setUint32(0, d.length); c.setUint32(0, crc32(t));
    return concat(new Uint8Array(l.buffer), t, new Uint8Array(c.buffer));
  };
  const ihdr = new DataView(new ArrayBuffer(13));
  ihdr.setUint32(0, lado); ihdr.setUint32(4, lado); ihdr.setUint8(8, 8); ihdr.setUint8(9, 2);
  return concat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), trozo('IHDR', new Uint8Array(ihdr.buffer)),
    trozo('IDAT', await deflate(crudo)), trozo('IEND', new Uint8Array()));
}

export const esPng = (b: Uint8Array | null | undefined): b is Uint8Array =>
  !!b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** '#d0466c' -> [208, 70, 108]. Un color mal escrito no llega aquí (se valida al guardar). */
export function rgb(color: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) throw new Error(`Color inválido: ${color}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* --------------------------------------------------------------------- JWT */

export async function jwtRs256(claims: Record<string, unknown>, llave: CryptoKey, kid?: string): Promise<string> {
  const cab = b64url(bytes(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(kid ? { kid } : {}) })));
  const cuerpo = b64url(bytes(JSON.stringify(claims)));
  return `${cab}.${cuerpo}.${b64url(await firmarRs256(llave, bytes(`${cab}.${cuerpo}`)))}`;
}
