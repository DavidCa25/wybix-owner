/**
 * PRUEBAS DE LA MIGRACIÓN DE LICENCIAMIENTO Y DE SU DESPLIEGUE, SIN TOCAR PRODUCCIÓN.
 *
 *     node scripts/probar-licenciamiento.mjs [--web ../wybix-landing]
 *
 * Levanta un Postgres 17 desechable en Docker (la versión de producción) con
 * la réplica del esquema real de licencias (supabase/tests/base-produccion.sql)
 * y recorre el despliegue en el orden real:
 *
 *   PARTE A (transición)  se aplica dos veces (idempotente) + pruebas SQL.
 *   ROLLOUT en A          la web ANTERIOR (la de producción, rama main) y la
 *                         web NUEVA emiten licencias contra la base de
 *                         transición, por HTTP, con sus manejadores reales
 *                         (api/license/issue.ts) y un PostgREST mínimo. La web
 *                         nueva genera su catálogo desde la base.
 *   PARTE B (final)       se aplica dos veces + pruebas SQL del estado final.
 *   ROLLOUT en B          la web nueva sigue emitiendo; la anterior ya no
 *                         (por eso B va después de reemplazarla).
 *
 * PayPal y Resend se simulan; Supabase no: todo va contra Postgres de verdad.
 */
import { spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crearRest } from './lib/rest-minimo.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { firmar, importarClavePrivada, payloadDeLicencia, verificar } from '../supabase/functions/_shared/certificado.ts';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOMBRE = 'wybix-licencias-prueba';
const MIG_A = join(RAIZ, 'supabase/migrations/20260926120000_licenciamiento_v2.sql');
const MIG_B = join(RAIZ, 'supabase/migrations/20260927120000_licenciamiento_v2_final.sql');
const iWeb = process.argv.indexOf('--web');
const WEB = resolve(iWeb > 0 ? process.argv[iWeb + 1] : join(RAIZ, '..', 'wybix-landing'));
let fallos = 0, omitidas = 0, pasos = 0;
const log = (s) => console.log(s);
/* El catálogo se genera en OTRO proceso que llama al REST de ESTE: no se puede
   bloquear el event loop con spawnSync. */
const execFileP = promisify(execFile);
async function generarCatalogo(anon) {
  try {
    const r = await execFileP(process.execPath, [join(WEB, 'scripts/catalogo.mjs')], { cwd: WEB,
      env: { ...process.env, SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: anon } });
    return { status: 0, salida: r.stdout + r.stderr };
  } catch (e) { return { status: e.code ?? 1, salida: String(e.stderr || e.message) }; }
}
const leerJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

function docker(args, entrada) {
  const r = spawnSync('docker', args, { input: entrada, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const psql = (sql, extra = []) => docker(['exec', '-i', NOMBRE, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A', ...extra], sql);
const psqlAsync = (sql) => new Promise((res) => {
  const p = spawn('docker', ['exec', '-i', NOMBRE, 'psql', '-U', 'postgres', '-X', '-q', '-t', '-A', '-c', sql]);
  let out = ''; p.stdout.on('data', d => { out += d; }); p.on('close', () => res(out.trim()));
});
const uno = (sql) => psql(sql).out.trim();
const check = (id, ok, msg, det = '') => {
  pasos++; if (!ok) fallos++;
  log(`   ${ok ? 'ok   ' : 'FALLA'}  ${id}. ${msg}${det ? '  · ' + det : ''}`);
};
const omitir = (id, msg) => { omitidas++; log(`   SKIP   ${id}. ${msg}`); };
function correrSql(archivo) {
  const t = psql(readFileSync(archivo, 'utf8'));
  if (t.code !== 0) { fallos++; log(`FALLA al correr ${archivo}: ${t.err.trim().slice(0, 400)}`); return; }
  for (const linea of t.out.split(/\r?\n/).filter(l => /^(ok|FALLA)\|/.test(l))) {
    const [estado, id, msg] = linea.split('|');
    check(id, estado === 'ok', msg);
  }
}

// ------------------------------------------------------------------ web por HTTP
const PAGOS = new Map();         // orderId -> importe capturado (MXN)
const fetchReal = globalThis.fetch;
globalThis.fetch = async (entrada, init = {}) => {
  const url = String(entrada instanceof Request ? entrada.url : entrada);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('paypal.com/v1/oauth2/token')) return json({ access_token: 'token-prueba' });
  const orden = url.match(/paypal\.com\/v2\/checkout\/orders\/([^/?]+)/);
  if (orden) {
    const monto = PAGOS.get(decodeURIComponent(orden[1]));
    if (monto == null) return json({ message: 'no existe' }, 404);
    const amount = { value: monto.toFixed(2), currency_code: 'MXN' };
    return json({ status: 'COMPLETED', purchase_units: [{ amount, payments: { captures: [{ status: 'COMPLETED', amount }] } }] });
  }
  if (url.includes('api.resend.com')) return json({ id: 'correo-prueba' });
  return fetchReal(entrada, init);
};

async function cargarManejador(codigo, nombre, dir) {
  const archivo = join(dir, `${nombre}.mts`);
  writeFileSync(archivo, codigo);
  return (await import(pathToFileURL(archivo).href)).default;
}
async function pedir(manejador, body) {
  let status = 200, salida = null;
  const res = {
    setHeader() {}, end() { return this; },
    status(c) { status = c; return this; },
    json(o) { salida = o; return this; },
  };
  await manejador({ method: 'POST', body, headers: {} }, res);
  return { status, body: salida };
}

try {
  docker(['rm', '-f', NOMBRE]);
  const r = docker(['run', '-d', '--name', NOMBRE, '-e', 'POSTGRES_PASSWORD=prueba', 'postgres:17-alpine']);
  if (r.code !== 0) throw new Error(`docker run: ${r.err}`);
  for (let i = 0; i < 60; i++) {
    if (docker(['exec', NOMBRE, 'pg_isready', '-U', 'postgres']).code === 0 && psql('select 1').code === 0) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  log('\nLICENCIAMIENTO v2 · Postgres 17 desechable\n');

  // ================================================================ PARTE A
  log('   · PARTE A (transición)');
  const base = psql(readFileSync(join(RAIZ, 'supabase/tests/base-produccion.sql'), 'utf8'));
  check('M01', base.code === 0, 'réplica del esquema de producción cargada', base.err.trim().slice(0, 200));
  const sqlA = readFileSync(MIG_A, 'utf8');
  const m1 = psql(sqlA);
  check('M02', m1.code === 0, 'la PARTE A se aplica', m1.code === 0 ? '' : m1.err.trim().slice(0, 300));
  const m2 = psql(sqlA);
  check('M03', m2.code === 0, 'y se puede aplicar otra vez (idempotente)', m2.code === 0 ? '' : m2.err.trim().slice(0, 300));
  const dup = uno(`select (select count(*) from license_verticals)||'/'||(select count(*) from license_purchases)||'/'||(select count(*) from license_subscriptions)||'/'||(select count(*) from license_catalog);`);
  check('M03', dup === '0/4/2/21', 'repetirla no duplica nada ni reparte giros (giros/compras/periodos/catálogo)', dup);

  /* Carrera: dos computadoras activan la misma MonoCaja a la vez. */
  psql(`insert into licenses (id, license_key, plan, customer_name, max_registers) values ('00000000-0000-0000-0000-000000000020', 'WYBX-CARR-0020', 'mono', 'Carrera', 1);
        insert into license_verticals (license_id, vertical) values ('00000000-0000-0000-0000-000000000020', 'COMMERCE');`);
  const res = await Promise.all(['PC-1', 'PC-2', 'PC-3', 'PC-4'].map(m => psqlAsync(`select license_activate('WYBX-CARR-0020', '${m}')->>'ok'`)));
  const activas = uno(`select count(*) from license_activations where license_id = '00000000-0000-0000-0000-000000000020' and active;`);
  const incluidos = uno(`select count(*) from license_subscriptions where license_id = '00000000-0000-0000-0000-000000000020';`);
  check('A09', res.filter(x => x === 'true').length === 1 && activas === '1' && incluidos === '1',
    'cuatro activaciones simultáneas de una MonoCaja: solo una entra y hay un solo primer año', `${res.join(',')} · activas ${activas} · periodos ${incluidos}`);

  correrSql(join(RAIZ, 'supabase/tests/licenciamiento.test.sql'));

  // ================================================================ ROLLOUT en A
  log('\n   · ROLLOUT contra la base de TRANSICIÓN (web anterior y web nueva, por HTTP)');
  const rest = await crearRest(psql, { 'clave-anon': 'anon', 'clave-servicio': 'service_role' });
  Object.assign(process.env, {
    SUPABASE_URL: rest.url, SUPABASE_SERVICE_ROLE_KEY: 'clave-servicio', SUPABASE_ANON_KEY: 'clave-anon',
    PAYPAL_CLIENT_ID: 'prueba', PAYPAL_SECRET: 'prueba', PAYPAL_ENV: 'sandbox', RESEND_API_KEY: 'prueba',
  });
  const hayWeb = existsSync(join(WEB, 'api/license/issue.ts'));
  let webAnterior = null, webNueva = null;
  const tmp = mkdtempSync(join(tmpdir(), 'wybix-rollout-'));
  if (hayWeb) {
    const anterior = spawnSync('git', ['-C', WEB, 'show', 'main:api/license/issue.ts'], { encoding: 'utf8' });
    if (anterior.status === 0) webAnterior = await cargarManejador(anterior.stdout, 'issue-anterior', tmp);
    webNueva = await cargarManejador(readFileSync(join(WEB, 'api/license/issue.ts'), 'utf8'), 'issue-nueva', tmp);
  }
  const lic = (clave) => { const t = uno(`select row_to_json(l) from licenses l where license_key = '${clave}'`); return t ? JSON.parse(t) : null; };

  if (!webAnterior) omitir('W01', `web anterior no disponible (${WEB}, rama main)`);
  else {
    // Producción (main): MultiCaja con 3 cajas, esperaba 3999 + IVA.
    PAGOS.set('ANT-1', 4638.84);
    const a = await pedir(webAnterior, { orderId: 'ANT-1', plan: 'multi', cajas: 3, email: 'viejo@example.com', nombre: 'Cliente web anterior',
      items: [{ kind: 'plan', id: 'multicaja', name: 'Multicaja', qty: 1, importe: 3999 }] });
    const l = a.body?.licenseKey ? lic(a.body.licenseKey) : null;
    check('W01', a.status === 200 && !!l && l.plan === 'multi' && l.max_registers === 3,
      'web ANTERIOR contra la transición: emite como siempre (MultiCaja guardada con su contrato: max_registers = cajas)', `${a.status} ${JSON.stringify(a.body).slice(0, 80)}`);
    if (l) {
      const acts = [1, 2, 3, 4, 5].map(i => uno(`select license_activate('${l.license_key}', 'ANT-PC-${i}')->>'ok'`));
      check('W01', acts.every(x => x === 'true'), 'y esa MultiCaja activa 5 cajas con el license-check nuevo (las cajas salen de la edición)');
      check('W01', uno(`select count(*) from license_review_queue where license_key = '${l.license_key}' and 'SIN_GIRO' = any(reasons)`) === '1',
        'la web anterior no conoce giros: su licencia queda en la cola de revisión, sin giros regalados');
    }
  }

  if (!webNueva) omitir('W02', `web nueva no disponible (${WEB})`);
  else {
    PAGOS.set('NUE-1', 3188.84);  // (2,499 + 250) + IVA
    const n = await pedir(webNueva, { orderId: 'NUE-1', edition: 'EDITION_MONO', vertical: 'HOSPITALITY', cajas: 1,
      items: [{ code: 'EXTRA_CFDI_100', qty: 1, price: 0.01 }], email: 'nuevo@example.com', nombre: 'Cliente web nueva',
      consent: { privacy_version: '2026-10-01', terms_version: '2026-10-01', accepted_at: '2026-10-02T15:04:05.000Z', marketing: false } });
    const l = n.body?.licenseKey ? lic(n.body.licenseKey) : null;
    check('W02', n.status === 200 && !!l && l.plan === 'mono' && l.max_registers === 1 && l.origin === 'TEST',
      'web NUEVA contra la transición: emite MonoCaja (origen TEST con PayPal sandbox)', `${n.status} ${JSON.stringify(n.body).slice(0, 100)}`);
    if (l) {
      check('W02', uno(`select string_agg(vertical, ',') from license_verticals where license_id = '${l.id}'`) === 'HOSPITALITY'
        && uno(`select string_agg(catalog_code || ':' || price_paid, ',' order by catalog_code) from license_purchases where license_id = '${l.id}'`) === 'EDITION_MONO:2499.00,EXTRA_CFDI_100:250.00',
        'con su ÚNICO giro y cada línea al precio del catálogo (el precio que mandó el navegador se ignoró)');
      const otra = await pedir(webNueva, { orderId: 'NUE-1', edition: 'EDITION_MONO', vertical: 'HOSPITALITY', items: [{ code: 'EXTRA_CFDI_100' }] });
      check('W03', otra.status === 200 && otra.body?.licenseKey === l.license_key, 'el mismo pago otra vez: la MISMA licencia');
      const ev = uno(`select data::text from license_events where license_id = '${l.id}' and type = 'CHECKOUT_TERMS_ACCEPTED'`);
      const d = ev ? JSON.parse(ev) : {};
      check('WC1', d.privacy_version === '2026-10-01' && d.terms_version === '2026-10-01' && d.accepted_at === '2026-10-02T15:04:05.000Z'
        && d.marketing_opt_in === false && d.order_ref === 'NUE-1'
        && uno(`select count(*) from license_events where license_id = '${l.id}' and type like 'CHECKOUT_%'`) === '1'
        && !/nuevo@example\.com|Cliente web nueva/.test(ev || ''),
        'la aceptación del checkout queda como evidencia: versiones, fecha, orden, marketing aparte; sin datos personales y una sola vez', ev || 'sin evento');
    }
    PAGOS.set('NUE-2', 2898.84);  // pagó una MonoCaja...
    const t = await pedir(webNueva, { orderId: 'NUE-2', edition: 'EDITION_MULTI', vertical: 'COMMERCE', items: [] });
    check('W04', t.status === 402 && uno(`select count(*) from licenses where paypal_order_id = 'NUE-2'`) === '0',
      '...y pide MultiCaja: 402, no se emite nada', `${t.status}`);
    PAGOS.set('NUE-3', 99999);
    const d = await pedir(webNueva, { orderId: 'NUE-3', edition: 'EDITION_MONO', vertical: 'COMMERCE', items: [{ code: 'SUBSCRIPTION_ANNUAL' }] });
    check('W05', d.status === 400 && d.body?.code === 'NOT_SOLD_HERE', 'un producto sin precio (suscripción anual) no se puede cobrar', `${d.status} ${d.body?.code}`);
    // Pedido de la web anterior repetido en la nueva: no emite otra licencia.
    if (webAnterior) {
      const rep = await pedir(webNueva, { orderId: 'ANT-1', edition: 'EDITION_MULTI', vertical: 'COMMERCE', items: [] });
      check('W06', rep.status === 200 && rep.body?.licenseKey === lic(uno(`select license_key from licenses where paypal_order_id = 'ANT-1'`))?.license_key,
        'un pago que ya emitió la web anterior, reenviado a la nueva: la misma licencia, no otra');
    }
  }

  // Cotizar ANTES de pagar: el importe que cobra el checkout.
  if (!hayWeb || !existsSync(join(WEB, 'api/license/quote.ts'))) omitir('WQ', 'endpoint de cotización no disponible');
  else {
    const cotizar = await cargarManejador(readFileSync(join(WEB, 'api/license/quote.ts'), 'utf8'), 'quote', tmp);
    const q1 = await pedir(cotizar, { edition: 'EDITION_MONO', vertical: 'COMMERCE', items: [{ code: 'EXTRA_CFDI_100', qty: 1, price: 1 }] });
    check('WQ1', q1.status === 200 && q1.body?.total === 3188.84, 'el checkout cobra lo que cotiza el servidor desde el catálogo ($2,499 + $250 + IVA), no lo que diga el navegador', `${q1.status} ${q1.body?.total}`);
    psql(`select license_catalog_update('EXTRA_CFDI_100', '{"list_price": 275}', 'prueba de cambio de precio', 'admin:qa')`);
    const q2 = await pedir(cotizar, { edition: 'EDITION_MONO', vertical: 'COMMERCE', items: [{ code: 'EXTRA_CFDI_100' }] });
    psql(`select license_catalog_update('EXTRA_CFDI_100', '{"list_price": 250}', 'vuelve al precio vigente', 'admin:qa')`);
    check('WQ2', q2.body?.total === 3217.84, 'un precio cambiado en la base se cobra de inmediato, sin recompilar la web', `${q2.body?.total}`);
    const urlBuena = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = 'http://127.0.0.1:9';
    const q3 = await pedir(cotizar, { edition: 'EDITION_MONO', vertical: 'COMMERCE', items: [] });
    process.env.SUPABASE_URL = urlBuena;
    check('WQ3', q3.status === 503 && q3.body?.ok === false && q3.body?.total === undefined,
      'catálogo caído: no hay total (el checkout no ofrece pagar ni adivina)', `${q3.status}`);
  }

  // Catálogo de la web: se GENERA desde la base (lectura pública).
  if (!hayWeb) omitir('W07', 'web no disponible');
  else {
    const g = await generarCatalogo('clave-anon');
    const archivo = join(WEB, 'src/data/catalogo.generado.json');
    const cat = leerJson(archivo);
    const p = (c) => cat?.productos?.find(x => x.code === c);
    check('W07', g.status === 0 && p('EDITION_MONO')?.list_price === 2499 && p('EDITION_MULTI')?.list_price === 3999
      && p('SUBSCRIPTION_ANNUAL')?.list_price === null && p('TAX_IVA_MX')?.grants?.rate === 0.16,
      'la web genera su catálogo desde license_catalog con la clave pública: $2,499, $3,999, anual por definir, IVA 16 %', g.salida.trim().slice(0, 120));
    psql(`update license_catalog set active = false where code = 'EXTRA_ONBOARDING'`);
    await generarCatalogo('clave-anon');
    const sinInactivo = !(leerJson(archivo)?.productos ?? [{ code: 'EXTRA_ONBOARDING' }]).some(x => x.code === 'EXTRA_ONBOARDING');
    psql(`update license_catalog set active = true where code = 'EXTRA_ONBOARDING'`);
    await generarCatalogo('clave-anon');
    check('W07', sinInactivo, 'un producto desactivado en la base desaparece de la web en la siguiente compilación');
    const malo = await generarCatalogo('clave-equivocada');
    check('W07', malo.status !== 0, 'si no puede leer la fuente de verdad, la compilación FALLA (no publica precios viejos)');
  }

  // ================================================================ LAS 7 LICENCIAS
  log('\n   · CLASIFICAR Y REEMITIR las 7 licencias existentes (réplica: mismos id, fin de clave, edición y equipos)');
  {
    const R = [
      ['94aac9c6-82b9-4047-ab25-318a018568a0', 'SMBM', 'mono', 1, [['fc3f3c-vm', '2026-07-10', true]]],
      ['14151809-5336-42b6-b231-a08ffd916718', 'E8FH', 'mono', 1, [['87ed64-vm', '2026-07-20', false]]],
      ['3db46dcb-e6ac-42e8-8ea7-3377f812b076', '6AJY', 'mono', 1, [['0588da-vm', '2026-07-23', false]]],
      ['8bf0ca6a-cd9f-4138-ae12-2f5766384fc7', 'V332', 'multi', 0, [['0588da-vm2', '2026-07-23', true]]],
      ['b4a22322-cd10-4e4b-ac3b-2535bad7a06b', '5UE6', 'mono', 1, []],
      ['7484b07f-fcd5-4b09-8f44-b7ddb01e1adc', 'UU7X', 'multi', 0, [['87ed64-qa', '2026-09-11', true], ['9d18ec-qa', '2026-09-11', true]]],
      ['81666a44-8276-4173-bc91-c9692f83d809', '4PKH', 'mono', 1, [['46f980-vm', '2026-09-19', true]]],
    ];
    const sqlR = R.map(([id, fin, plan, max, eqs]) =>
      `insert into licenses (id, license_key, plan, customer_name, max_registers) values ('${id}', 'WYBX-MREP-${fin}', '${plan}', 'Prueba VM', ${max});` +
      eqs.map(([m, f, a]) => `insert into license_activations (license_id, machine_id, first_seen_at, active) values ('${id}', '${m}', '${f}', ${a});`).join('')).join('\n');
    const ins = psql(sqlR);
    // La PARTE A otra vez: hace sobre ellas lo mismo que hará en producción (primer año desde su activación, historial).
    const reA = psql(readFileSync(MIG_A, 'utf8'));
    check('CL0', ins.code === 0 && reA.code === 0, 'réplica de las 7 cargada y la PARTE A aplicada sobre ellas', ins.code === 0 && reA.code === 0 ? '' : (ins.err + reA.err).trim().slice(0, 200));
    const script = readFileSync(join(RAIZ, 'supabase/data/2026-09-26_clasificar-licencias-existentes.sql'), 'utf8');
    const conCommit = script.replace(/^rollback;.*$/m, 'commit;');
    const r1 = psql(conCommit);
    const r2 = psql(conCommit);
    check('CL1', r1.code === 0 && r2.code === 0, 'el script de clasificación corre (y otra vez, idempotente)', (r1.err + r2.err).trim().slice(0, 300));
    const ids = R.map(r => `'${r[0]}'`).join(',');
    check('CL1', uno(`select string_agg(origin, ',' order by origin) from licenses where id in (${ids})`) === 'INTERNAL,QA,QA,TEST,TEST,TEST,TEST'
      && uno(`select count(*) from licenses where id in (${ids}) and status = 'activa'`) === '7'
      && uno(`select count(*) from license_events where license_id in (${ids}) and type = 'LICENSE_CLASSIFIED'`) === '7',
      'clasificación: 2 QA, 1 INTERNAL, 4 TEST; ninguna borrada ni suspendida; un solo evento por licencia');
    check('CL2', uno(`select string_agg(right(l.license_key, 4), ',' order by l.license_key) from license_review_queue q join licenses l on l.id = q.license_id
                     where 'CANDIDATA_A_CANCELAR' = any(q.reasons) and l.id in (${ids})`) === '6AJY,E8FH,SMBM,V332',
      'las 4 de prueba sin uso quedan como candidatas a cancelar (sin borrarlas)');
    check('CL2', uno(`select count(*) from license_commercial_licenses where id in (${ids})`) === '0',
      'ninguna de las 7 cuenta como cliente comercial');
    // Reemitir: el certificado V2 que recibirá cada VM al refrescar.
    const par = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const clave = await importarClavePrivada(par.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const pub = par.publicKey.export({ type: 'spki', format: 'pem' });
    const certDe = async (maquina) => {
      const r = JSON.parse(uno(`select license_for_machine('${maquina}')`));
      if (!r.ok) return { r, p: null };
      const c = await firmar(payloadDeLicencia(r.runtime, maquina), clave, 'wybix-lic-1');
      return { r, p: await verificar(c, pub) };
    };
    const vm = await certDe('46f980-vm');
    check('CL3', !!vm.p && vm.p.origin === 'QA' && JSON.stringify(vm.p.verticals) === '["COMMERCE","HOSPITALITY","SERVICES"]'
      && Object.values(vm.p.screens).every(x => x === null) && vm.p.entitlements.includes('hospitality.kds') && vm.p.entitlements.includes('services.agenda')
      && vm.p.paid_until?.startsWith('2027-09-19'),
      'VM en uso: certificado V2 FIRMADO, origen QA, tres giros y pantallas ilimitadas (explícitos), primer año desde su activación', JSON.stringify(vm.p?.screens));
    const qa = await certDe('9d18ec-qa');
    check('CL3', !!qa.p && qa.p.origin === 'QA' && qa.p.edition === 'multi' && qa.p.registers_max === null
      && ['COMMERCE', 'HOSPITALITY', 'SERVICES'].every(g => qa.p.screens[g] === 3) && Object.keys(qa.p.screens).length === 3,
      'QA MultiCaja: certificado V2 firmado, MultiCaja, tres giros con su cuota normal', JSON.stringify({ e: qa.p?.edition, r: qa.p?.registers_max, s: qa.p?.screens, ok: qa.r?.ok, code: qa.r?.code }));
    const viejo = await certDe('fc3f3c-vm');
    check('CL4', !!viejo.p && viejo.p.origin === 'TEST' && viejo.p.verticals.length === 0,
      'una candidata a cancelar que aún refresque recibe V2 firmado SIN giros (solo la edición)');
    check('CL4', uno(`select count(*) from license_verticals where license_id = 'b4a22322-cd10-4e4b-ac3b-2535bad7a06b'`) === '0',
      'la INTERNAL (compra del dueño, nunca activada) queda sin giros hasta decidir');
  }

  // ================================================================ PARTE B
  log('\n   · PARTE B (estado final)');
  const sqlB = readFileSync(MIG_B, 'utf8');
  const b1 = psql(sqlB);
  check('M04', b1.code === 0, 'la PARTE B se aplica sobre la transición (con licencias de las dos webs)', b1.code === 0 ? '' : b1.err.trim().slice(0, 300));
  const b2 = psql(sqlB);
  check('M05', b2.code === 0, 'y se puede aplicar otra vez (idempotente)', b2.code === 0 ? '' : b2.err.trim().slice(0, 300));
  correrSql(join(RAIZ, 'supabase/tests/licenciamiento-final.test.sql'));

  log('\n   · ROLLOUT contra el estado FINAL');
  if (!webNueva) omitir('W08', 'web nueva no disponible');
  else {
    PAGOS.set('FIN-1', 4638.84);
    const n = await pedir(webNueva, { orderId: 'FIN-1', edition: 'EDITION_MULTI', vertical: 'SERVICES', items: [] });
    const l = n.body?.licenseKey ? lic(n.body.licenseKey) : null;
    check('W08', n.status === 200 && !!l && l.plan === 'multi' && l.max_registers === null,
      'web NUEVA contra el estado final: MultiCaja con max_registers NULL', `${n.status}`);
    if (l) check('W08', uno(`select count(*) from license_events where license_id = '${l.id}' and type = 'CHECKOUT_WITHOUT_CONSENT'`) === '1',
      'un pedido sin registro de aceptación se emite (el pago ya se capturó) pero queda marcado CHECKOUT_WITHOUT_CONSENT');
  }
  if (!webAnterior) omitir('W09', 'web anterior no disponible');
  else {
    PAGOS.set('ANT-2', 4638.84);
    const a = await pedir(webAnterior, { orderId: 'ANT-2', plan: 'multi', cajas: 3, items: [] });
    check('W09', a.status !== 200 && uno(`select count(*) from licenses where paypal_order_id = 'ANT-2'`) === '0',
      'web ANTERIOR contra el estado final: ya no emite (por eso B se aplica DESPUÉS de reemplazarla)', `${a.status}`);
  }
  rest.cerrar();
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  fallos++;
  log(`ERROR ${e.stack || e.message}`);
} finally {
  docker(['rm', '-f', NOMBRE]);
}
log(`\nRESULTADO: PASS ${pasos - fallos} · FAIL ${fallos} · SKIPPED ${omitidas}`);
process.exit(fallos ? 1 : 0);
