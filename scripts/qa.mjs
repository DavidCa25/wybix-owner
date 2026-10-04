/** QA por riesgo. Sin red productiva, builds remotos ni publicación. */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const nivel = process.argv[2] ?? 'quick';
if (!['quick', 'affected', 'integration', 'full'].includes(nivel)) throw new Error('Nivel inválido.');
const evidencia = [];
const tsc = require.resolve('typescript/bin/tsc');
const espacios = ['apps/owner', 'apps/pos-mobile', ...readdirSync(join(raiz, 'packages')).map(x => `packages/${x}`)];
const tests = dir => readdirSync(join(raiz, dir)).filter(f => f.endsWith('.test.ts')).map(f => `${dir}/${f}`);
const carpetas = ['apps/pos-mobile/test', 'supabase/functions/_shared/test', ...readdirSync(join(raiz, 'packages')).filter(p => {
  try { readdirSync(join(raiz, 'packages', p, 'test')); return true; } catch { return false; }
}).map(p => `packages/${p}/test`)];

function correr(args, cwd = raiz) {
  const inicio = Date.now();
  console.log(`\n> node ${args.join(' ')} (${cwd})`);
  const r = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env: process.env });
  evidencia.push({ command: ['node', ...args], cwd, exit: r.status, seconds: (Date.now() - inicio) / 1000 });
  if (r.error) throw r.error;
  return r.status === 0;
}
function archivosCambiados() {
  const git = args => {
    const r = spawnSync('git', args, { cwd: raiz, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || 'No se pudo leer Git.');
    return r.stdout.split('\0').filter(Boolean);
  };
  return [...new Set([...git(['diff', '--name-only', 'HEAD', '-z']), ...git(['ls-files', '--others', '--exclude-standard', '-z'])])];
}
let bien = true;
try {
  if (nivel !== 'integration') {
    for (const p of espacios) {
      const pkg = JSON.parse(readFileSync(join(raiz, p, 'package.json'), 'utf8'));
      if (pkg.scripts?.typecheck) bien = correr([tsc, '--noEmit', '-p', '.'], join(raiz, p)) && bien;
    }
    let dirs = carpetas;
    if (nivel === 'affected') {
      const diff = archivosCambiados();
      const transversal = diff.some(f => /^(package(-lock)?\.json|packages\/domain\/|packages\/database\/)/.test(f));
      dirs = transversal ? carpetas : carpetas.filter(d => diff.some(f => f.startsWith(d.replace(/\/test$/, '/') ) || (d.includes('_shared') && f.startsWith('supabase/'))));
      evidencia.push({ changedFiles: diff, selectedTests: dirs });
    }
    if (dirs.length) bien = correr(['--test', ...dirs.flatMap(tests)]) && bien;
  }
  if (nivel === 'integration' || nivel === 'full') bien = correr(['scripts/probar-fase3.mjs']) && bien;
} catch (e) {
  bien = false;
  evidencia.push({ error: e instanceof Error ? e.message : String(e) });
  console.error(e);
} finally {
  const carpeta = join(raiz, 'docs/evidencia/fase3/qa');
  mkdirSync(carpeta, { recursive: true });
  writeFileSync(join(carpeta, `${nivel}.json`), JSON.stringify({ at: new Date().toISOString(), level: nivel, ok: bien, evidence: evidencia }, null, 2) + '\n');
}
process.exit(bien ? 0 : 1);
