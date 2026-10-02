/**
 * PRUEBAS DE LA FASE 1 EN LA NUBE, SIN TOCAR PRODUCCIÓN.
 *
 *     node scripts/probar-fase1.mjs
 *
 * Levanta un Postgres 17 desechable en Docker (la versión de producción) y:
 *
 *   1. aplica TODA la cadena de migraciones sobre una base vacía (con auth
 *      emulado): el esquema de la nube ya es reproducible;
 *   2. carga datos con la forma de producción (un negocio por equipo, tokens
 *      por sucursal, un dueño, licencias) y aplica la Fase 1 DOS veces;
 *   3. corre supabase/tests/fase1.test.sql (migración, enrolamiento,
 *      multiempresa/RLS, hechos, CFDI, I Do Nut, privilegios);
 *   4. prueba las Edge Functions REALES (_shared/fiscal.ts y pos-sync.ts) por
 *      HTTP contra esa base, con Fiscalapi simulado: los casos negativos
 *      fiscales NO llegan a Fiscalapi;
 *   5. reversa (supabase/rollback/...down.sql), comprueba que vuelve lo de
 *      antes, y aplica la Fase 1 otra vez.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { archivos, cancelar, registrarEmisor, reclamarHistorico, timbrar } from '../supabase/functions/_shared/fiscal.ts';
import { manejarPosSync } from '../supabase/functions/_shared/pos-sync.ts';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SB = join(RAIZ, 'supabase');
const NOMBRE = 'wybix-fase1-prueba';
const CADENA = [
  'tests/auth-emulado.sql',
  'migrations/20260901000000_base_nube_legado.sql',
  'migrations/20260926120000_licenciamiento_v2.sql',
  'migrations/20260926130000_pos_sync_sin_service_role.sql',
  'migrations/20260927120000_licenciamiento_v2_final.sql',
];
const FASE1 = 'migrations/20261002120000_fase1_multiempresa.sql';
const REVERSA = 'rollback/20261002120000_fase1_multiempresa.down.sql';
let fallos = 0, pasos = 0;
const log = (s) => console.log(s);
const check = (id, ok, msg, det = '') => {
  pasos++; if (!ok) fallos++;
  log(`   ${ok ? 'ok   ' : 'FALLA'}  ${id}. ${msg}${det ? '  · ' + det : ''}`);
};

function docker(args, entrada) {
  const r = spawnSync('docker', args, { input: entrada, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const psql = (sql) => docker(['exec', '-i', NOMBRE, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A'], sql);
const uno = (sql) => psql(sql).out.trim();
const archivo = (rel) => readFileSync(join(SB, rel), 'utf8');
function aplicar(rel) {
  const r = psql(archivo(rel));
  return { ok: r.code === 0, err: r.err.replace(/^NOTICE.*$/gm, '').trim().slice(0, 400) };
}

/** RPC como la hace la Edge Function: rol service_role, una función jsonb -> jsonb. */
const rpc = async (fn, p) => {
  if (!/^[a-z_]+$/.test(fn)) throw new Error('rpc inválida');
  const etiqueta = '$j' + randomUUID().replace(/-/g, '') + '$';
  const r = psql(`set role service_role; select public.${fn}(${etiqueta}${JSON.stringify(p)}${etiqueta}::jsonb)::text;`);
  if (r.code !== 0) throw new Error(`${fn}: ${r.err.trim().slice(0, 300)}`);
  return JSON.parse(r.out.trim() || 'null');
};

// ------------------------------------------------------- Fiscalapi simulado
const LLAMADAS = [];
let nInv = 0;
const fapi = async (path, init) => {
  LLAMADAS.push({ path, method: init.method, body: init.body });
  const ok = (data) => ({ ok: true, status: 200, out: { succeeded: true, data } });
  if (init.method === 'POST' && path === '/api/v4/people') return ok({ id: 'fapi-person-' + randomUUID().slice(0, 8) });
  if (init.method === 'POST' && path === '/api/v4/tax-files') return ok({ id: 'tf' });
  if (init.method === 'POST' && path === '/api/v4/invoices') { nInv++; return ok({ id: `fapi-inv-http-${nInv}`, uuid: `UUID-${nInv}`, series: init.body.series, folio: String(nInv), total: 116 }); }
  if (init.method === 'DELETE' && path === '/api/v4/invoices') return ok({ base64CancellationAcknowledgement: 'QUNVU0U=', invoiceUuids: {} });
  if (init.method === 'GET' && /\/pdf$/.test(path)) return ok({ base64File: 'P'.repeat(200) });
  if (init.method === 'GET' && /\/xml$/.test(path)) return ok({ base64File: 'X'.repeat(200) });
  const persona = path.match(/^\/api\/v4\/people\/(.+)$/);
  if (init.method === 'GET' && persona) {
    return decodeURIComponent(persona[1]).startsWith('fapi-hist-') ? ok({ id: persona[1], tin: 'HIS010101AAA', legalName: 'HISTORICO' }) : { ok: false, status: 404, out: {} };
  }
  return { ok: false, status: 404, out: {} };
};
const peticion = (cuerpo, token) => new Request('https://nube.prueba/fn', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-wybix-device': token } : {}) }, body: JSON.stringify(cuerpo),
});
async function llamar(fn, cuerpo, token, extra = {}) {
  const r = await fn(peticion(cuerpo, token), { rpc, fapi, permitirLegado: false, ...extra });
  return { status: r.status, body: await r.json() };
}
const ESPEJO = [];
const depsSync = {
  rpc,
  espejo: { async escribir(t, rows) { ESPEJO.push({ t, rows }); return null; }, async existeAlerta() { return false; } },
  async borrarUsuario() {},
};
async function sync(cuerpo, token) {
  const r = await manejarPosSync(peticion(cuerpo, token), depsSync);
  return { status: r.status, body: await r.json() };
}
const factura = (extra = {}) => ({
  series: 'F', formaPago: '01', metodoPago: 'PUE', expeditionZipCode: '64000',
  receptor: { rfc: 'XAXX010101000', razonSocial: 'PUBLICO EN GENERAL', regimenFiscal: '616', usoCfdi: 'S01', zipCode: '64000' },
  items: [{ description: 'Dona glaseada', quantity: 1, unitPrice: 100 }], ...extra,
});

try {
  docker(['rm', '-f', NOMBRE]);
  const r = docker(['run', '-d', '--name', NOMBRE, '-e', 'POSTGRES_PASSWORD=prueba', 'postgres:17-alpine']);
  if (r.code !== 0) throw new Error(`docker run: ${r.err}`);
  for (let i = 0; i < 60; i++) {
    if (docker(['exec', NOMBRE, 'pg_isready', '-U', 'postgres']).code === 0 && psql('select 1').code === 0) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  log('\nFASE 1 · NUBE · Postgres 17 desechable\n');

  // ============================================================ 1-2 migraciones
  log('   · esquema reproducible y migración de la Fase 1');
  for (const m of CADENA) {
    const a = aplicar(m);
    check('M01', a.ok, `se aplica sobre base vacía: ${m}`, a.err);
  }
  const datos = aplicar('tests/fase1-datos-legado.sql');
  check('M02', datos.ok, 'datos con la forma de producción cargados', datos.err);
  const antes = uno(`select (select count(*) from negocios)||'/'||(select count(*) from sucursales)||'/'||(select count(*) from resumen_ventas)||'/'||(select count(*) from licenses)`);
  const f1 = aplicar(FASE1);
  check('M03', f1.ok, 'la Fase 1 se aplica', f1.err);
  const f2 = aplicar(FASE1);
  check('M04', f2.ok, 'y se puede aplicar otra vez (idempotente)', f2.err);
  const despues = uno(`select (select count(*) from negocios)||'/'||(select count(*) from sucursales)||'/'||(select count(*) from resumen_ventas)||'/'||(select count(*) from licenses)`);
  check('M05', antes === despues, 'no se pierde ni duplica nada (negocios/sucursales/resúmenes/licencias)', `${antes} -> ${despues}`);
  check('M06', uno(`select count(*) from devices`) === '3' && uno(`select count(*) from company_memberships`) === '1',
    'aplicarla dos veces no duplica equipos ni membresías');
  const conc = uno(`select string_agg(kind||'='||total, ', ' order by kind) from fase1_conciliacion`);
  log(`          pendientes de conciliar tras migrar: ${conc}`);

  // ============================================================ 3 pruebas SQL
  log('\n   · pruebas SQL (supabase/tests/fase1.test.sql)');
  const t = psql(archivo('tests/fase1.test.sql'));
  if (t.code !== 0) { fallos++; log(`FALLA al correr las pruebas SQL: ${t.err.trim().slice(0, 400)}`); }
  for (const linea of t.out.split(/\r?\n/).filter((l) => /^(ok|FALLA)\|/.test(l))) {
    const [estado, id, ...msg] = linea.split('|');
    check(id, estado === 'ok', msg.join('|'));
  }

  // Evidencia I Do Nut: lo que ve la dueña en la app.
  const idn = JSON.parse(uno(`select v::text from t_ctx where k = 'idn'`));
  log('\n   · I Do Nut (lo que ve la dueña):');
  for (const u of idn.ubicaciones) {
    const corte = u.ultimo_corte ? `último corte ${u.ultimo_corte.caja}: dif ${u.ultimo_corte.diferencia} (${u.ultimo_corte.cerrado_por ?? '-'})` : 'sin corte';
    log(`          ${u.tipo.padEnd(6)} ${u.nombre.padEnd(16)} ventas ${String(u.ventas.neto).padStart(8)} · ${u.ventas.tickets} tickets · ${u.turnos_abiertos.length} turno(s) abierto(s) · ${corte}`);
  }
  log(`          TOTAL EMPRESA          ${String(idn.total.neto).padStart(8)} · ${idn.total.tickets} tickets`);
  mkdirSync(join(RAIZ, 'docs', 'evidencia'), { recursive: true });
  writeFileSync(join(RAIZ, 'docs', 'evidencia', 'fase1-idonut-resumen.json'), JSON.stringify(idn, null, 2) + '\n');

  // ============================================================ 4 Edge Functions
  log('\n   · Edge Functions reales por HTTP (Fiscalapi simulado)');
  const A = await sync({ action: 'bootstrap', instance_uuid: randomUUID(), device_uuid: randomUUID(), nombre_negocio: 'Empresa A' });
  const B = await sync({ action: 'bootstrap', instance_uuid: randomUUID(), device_uuid: randomUUID(), nombre_negocio: 'Empresa B' });
  check('H01', A.status === 200 && B.status === 200 && A.body.token && A.body.company_id !== B.body.company_id, 'pos-sync bootstrap: dos instalaciones, dos empresas');
  const tA = A.body.token, tB = B.body.token;
  const regA = await llamar(registrarEmisor, { rfc: 'AAA010101AAA', razonSocial: 'EMPRESA A', regimenFiscal: '601', zipCode: '64000', cerBase64: 'c', keyBase64: 'k', password: 'x' }, tA);
  const regB = await llamar(registrarEmisor, { rfc: 'BBB010101BBB', razonSocial: 'EMPRESA B', regimenFiscal: '601', zipCode: '01000', cerBase64: 'c', keyBase64: 'k', password: 'x' }, tB);
  check('H02', regA.status === 200 && regB.status === 200, 'cada empresa registra su emisor (CSD)');
  // B intenta reutilizar la persona de A con existingPersonId.
  const n0 = LLAMADAS.length;
  const regB2 = await llamar(registrarEmisor, { rfc: 'AAA010101AAA', razonSocial: 'SUPLANTA', regimenFiscal: '601', cerBase64: 'c', keyBase64: 'k', password: 'x', existingPersonId: regA.body.issuerId }, tB);
  const subidas = LLAMADAS.slice(n0).filter((c) => c.path === '/api/v4/tax-files');
  check('H03', regB2.status === 200 && regB2.body.issuerId !== regA.body.issuerId && subidas.every((c) => c.body.personId !== regA.body.issuerId),
    'existingPersonId de otra empresa se IGNORA: B nunca sube su CSD a la persona de A');

  const n1 = LLAMADAS.length;
  const cruz = await llamar(timbrar, factura({ issuerId: regA.body.issuerId }), tB);
  check('H04', cruz.status === 403 && LLAMADAS.length === n1, 'timbrar con el emisor de otra empresa: 403 y Fiscalapi ni se entera');
  const okA = await llamar(timbrar, factura({ issuerId: undefined, issuerRfc: 'BBB010101BBB', issuerLegalName: 'EMPRESA B', issuerRegimen: '612' }), tA);
  const enviada = LLAMADAS.filter((c) => c.path === '/api/v4/invoices' && c.method === 'POST').at(-1);
  check('H05', okA.status === 200 && enviada?.body.issuer.id === regA.body.issuerId && enviada?.body.issuer.taxRegimeCode === '601',
    'timbrar: emisor y régimen salen de la nube (se ignoran issuerRfc/LegalName/Regimen del cuerpo)');
  check('H06', uno(`select company_id::text from fiscal_invoices where fiscalapi_invoice_id = '${okA.body.invoiceId}'`) === A.body.company_id,
    'la factura timbrada queda registrada con SU empresa');
  const n2 = LLAMADAS.length;
  const xmlB = await llamar(archivos, { invoiceId: okA.body.invoiceId }, tB);
  const canB = await llamar(cancelar, { invoiceId: okA.body.invoiceId, motivo: '02' }, tB);
  check('H07', xmlB.status === 403 && canB.status === 403 && LLAMADAS.length === n2, 'XML/PDF y cancelación de factura ajena: 403 sin tocar Fiscalapi');
  const xmlA = await llamar(archivos, { invoiceId: okA.body.invoiceId }, tA);
  const canA = await llamar(cancelar, { invoiceId: okA.body.invoiceId, motivo: '02' }, tA);
  check('H08', xmlA.status === 200 && xmlA.body.xmlBase64 && canA.status === 200
    && uno(`select status from fiscal_invoices where fiscalapi_invoice_id = '${okA.body.invoiceId}'`) === 'CANCELLED',
    'la empresa dueña sí descarga y cancela (CFDI legítimo intacto)');
  const sinToken = await llamar(timbrar, factura({ issuerId: regA.body.issuerId, issuerRegimen: '601' }), null);
  check('H09', sinToken.status === 401, 'sin credencial de equipo: 401 (la llave anónima ya no basta)');
  const n3 = LLAMADAS.length;
  const legAjeno = await llamar(timbrar, factura({ issuerId: regA.body.issuerId, issuerRegimen: '601' }), null, { permitirLegado: true });
  const legLibre = await llamar(timbrar, factura({ issuerId: 'fapi-persona-sin-duenio', issuerRegimen: '601' }), null, { permitirLegado: true });
  check('H10', legAjeno.status === 401 && legLibre.status === 200 && LLAMADAS.slice(n3).filter((c) => c.path === '/api/v4/invoices').length === 1,
    'transición (FISCAL_PERMITIR_LEGADO=1): un POS anterior solo usa emisores SIN empresa; los registrados quedan protegidos');
  const legFactura = await llamar(archivos, { invoiceId: okA.body.invoiceId }, null, { permitirLegado: true });
  check('H11', legFactura.status === 401, 'transición: tampoco descarga facturas que ya tienen empresa');
  const hist = await llamar(reclamarHistorico, { issuerId: 'fapi-hist-1', invoices: [{ invoiceId: 'fapi-inv-old-1' }, { invoiceId: 'fapi-inv-old-2' }] }, tA);
  const histFalso = await llamar(reclamarHistorico, { issuerId: 'no-existe', invoices: [] }, tA);
  check('H12', hist.status === 200 && hist.body.issuerStatus === 'PENDING_RECONCILIATION' && hist.body.invoices.pending_reconciliation === 2 && histFalso.status === 404,
    'histórico: se reclama, el RFC sale de Fiscalapi y queda pendiente de conciliar (una persona inexistente no se reclama)');

  // pos-sync
  const inst = randomUUID();
  const P1 = await sync({ action: 'bootstrap', instance_uuid: inst, device_uuid: randomUUID(), nombre_negocio: 'Una base' });
  const P2 = await sync({ action: 'bootstrap', instance_uuid: inst, device_uuid: randomUUID(), nombre_negocio: 'Otra vez' });
  const P3 = await sync({ action: 'enroll', install_secret: P1.body.install_secret, instance_uuid: inst, device_uuid: randomUUID(), kind: 'POS_SECONDARY' });
  check('H13', P2.status === 409 && P2.body.code === 'INSTANCE_KNOWN' && P3.status === 200 && P3.body.company_id === P1.body.company_id,
    'pos-sync: la segunda PC de la misma base no crea empresa; se une con la llave de instalación');
  const ev = { event_uuid: randomUUID(), event_type: 'SALE_RECORDED', aggregate_type: 'SALE', aggregate_uuid: randomUUID(), aggregate_version: 7,
    occurred_at: new Date().toISOString(), payload_version: 1, payload: { folio: 1, business_date: '2026-10-02', total: 10 } };
  const e1 = await sync({ action: 'events', envelope: { company_uuid: P1.body.company_id }, events: [ev] }, P1.body.token);
  const e2 = await sync({ action: 'events', events: [ev] }, P1.body.token);
  check('H14', e1.body.results?.[0]?.result === 'APPLIED' && e2.body.results?.[0]?.result === 'DUPLICATE'
    && uno(`select count(*) from sales_facts where sale_uuid = '${ev.aggregate_uuid}'`) === '1',
    'pos-sync events: el mismo event_uuid dos veces = un efecto');
  const up = await sync({ action: 'upsert', table: 'resumen_ventas', rows: [{ fecha: '2026-10-02', total: 1, sucursal_id: A.body.location_id }] }, P1.body.token);
  check('H15', up.status === 200 && ESPEJO.at(-1).rows[0].sucursal_id === P1.body.location_id, 'espejo: la ubicación la pone el servidor (se ignora la del cuerpo)');
  const up2 = await sync({ action: 'upsert', table: 'resumen_ventas', rows: [{ fecha: '2026-10-02' }] }, P3.body.token);
  check('H16', up2.status === 403, 'una caja secundaria no sincroniza');
  const leg = await sync({ action: 'provision', deviceKey: 'POS-ANTERIOR-' + randomUUID().slice(0, 8), nombre: 'POS viejo' });
  const legUp = await sync({ action: 'upsert', table: 'alertas', rows: [{ tipo: 't', titulo: 't', mensaje: 'm' }] }, leg.body.token);
  check('H17', leg.status === 200 && legUp.status === 200, 'POS anterior: provision + upsert siguen funcionando igual');
  const loc2 = await sync({ action: 'create_location', nombre: 'Segunda', tipo: 'BRANCH' }, P1.body.token);
  const del = await sync({ action: 'delete_account' }, P1.body.token);
  check('H18', loc2.status === 200 && del.status === 409, 'delete_account: con varias ubicaciones, una sucursal no borra la empresa');
  const who = await sync({ action: 'whoami' }, P3.body.token);
  check('H19', who.status === 200 && who.body.company.id === P1.body.company_id && who.body.device.kind === 'POS_SECONDARY', 'whoami: el equipo conoce su empresa, ubicación y tipo');
  const nadie = await sync({ action: 'whoami' }, 'wxd_credencial_inventada_000000000000');
  check('H20', nadie.status === 401, 'credencial inventada: 401');

  // ============================================================ 5 reversa
  log('\n   · reversa y reaplicación');
  const rb = aplicar(REVERSA);
  check('R01', rb.ok, 'la reversa se aplica', rb.err);
  check('R02', uno(`select count(*) from pg_policies where schemaname = 'public' and tablename in ('negocios','sucursales','resumen_ventas','tendencia_ventas','seguridad_riesgo')`) === '5'
    && uno(`select count(*) from pg_proc where proname in ('fiscal_autorizar','sync_ingest','pos_bootstrap')`) === '0'
    && uno(`select to_regclass('public.devices') is null`) === 't',
    'vuelven las políticas anteriores y se retiran funciones y tablas nuevas');
  check('R03', uno(`select count(*) from respaldo.fase1_rb_fiscal_issuers`) !== '0' && uno(`select count(*) from respaldo.fase1_rb_company_memberships`) !== '0',
    'lo creado en la Fase 1 (emisores con su empresa, membresías...) quedó respaldado');
  check('R04', uno(`set request.jwt.claims = '{"sub":"10000000-0000-0000-0000-00000000000a"}'; set role authenticated; select count(*) from sucursales;`) === '1',
    'el dueño anterior sigue viendo su sucursal con las políticas restauradas');
  const rb2 = aplicar(REVERSA);
  check('R05', rb2.ok, 'la reversa es idempotente', rb2.err);
  const re = aplicar(FASE1);
  check('R06', re.ok && uno(`select count(*) from respaldo.fase1_politicas`) === '5', 'la Fase 1 se vuelve a aplicar y conserva el respaldo ORIGINAL de políticas', re.err);
} catch (e) {
  fallos++;
  log(`\nERROR: ${e?.stack || e}`);
} finally {
  docker(['rm', '-f', NOMBRE]);
}
log(`\n${pasos - fallos}/${pasos} comprobaciones correctas${fallos ? ` · ${fallos} FALLAS` : ''}\n`);
process.exit(fallos ? 1 : 0);
