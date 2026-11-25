/**
 * PANEL DE ADMINISTRACIÓN DE LA PLATAFORMA, SIN TOCAR PRODUCCIÓN.
 *
 *     node --no-warnings scripts/probar-admin.mjs [--conservar]
 *
 * Sobre el contenedor de scripts/probar-fase3.mjs (toda la cadena de
 * migraciones, que ya incluye 20261122120000_admin_plataforma.sql; se crea
 * si no existe):
 *   1. las migraciones del panel se vuelven a aplicar (idempotentes);
 *   2. supabase/tests/admin-plataforma.test.sql: privilegios, identidad,
 *      auditoría de solo inserción, límite, comandos y consultas.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOMBRE = 'wybix-admin-prueba';
const MIGS = ['20261122120000_admin_plataforma.sql', '20261123120000_admin_gate.sql'].map((f) => join(RAIZ, 'supabase', 'migrations', f));
const PRUEBAS = join(RAIZ, 'supabase', 'tests', 'admin-plataforma.test.sql');
const conservar = process.argv.includes('--conservar');
let fallos = 0, pasos = 0;
const check = (id, ok, msg, det = '') => { pasos++; if (!ok) fallos++; console.log(`   ${ok ? 'ok   ' : 'FALLA'}  ${id}. ${msg}${det ? '  · ' + det : ''}`); };
const docker = (args, entrada) => { const r = spawnSync('docker', args, { input: entrada, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const psql = (s) => docker(['exec', '-i', NOMBRE, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A'], s);

const t0 = Date.now();
try {
  if (docker(['exec', NOMBRE, 'pg_isready', '-U', 'postgres']).code !== 0) {
    console.log('\n(no está el contenedor: se arma la cadena de la Fase 3, que incluye esta migración)');
    const f3 = spawnSync(process.execPath, ['--no-warnings', join(RAIZ, 'scripts', 'probar-fase3.mjs'), '--conservar'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, WYBIX_PRUEBA_CONTENEDOR: NOMBRE } });
    const resumen = (f3.stdout || '').trim().split(/\r?\n/).filter((l) => /comprobaciones|FALLA/.test(l)).slice(-6).join(' | ');
    check('AD-00', docker(['exec', NOMBRE, 'pg_isready', '-U', 'postgres']).code === 0, 'cadena completa de migraciones', resumen);
  }

  console.log('\nPANEL ADMIN · migraciones\n');
  for (const m of MIGS) {
    const a = psql(readFileSync(m, 'utf8'));
    check('AD-MIG', a.code === 0, `${basename(m)} se vuelve a aplicar (idempotente)`, a.err.replace(/^(NOTICE|WARNING).*$/gm, '').trim().slice(0, 400));
  }

  console.log('\nPANEL ADMIN · pruebas SQL\n');
  const r = psql(readFileSync(PRUEBAS, 'utf8'));
  if (r.code !== 0) check('AD-SQL', false, 'admin-plataforma.test.sql', r.err.trim().slice(0, 600));
  for (const l of r.out.split(/\r?\n/).filter((x) => /^(ok|FALLA)\|/.test(x))) {
    const [e, id, ...m] = l.split('|');
    check(id, e === 'ok', m.join('|'));
  }
} finally {
  if (!conservar) docker(['rm', '-f', NOMBRE]);
}
console.log(`\n${pasos - fallos}/${pasos} comprobaciones · ${((Date.now() - t0) / 1000).toFixed(1)} s${fallos ? ` · ${fallos} FALLAS` : ''}\n`);
process.exit(fallos ? 1 : 0);
