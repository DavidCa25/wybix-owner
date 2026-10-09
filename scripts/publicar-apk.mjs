/**
 * PUBLICAR UN APK BAJO EL DOMINIO DE WYBIX.
 *
 *     npm run publicar:apk -- dueno <build-id>
 *     npm run publicar:apk -- pos-mobile <build-id>
 *
 * Baja el APK de un build TERMINADO de EAS y lo sube, con nombre fijo, a la
 * publicación `apps` de GitHub (DavidCa25/POS_Hidromec). La gente lo descarga de:
 *
 *     https://www.wybixpos.com.mx/descargas/dueno        (app del dueño)
 *     https://www.wybixpos.com.mx/descargas/pos-mobile   (POS Mobile)
 *
 * El enlace nunca dice Expo y no cambia de una versión a otra (vercel.json de
 * wybix-landing reenvía a la descarga de GitHub).
 *
 * POR QUÉ UNA PRERELEASE
 *   Las cajas se actualizan del «último release» de ese repositorio. Una
 *   prerelease no cuenta como último: el actualizador del POS nunca la ve.
 *
 * POR QUÉ NO SUPABASE STORAGE
 *   El plan limita cada archivo a 50 MB y un APK pesa más de 90.
 *
 * El token sale de %USERPROFILE%\.wybix\publicar.env (GH_TOKEN), el mismo de
 * `npm run publish` en el POS. Nunca se imprime.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const DUENO = 'DavidCa25', REPO = 'POS_Hidromec', TAG = 'apps';
const APPS = {
  dueno: { carpeta: 'apps/owner', archivo: 'wybix-dueno.apk', nombre: 'Wybix (app del dueño)' },
  'pos-mobile': { carpeta: 'apps/pos-mobile', archivo: 'wybix-pos-mobile.apk', nombre: 'Wybix POS Mobile' },
};
const [app, buildId] = process.argv.slice(2);
if (!APPS[app] || !buildId) {
  console.error('Uso: npm run publicar:apk -- <dueno|pos-mobile> <build-id>');
  process.exit(1);
}
const { carpeta, archivo, nombre } = APPS[app];

function token() {
  if (process.env.GH_TOKEN?.trim()) return process.env.GH_TOKEN.trim();
  const f = join(homedir(), '.wybix', 'publicar.env');
  if (existsSync(f)) {
    const l = readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/).find((x) => /^\s*(export\s+)?GH_TOKEN\s*=/i.test(x));
    const v = l?.replace(/^\s*(export\s+)?GH_TOKEN\s*=\s*/i, '').replace(/^["']|["']$/g, '').trim();
    if (v) return v;
  }
  throw new Error(`No encuentro GH_TOKEN (variable de entorno o ${f}).`);
}
const TOKEN = token();
const gh = async (url, opciones = {}) => {
  const r = await fetch(url.startsWith('http') ? url : `https://api.github.com/repos/${DUENO}/${REPO}${url}`, {
    ...opciones,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opciones.headers || {}) },
  });
  if (r.status === 404 && opciones.method !== 'POST') return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({})))?.message || 'sin detalle'}`);
  return r.status === 204 ? {} : r.json();
};

const build = JSON.parse(execFileSync('npx', ['eas-cli', 'build:view', buildId, '--json'], { cwd: carpeta, encoding: 'utf8', shell: true }));
if (build.status !== 'FINISHED') { console.error(`El build ${buildId} está ${build.status}, no terminado.`); process.exit(1); }
const url = build.artifacts?.buildUrl;
if (!url || !url.endsWith('.apk')) { console.error('Ese build no produjo un APK (¿perfil de App Bundle?).'); process.exit(1); }

const r = await fetch(url);
if (!r.ok) throw new Error(`No se pudo bajar el APK: HTTP ${r.status}`);
const apk = Buffer.from(await r.arrayBuffer());
console.log(`APK ${build.appVersion} (${build.appBuildVersion}) · ${(apk.length / 1048576).toFixed(1)} MB`);

let rel = await gh(`/releases/tags/${TAG}`);
if (!rel) {
  rel = await gh('/releases', { method: 'POST', body: JSON.stringify({
    tag_name: TAG, name: 'Apps de Wybix', prerelease: true, draft: false,
    body: 'Instaladores de las apps de Wybix. Se descargan desde https://www.wybixpos.com.mx/descargas — no es una versión del POS.',
  }) });
}
if (!rel.prerelease) throw new Error(`La publicación «${TAG}» no es prerelease: el actualizador de las cajas podría tomarla.`);

for (const a of rel.assets || []) {
  if (a.name === archivo) await gh(`/releases/assets/${a.id}`, { method: 'DELETE' });
}
const subida = `${rel.upload_url.replace(/\{.*\}$/, '')}?name=${encodeURIComponent(archivo)}&label=${encodeURIComponent(`${nombre} ${build.appVersion} (${build.appBuildVersion})`)}`;
/* curl y no fetch: 90 MB por fetch se cortaban (ECONNRESET). El token va
   en un archivo de cabeceras temporal, no en la línea de comandos. */
const tmp = mkdtempSync(join(tmpdir(), 'wybix-apk-'));
try {
  writeFileSync(join(tmp, 'apk'), apk);
  writeFileSync(join(tmp, 'h'), `Authorization: Bearer ${TOKEN}
Content-Type: application/vnd.android.package-archive
Accept: application/vnd.github+json
`, { mode: 0o600 });
  const out = execFileSync('curl', ['-sS', '--fail-with-body', '--retry', '3', '-H', `@${join(tmp, 'h')}`, '--data-binary', `@${join(tmp, 'apk')}`, subida], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (!/"state"\s*:\s*"uploaded"/.test(out)) throw new Error(`GitHub no confirmó la subida: ${out.slice(0, 200)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`Publicado: https://www.wybixpos.com.mx/descargas/${app}`);
