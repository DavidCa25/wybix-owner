/**
 * FASE 3 · PRUEBAS DE LA NUBE (Postgres 17 desechable; sin tocar producción).
 *
 *     node scripts/probar-fase3.mjs [--conservar]   (deja el contenedor para revisarlo)
 *
 * Cadena real: base heredada -> licencias -> Fase 1 (+ sus pruebas, que
 * siembran I Do Nut) -> Fase 2 (+ sus pruebas) -> estado de producción no
 * versionado (tests/fase3-antes.sql) -> migraciones de la Fase 3 DOS veces
 * -> tests/fase3.test.sql.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SB = join(RAIZ, 'supabase');
const NOMBRE = 'wybix-fase3-prueba';
const CADENA = ['tests/auth-emulado.sql', 'migrations/20260901000000_base_nube_legado.sql', 'migrations/20260926120000_licenciamiento_v2.sql',
  'migrations/20260926130000_pos_sync_sin_service_role.sql', 'migrations/20260927120000_licenciamiento_v2_final.sql',
  'tests/fase1-datos-legado.sql', 'migrations/20261002120000_fase1_multiempresa.sql'];
const F2 = 'migrations/20261010120000_fase2_event_mobile.sql';
// Fase 3: todo lo posterior a la Fase 2, en orden.
const F3 = readdirSync(join(SB, 'migrations')).filter((f) => f.endsWith('.sql') && f > '20261010120000_fase2_event_mobile.sql').sort().map((f) => `migrations/${f}`);

let fallos = 0, pasos = 0;
const check = (id, ok, msg, det = '') => { pasos++; if (!ok) fallos++; console.log(`   ${ok ? 'ok   ' : 'FALLA'}  ${id}. ${msg}${det ? '  · ' + det : ''}`); };
const docker = (args, entrada) => { const r = spawnSync('docker', args, { input: entrada, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const psql = (sql) => docker(['exec', '-i', NOMBRE, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A'], sql);
const aplicar = (rel) => { const r = psql(readFileSync(join(SB, rel), 'utf8')); return { ok: r.code === 0, err: r.err.replace(/^(NOTICE|WARNING).*$/gm, '').trim().slice(0, 400) }; };
const correrPruebas = (rel, prefijo) => {
  const r = psql(readFileSync(join(SB, rel), 'utf8'));
  if (r.code !== 0) check(`${prefijo}00`, false, rel, r.err.slice(0, 400));
  return r.out.split(/\r?\n/).filter((x) => /^(ok|FALLA)\|/.test(x)).map((l) => { const [e, id, ...m] = l.split('|'); return { ok: e === 'ok', id, msg: m.join('|') }; });
};

const t0 = Date.now();
try {
  docker(['rm', '-f', NOMBRE]);
  const r0 = docker(['run', '-d', '--name', NOMBRE, '-e', 'POSTGRES_PASSWORD=prueba', 'postgres:17-alpine']);
  if (r0.code !== 0) throw new Error(`docker run: ${r0.err}`);
  for (let i = 0; i < 60; i++) { if (docker(['exec', NOMBRE, 'pg_isready', '-U', 'postgres']).code === 0 && psql('select 1').code === 0) break; await new Promise((r) => setTimeout(r, 1000)); }

  console.log('\nFASE 3 · cadena previa (Fase 1 y Fase 2 con sus datos)\n');
  for (const m of CADENA) { const a = aplicar(m); if (!a.ok) check('F3-BASE', false, m, a.err); }
  const f1 = correrPruebas('tests/fase1.test.sql', 'F1-');
  check('F3-BASE01', f1.length > 0 && f1.every((x) => x.ok), `Fase 1 sigue verde antes de la Fase 3 (${f1.filter((x) => x.ok).length}/${f1.length})`);
  const a2 = aplicar(F2); if (!a2.ok) check('F3-BASE', false, F2, a2.err);
  const f2 = correrPruebas('tests/fase2.test.sql', 'F2-').filter((x) => x.id.startsWith('F2-'));
  check('F3-BASE02', f2.length > 0 && f2.every((x) => x.ok), `Fase 2 sigue verde antes de la Fase 3 (${f2.filter((x) => x.ok).length}/${f2.length})`,
    f2.filter((x) => !x.ok).map((x) => x.id).join(', '));

  console.log(`\nFASE 3 · migraciones (${F3.length}), dos veces sobre el estado de producción\n`);
  const antes = aplicar('tests/fase3-antes.sql'); if (!antes.ok) check('F3-BASE', false, 'fase3-antes.sql', antes.err);
  for (const vez of [1, 2]) for (const m of F3) { const a = aplicar(m); check(`F3-MIG${vez}`, a.ok, `${m.replace('migrations/', '')} (vez ${vez})`, a.err); }

  console.log('\nFASE 3 · pruebas\n');
  for (const x of correrPruebas('tests/fase3.test.sql', 'F3-')) check(x.id, x.ok, x.msg);
} catch (e) {
  check('F3-Z', false, 'la prueba se interrumpió', e.message);
} finally {
  if (!process.argv.includes('--conservar')) docker(['rm', '-f', NOMBRE]);
  else console.log(`
(contenedor ${NOMBRE} conservado: docker exec -it ${NOMBRE} psql -U postgres)`);
}
console.log(`\n${pasos - fallos}/${pasos} comprobaciones correctas${fallos ? ` · ${fallos} FALLAS` : ''} · ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(fallos ? 1 : 0);
