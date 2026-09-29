/**
 * GENERA UN PAR DE CLAVES DE FIRMA DE LICENCIAS (ES256 / P-256).
 *
 * DESARROLLO (claves que NUNCA firman licencias reales):
 *     node scripts/generar-llaves-licencia.mjs --dev [wybix-dev-N]
 *   Quedan en .secrets/ (ignorado por git). El POS solo confía en ellas sin
 *   empaquetar (npm start / pruebas), nunca en el instalador.
 *
 * PRODUCCIÓN (ceremonia; ver docs/licenciamiento-despliegue.md):
 *     node scripts/generar-llaves-licencia.mjs --produccion --kid wybix-lic-N --salida <carpeta>
 *   - <carpeta> tiene que estar FUERA de cualquier repositorio (idealmente
 *     una memoria cifrada o una carpeta temporal que se borra al terminar).
 *   - Se escribe la privada con permisos 0600 y NO se imprime nunca.
 *   - Se imprime la PÚBLICA y su huella SHA-256 (no son secretas).
 *   - Después: cargarla en el gestor de secretos de Supabase, guardar una
 *     copia en el gestor de contraseñas de la empresa y borrar el archivo.
 *
 * No sobrescribe un par existente: rotar es generar OTRO kid.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const produccion = args.includes('--produccion');
const dev = args.includes('--dev');

function fallar(msg) { console.error(`\n${msg}\n`); process.exit(1); }
if (produccion === dev) fallar('Indica --dev o --produccion.');

const huella = (pubPem) => createHash('sha256').update(pubPem.replace(/\s+/g, '')).digest('hex').slice(0, 16);

function dentroDeUnRepositorio(dir) {
  let d = resolve(dir);
  const r = spawnSync('git', ['-C', d, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  // git no está o la carpeta no existe: al menos no dentro de ESTE repo.
  const raiz = realpathSync(RAIZ);
  return (d + sep).startsWith(raiz + sep) ? raiz : null;
}

let kid, dir;
if (dev) {
  kid = args.find(a => /^wybix-dev-\d+$/.test(a)) || 'wybix-dev-1';
  dir = join(RAIZ, '.secrets');
} else {
  kid = opt('--kid');
  dir = opt('--salida');
  if (!/^wybix-lic-\d+$/.test(kid || '')) fallar('--kid tiene que ser wybix-lic-N (N = número de la clave).');
  if (!dir) fallar('Falta --salida <carpeta fuera del repositorio>.');
  mkdirSync(dir, { recursive: true });
  const repo = dentroDeUnRepositorio(dir);
  if (repo) fallar(`La carpeta está dentro del repositorio ${repo}. La clave privada de producción no puede vivir en un repositorio.`);
}

const priv = join(dir, `license-signing.${kid}.private.pem`);
const pub = join(dir, `license-signing.${kid}.public.pem`);
if (existsSync(priv)) fallar(`Ya existe ${priv}. Para rotar, usa otro kid.`);
mkdirSync(dir, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
writeFileSync(priv + '.tmp', privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
renameSync(priv + '.tmp', priv);
writeFileSync(pub, pubPem);

console.log(`\nkid:     ${kid}${dev ? '   (DESARROLLO: no firma licencias reales)' : ''}`);
console.log(`privada: ${priv}   (no se imprime)`);
console.log(`pública: ${pub}`);
console.log(`huella:  sha256:${huella(pubPem)}\n`);
console.log(pubPem);
if (produccion) {
  console.log(`Siguiente (sin copiar la privada a ningún otro lugar):
  1. supabase secrets set LICENSE_SIGNING_KEY="$(cat '${priv}')" LICENSE_SIGNING_KID=${kid}
  2. Agregar ${kid} a LICENSE_PUBLIC_KEYS (JSON con TODAS las públicas vigentes).
  3. Pegar la pública en POS: electron/licencia/llaves-publicas.js -> PRODUCCION['${kid}'].
  4. Guardar la privada en el gestor de contraseñas de la empresa (nota segura) y
     una copia cifrada fuera de línea. Después, borrar ${priv}.`);
}
