/**
 * NUBE LOCAL PARA PRUEBAS DE PUNTA A PUNTA DEL MENÚ EN LÍNEA (POS 0067).
 *
 *     node --no-warnings scripts/servidor-menu-local.mjs [--puerto 54399]
 *
 * Sirve por HTTP las Edge Functions REALES (_shared/pos-sync.ts y
 * _shared/menu-publico.ts) contra el Postgres desechable de
 * scripts/probar-fase3.mjs (contenedor `wybix-menu-prueba`; se crea si no
 * existe). Así la caja (Electron, WYBIX_FUNCIONES_URL) y la página del menú
 * (wybix-landing, WYBIX_BACKEND_LOCAL) hablan con la misma nube que en
 * producción, sin tocar producción:
 *
 *   POST /functions/v1/pos-sync
 *   GET|POST /functions/v1/menu-publico
 *   GET /salud
 *
 * Imprime `LISTO <puerto>` cuando acepta peticiones.
 */
import { createServer } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { manejarPosSync } from '../supabase/functions/_shared/pos-sync.ts';
import { manejarMenuPublico } from '../supabase/functions/_shared/menu-publico.ts';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOMBRE = process.env.WYBIX_PRUEBA_CONTENEDOR || 'wybix-menu-prueba';
const i = process.argv.indexOf('--puerto');
const PUERTO = Number(i > 0 ? process.argv[i + 1] : process.env.PUERTO || 54399);
const docker = (args) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (docker(['exec', NOMBRE, 'pg_isready', '-U', 'postgres']).status !== 0) {
  console.log(`(sin contenedor ${NOMBRE}: se crea con probar-fase3.mjs; tarda ~30 s)`);
  spawnSync(process.execPath, ['--no-warnings', join(RAIZ, 'scripts', 'probar-fase3.mjs'), '--conservar'],
    { stdio: 'ignore', env: { ...process.env, WYBIX_PRUEBA_CONTENEDOR: NOMBRE } });
}
for (const f of ['20261028130000_menu_en_linea.sql', '20261028150000_menu_diseno.sql']) {
  const mig = spawnSync('docker', ['exec', '-i', NOMBRE, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q'],
    { input: readFileSync(join(RAIZ, 'supabase', 'migrations', f), 'utf8'), encoding: 'utf8' });
  if (mig.status !== 0) { console.error(`migración ${f}:`, mig.stderr.slice(0, 400)); process.exit(1); }
}

/* RPC como PostgREST: rol service_role, función jsonb -> jsonb. */
const rpc = async (fn, p) => {
  if (!/^[a-z_]+$/.test(fn)) throw new Error('rpc inválida');
  const et = '$j' + randomUUID().replace(/-/g, '') + '$';
  const sql = `set role service_role; select public.${fn}(${et}${JSON.stringify(p)}${et}::jsonb)::text;`;
  /* Por stdin: una foto grande no cabe en la línea de comandos. */
  const stdout = await new Promise((ok, mal) => {
    const p = spawn('docker', ['exec', '-i', NOMBRE, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A']);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', mal);
    p.on('close', (c) => (c === 0 ? ok(out) : mal(new Error(`${fn}: ${err.slice(0, 300)}`))));
    p.stdin.end(sql);
  });
  return JSON.parse(stdout.trim() || 'null');
};
const depsSync = { rpc, espejo: { escribir: async () => null, existeAlerta: async () => false }, borrarUsuario: async () => {} };
const depsMenu = { rpc, hash: async (t) => createHash('sha256').update(t).digest('hex'), sal: 'sal-local' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PUERTO}`);
    if (url.pathname === '/salud') { res.writeHead(200); res.end('ok'); return; }
    const partes = [];
    for await (const c of req) partes.push(c);
    const cuerpo = partes.length ? Buffer.concat(partes) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    /* La IP la pondría el proxy de la web; aquí, la del socket. */
    if (!headers.get('x-forwarded-for')) headers.set('x-forwarded-for', String(req.socket.remoteAddress || '127.0.0.1'));
    const r = new Request(url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : cuerpo });
    let out;
    if (url.pathname === '/functions/v1/pos-sync') out = await manejarPosSync(r, depsSync);
    else if (url.pathname === '/functions/v1/menu-publico') out = await manejarMenuPublico(r, depsMenu);
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.error('error:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'local: ' + e.message }));
  }
}).listen(PUERTO, '127.0.0.1', () => console.log(`LISTO ${PUERTO}`));
