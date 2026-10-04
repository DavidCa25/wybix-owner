/**
 * FASE 2 · PRUEBAS DE LA NUBE Y E2E DE I DO NUT (sin tocar producción).
 *
 *     node scripts/probar-fase2.mjs [--pos <ruta del repo del POS>]
 *
 * PARTE A  Postgres 17 desechable: cadena de migraciones, datos con forma de
 *          producción, Fase 1 + sus pruebas (91), Fase 2 dos veces encima y
 *          supabase/tests/fase2.test.sql.
 * PARTE B  E2E de I Do Nut con piezas REALES:
 *            Centro  = SQL Server temporal (baseline + migraciones, 0052) con
 *                      sus procedimientos de transferencia y publicación;
 *            Nube    = Postgres con las migraciones y la Edge Function
 *                      pos-sync (_shared/pos-sync.ts) llamada por HTTP;
 *            Tablet  = @wybix/database + @wybix/sync + @wybix/api sobre un
 *                      archivo SQLite que se cierra y se reabre (reinicio).
 *          La red de la tablet se corta y se restablece a voluntad.
 * PARTE C  Reversa de la Fase 2 y reaplicación.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, generateKeyPairSync, sign, createPublicKey, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { manejarPosSync } from '../supabase/functions/_shared/pos-sync.ts';
import { adaptadorNode, migrar, crearPos, guardarEnrolamiento, identificar, resumen, pendientes } from '@wybix/database';
import { crearSincronizador, verificarQr, aTransferencia } from '@wybix/sync';
import { importarTransferencia } from '@wybix/database';
import { crearClienteNube } from '@wybix/api';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SB = join(RAIZ, 'supabase');
const iP = process.argv.indexOf('--pos');
const POS = resolve(iP > 0 ? process.argv[iP + 1] : (process.env.WYBIX_POS || 'C:/Users/Casillas/filtros_lubs_rios'));
const { restaurar, eliminar } = await import(pathToFileURL(join(POS, 'scripts/db/lib/temporal.mjs')).href);
const { consultarTemporal } = await import(pathToFileURL(join(POS, 'scripts/db/lib/temporal-consulta.mjs')).href);
const { limpiar } = await import(pathToFileURL(join(POS, 'scripts/db/pruebas/lib.mjs')).href);
const credenciales = createRequire(import.meta.url)(join(POS, 'electron/local-host/credenciales.js'));

const NOMBRE = 'wybix-fase2-prueba';
const CENTRO = 'Wybix_TmpFase2Centro';
const CADENA = ['tests/auth-emulado.sql', 'migrations/20260901000000_base_nube_legado.sql', 'migrations/20260926120000_licenciamiento_v2.sql',
  'migrations/20260926130000_pos_sync_sin_service_role.sql', 'migrations/20260927120000_licenciamiento_v2_final.sql'];
const F1 = 'migrations/20261002120000_fase1_multiempresa.sql';
const F2 = 'migrations/20261010120000_fase2_event_mobile.sql';
const F2_DOWN = 'rollback/20261010120000_fase2_event_mobile.down.sql';
let fallos = 0, pasos = 0;
const log = (s) => console.log(s);
const check = (id, ok, msg, det = '') => { pasos++; if (!ok) fallos++; log(`   ${ok ? 'ok   ' : 'FALLA'}  ${id}. ${msg}${det ? '  · ' + det : ''}`); };
const evidencia = {};

// ---------------------------------------------------------------- Postgres
const docker = (args, entrada) => { const r = spawnSync('docker', args, { input: entrada, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const psql = (sql, db = 'postgres') => docker(['exec', '-i', NOMBRE, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A'], sql);
const uno = (sql, db = 'postgres') => psql(sql, db).out.trim();
const aplicar = (rel, db = 'postgres') => { const r = psql(readFileSync(join(SB, rel), 'utf8'), db); return { ok: r.code === 0, err: r.err.replace(/^NOTICE.*$/gm, '').trim().slice(0, 400) }; };
const etq = () => '$j' + randomUUID().replace(/-/g, '') + '$';
const lit = (o) => { const e = etq(); return `${e}${JSON.stringify(o)}${e}`; };
const rpcEn = (db) => async (fn, p) => {
  if (!/^[a-z_]+$/.test(fn)) throw new Error('rpc inválida');
  const r = psql(`set role service_role; select public.${fn}(${lit(p)}::jsonb)::text;`, db);
  if (r.code !== 0) throw new Error(`${fn}: ${r.err.trim().slice(0, 300)}`);
  return JSON.parse(r.out.trim() || 'null');
};
const comoUsuario = (db, user, sql) => {
  const r = psql(`set request.jwt.claims = '{"sub":"${user}"}'; set role authenticated; ${sql}`, db);
  if (r.code !== 0) throw new Error(`como usuario: ${r.err.trim().slice(0, 300)}`);
  return r.out.trim();
};

// ---------------------------------------------------------------- SQL Server (Centro)
const q = (sql) => { const r = consultarTemporal(CENTRO, sql); if (!r.ok) throw new Error(limpiar(r.error)); return r.sets.length ? r.sets[0] : []; };
const esc = (sql) => { const f = q(sql)[0]; return f ? f[Object.keys(f)[0]] : null; };

try {
  docker(['rm', '-f', NOMBRE]);
  const r0 = docker(['run', '-d', '--name', NOMBRE, '-e', 'POSTGRES_PASSWORD=prueba', 'postgres:17-alpine']);
  if (r0.code !== 0) throw new Error(`docker run: ${r0.err}`);
  for (let i = 0; i < 60; i++) { if (docker(['exec', NOMBRE, 'pg_isready', '-U', 'postgres']).code === 0 && psql('select 1').code === 0) break; await new Promise((r) => setTimeout(r, 1000)); }

  // ================================================================== PARTE A
  if (!process.argv.includes('--solo-e2e')) {
  log('\nFASE 2 · PARTE A · nube (SQL)\n');
  for (const m of [...CADENA, 'tests/fase1-datos-legado.sql', F1]) { const a = aplicar(m); if (!a.ok) check('A00', false, m, a.err); }
  const t1 = psql(readFileSync(join(SB, 'tests/fase1.test.sql'), 'utf8'));
  check('A01', t1.code === 0 && uno(`select count(*) filter (where ok)||'/'||count(*) from t_res`) === '91/91', 'Fase 1 sigue 91/91 antes de migrar', uno(`select count(*) filter (where ok)||'/'||count(*) from t_res`));
  const m1 = aplicar(F2), m2 = aplicar(F2);
  check('A02', m1.ok && m2.ok, 'la Fase 2 se aplica dos veces sobre datos reales de la Fase 1', m1.err || m2.err);
  const t2 = psql(readFileSync(join(SB, 'tests/fase2.test.sql'), 'utf8'));
  if (t2.code !== 0) check('A03', false, 'pruebas SQL de la Fase 2', t2.err.slice(0, 300));
  for (const l of t2.out.split(/\r?\n/).filter((x) => /^(ok|FALLA)\|/.test(x))) { const [e, id, ...m] = l.split('|'); check(id, e === 'ok', m.join('|')); }
  }

  // ================================================================== PARTE B
  log('\nFASE 2 · PARTE B · E2E I Do Nut (Centro SQL Server + nube + tablet)\n');
  psql('create database e2e;');
  for (const m of [...CADENA, F1, F2]) { const a = aplicar(m, 'e2e'); if (!a.ok) check('B00', false, m, a.err); }
  const rpc = rpcEn('e2e');
  const depsSync = { rpc, espejo: { async escribir() { return null; }, async existeAlerta() { return false; } }, async borrarUsuario() {} };
  const http = async (cuerpo, token) => {
    const r = await manejarPosSync(new Request('https://nube.prueba/functions/v1/pos-sync', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-wybix-device': token } : {}) }, body: JSON.stringify(cuerpo) }), depsSync);
    return { status: r.status, body: await r.json() };
  };

  // --- Centro: SQL Server temporal con baseline + migraciones (0051, 0052)
  restaurar(CENTRO, join(POS, 'installer', 'template.bak'));
  const ya = new Set(q('SELECT filename FROM dbo.schema_migrations;').map((r) => r.filename));
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(join(POS, 'electron/migrations')).filter((n) => n.endsWith('.sql')).sort((a, b) => a.localeCompare(b, 'en')).filter((f) => !ya.has(f))) {
    for (const lote of readFileSync(join(POS, 'electron/migrations', f), 'utf8').replace(/\r\n/g, '\n').split(/\n\s*GO\s*\n/gi)) if (lote.trim()) q(lote);
    q(`INSERT INTO dbo.schema_migrations (filename) VALUES (N'${f}');`);
  }
  q(`INSERT INTO dbo.users (usuario, password_hash, rol, active, creation_date) VALUES
       (N'duena', CONVERT(NVARCHAR(255), HASHBYTES('SHA2_256', N'x'), 2), N'admin', 1, GETDATE()),
       (N'lupita', CONVERT(NVARCHAR(255), HASHBYTES('SHA2_256', N'x'), 2), N'cajero', 1, GETDATE()),
       (N'marta', CONVERT(NVARCHAR(255), HASHBYTES('SHA2_256', N'x'), 2), N'supervisor', 1, GETDATE());
     INSERT INTO dbo.CAT_brands (namee) VALUES (N'I Do Nut'); INSERT INTO dbo.CAT_categories (namee) VALUES (N'Donas');`);
  const uid = (u) => Number(esc(`SELECT id FROM dbo.users WHERE usuario = N'${u}'`));
  const PIN = { lupita: '4821', marta: '7305' };
  for (const [u, pin] of Object.entries(PIN)) {
    const { hash, sal } = credenciales.hashPin(pin);
    q(`INSERT INTO dbo.trabajadores_acceso (user_id, pin_hash, pin_sal, pin_creado_en) VALUES (${uid(u)}, '${hash}', '${sal}', SYSUTCDATETIME());`);
  }
  const prod = (pn, nombre, precio, stock, sellable = 1) => {
    const id = Number(esc(`EXEC dbo.sp_add_product @brand=${esc('SELECT TOP 1 id FROM dbo.CAT_brands')}, @part_number=N'${pn}', @name=N'${nombre}', @price=${precio}, @stock=${stock}, @category=${esc('SELECT TOP 1 id FROM dbo.CAT_categories')}, @cost=6.5;`));
    q(`UPDATE dbo.products SET sellable = ${sellable} WHERE id = ${id};`);
    return { id, uuid: String(esc(`SELECT LOWER(CONVERT(VARCHAR(36), uuid)) FROM dbo.products WHERE id = ${id}`)) };
  };
  const A = prod('IDN-A', 'Dona glaseada', 25, 100);
  const B = prod('IDN-B', 'Vaso para café', 0, 50, 0);
  const C = prod('IDN-C', 'Café de olla', 25, 50);
  const stockCentro = (p) => Number(esc(`SELECT stock FROM dbo.products WHERE id = ${p.id}`));
  check('B01', stockCentro(A) === 100 && stockCentro(B) === 50, 'Centro (SQL Server) inicia con Producto A = 100 y Vasos = 50');

  // --- Centro se registra en la nube (como nube/identidad.js) y publica.
  q(`IF NOT EXISTS (SELECT 1 FROM dbo.database_metadata WHERE clave = 'instance_uuid') INSERT INTO dbo.database_metadata (clave, valor) VALUES ('instance_uuid', LOWER(CONVERT(NVARCHAR(36), NEWID())));`);
  const inst = String(esc(`SELECT valor FROM dbo.database_metadata WHERE clave = 'instance_uuid'`));
  const huella = String(esc(`SELECT LOWER(CONVERT(VARCHAR(64), HASHBYTES('SHA2_256', CONCAT(CONVERT(NVARCHAR(128), SERVERPROPERTY('MachineName')), N'|', ISNULL(CONVERT(NVARCHAR(128), SERVERPROPERTY('InstanceName')), N'MSSQLSERVER'), N'|', DB_NAME())), 2))`));
  const bootC = await http({ action: 'bootstrap', instance_uuid: inst, device_uuid: randomUUID(), nombre_negocio: 'I Do Nut', nombre_sucursal: 'Centro', name: 'CAJA-CENTRO' });
  const tC = bootC.body.token;
  q(`INSERT INTO dbo.database_metadata (clave, valor) VALUES ('company_uuid', '${bootC.body.company_id}'), ('location_uuid', '${bootC.body.location_id}'), ('server_fingerprint', '${huella}');`);
  const company = bootC.body.company_id, centro = bootC.body.location_id;
  // Licencias de I Do Nut: dos sucursales + complemento de eventos/tablet.
  psql(`insert into licenses (id, license_key, plan, customer_name, max_registers, company_id, addons) values
          ('e2e00000-0000-4000-8000-0000000000c1', 'WYBX-E2E-CENT', 'multi', 'I Do Nut', null, '${company}', '{MOBILE_POS}'),
          ('e2e00000-0000-4000-8000-0000000000c2', 'WYBX-E2E-NORT', 'mono', 'I Do Nut', 1, '${company}', '{}');`, 'e2e');
  // La dueña: cuenta y membresía por invitación del POS.
  psql(`insert into auth.users (id, email) values ('a0e20000-0000-4000-8000-00000000000a', 'duena@idonut.mx');`, 'e2e');
  const DUENA = 'a0e20000-0000-4000-8000-00000000000a';
  const inv = await http({ action: 'invite_owner' }, tC);
  await rpc('membresia_aceptar_invitacion', { code: inv.body.code, user_id: DUENA });
  // Norte: la dueña lo crea; su POS lo reclama con el código.
  const norteAlta = await rpc('pos_create_location', { user_id: DUENA, company_id: company, nombre: 'Norte', tipo: 'BRANCH' });
  const bootN = await http({ action: 'enroll', code: norteAlta.code, instance_uuid: randomUUID(), device_uuid: randomUUID(), kind: 'POS_PRIMARY' });
  check('B02', bootN.status === 200 && bootN.body.company_id === company, 'Centro y Norte son la MISMA empresa (cada uno con su SQL Server)');

  // Ventas de Centro y Norte del día (para el consolidado).
  q(`EXEC dbo.sp_open_shift @user_id=${uid('lupita')}, @opening_cash=0, @register_id=1;`);
  for (let i = 0; i < 2; i++) {
    q(`DECLARE @d1 dbo.SaleDetailType; DECLARE @d2 dbo.SaleDetailType2; DECLARE @mo dbo.SaleModifierType;
       INSERT INTO @d2 (line_no, product_id, quantity, unit_price) VALUES (1, ${C.id}, 2, 25);
       EXEC dbo.sp_register_sale @user_id=${uid('lupita')}, @payment_method=N'EFECTIVO', @SaleDetails=@d1, @register_id=1, @SaleDetails2=@d2, @SaleModifiers=@mo;`);
  }
  const centroSync = async () => {
    q('EXEC dbo.sp_sync_capture;');
    const evs = q(`SELECT TOP 200 LOWER(CONVERT(VARCHAR(36), event_uuid)) AS event_uuid, event_type, aggregate_type, LOWER(CONVERT(VARCHAR(36), aggregate_uuid)) AS aggregate_uuid,
                          CONVERT(VARCHAR(20), aggregate_version) AS aggregate_version, CONVERT(VARCHAR(40), occurred_at, 127) AS occurred_at, payload_version, payload
                     FROM dbo.sync_outbox WHERE status = 'PENDING' ORDER BY id;`);
    if (!evs.length) return { enviados: 0 };
    const r = await http({ action: 'events', envelope: { instance_uuid: inst, company_uuid: company, location_uuid: centro, server_fingerprint: huella },
      events: evs.map((e) => ({ ...e, payload_version: Number(e.payload_version), payload: JSON.parse(e.payload) })) }, tC);
    const acuses = (r.body.results ?? []).map((x) => ({ event_uuid: x.event_uuid, result: x.result, error: x.error ?? null }));
    q(`EXEC dbo.sp_sync_outbox_ack @acuses = N'${JSON.stringify(acuses).replace(/'/g, "''")}';`);
    return { enviados: acuses.filter((a) => a.result === 'APPLIED' || a.result === 'DUPLICATE').length, results: r.body.results ?? [], status: r.status, body: r.body };
  };
  await centroSync();
  const vN = randomUUID();
  await http({ action: 'events', events: [{ event_uuid: randomUUID(), event_type: 'SALE_RECORDED', aggregate_type: 'SALE', aggregate_uuid: vN, aggregate_version: 1,
    occurred_at: new Date().toISOString(), payload_version: 1, payload: { sale_uuid: vN, folio: 1, business_date: new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' }), total: 120, refunded_total: 0 } }] }, bootN.body.token);

  // --- El evento: la dueña crea la Feria (base Centro) y la abre.
  const feriaAlta = JSON.parse(comoUsuario('e2e', DUENA, `select owner_crear_evento('${company}', '{"nombre":"Feria León 2026","home_location_id":"${centro}","codigo":"FL26"}')::text`));
  const feria = feriaAlta.location_id;
  check('B03', feriaAlta.ok && feriaAlta.event_status === 'PLANNED', 'la dueña crea "Feria León 2026" [EVENT] con base Centro');
  JSON.parse(comoUsuario('e2e', DUENA, `select owner_evento_estado('${company}', '${feria}', 'OPEN')::text`));

  // --- Centro publica catálogo y personal (sus SPs reales) y registra su llave de firma.
  const pub = await http({ action: 'publish', catalog: JSON.parse(esc('EXEC dbo.sp_catalog_publication')), staff: JSON.parse(esc('EXEC dbo.sp_staff_publication')) }, tC);
  const { privateKey } = generateKeyPairSync('ed25519');
  const pubKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  await http({ action: 'register_key', public_key: pubKey }, tC);
  check('B04', pub.body.catalog_version === 1 && pub.body.staff === 2, 'Centro publica su catálogo (v1) y su personal con PIN');
  const emps = JSON.parse(comoUsuario('e2e', DUENA, `select owner_empleados('${company}')::text`));
  for (const e of emps) JSON.parse(comoUsuario('e2e', DUENA, `select owner_asignar_personal('${company}', '${feria}', '${e.id}', '${e.nombre === 'marta' ? 'SUPERVISOR' : 'CASHIER'}')::text`));

  // --- Transferencia 1: Centro envía 40 (descarga normal).
  const t1q = q(`EXEC dbo.sp_transfer_send @user_id=${uid('duena')}, @event_location_uuid='${feria}', @event_name=N'Feria León 2026', @lines=N'[{"product_uuid":"${A.uuid}","qty":40}]';`);
  const T1 = String(t1q[0].transfer_uuid).toLowerCase();
  check('B05', stockCentro(A) === 60, 'Centro envía 40 a la feria: Centro = 60 (TRANSFER_OUT en su SQL Server)', `A=${stockCentro(A)} · ${JSON.stringify(t1q[0])}`);
  await centroSync();

  // --- Tablet: enrolamiento, snapshot.
  const codigo = JSON.parse(comoUsuario('e2e', DUENA, `select owner_codigo_tablet('${company}', '${feria}', 'Caja Feria')::text`));
  const dir = mkdtempSync(join(tmpdir(), 'wx-tablet-'));
  const archivo = join(dir, 'pos.db');
  const red = { arriba: true };
  const TABLET = randomUUID();
  let token = null;
  const fetchTablet = async (url, init) => {
    if (!red.arriba) throw new TypeError('Network request failed');
    const r = await manejarPosSync(new Request(url, init), depsSync);
    return r;
  };
  const abrirTablet = async () => {
    const raw = new DatabaseSync(archivo);
    const db = adaptadorNode(raw);
    await migrar(db);
    const pos = crearPos(db);
    const nube = crearClienteNube({ base: 'https://nube.prueba', anonKey: 'anon', version: '0.1.0', credencial: async () => token, fetch: fetchTablet,
      identidad: async () => { try { const i = await pos.identidad(); return { company_uuid: i.company_uuid, location_uuid: i.location_uuid }; } catch { return null; } } });
    const sync = crearSincronizador({ db, nube, dispositivo: async () => TABLET, version: '0.1.0' });
    return { raw, db, pos, nube, sync };
  };
  let tab = await abrirTablet();
  const enr = await tab.nube.enrolar(codigo.code, TABLET, 'Tablet Feria');
  token = enr.token;
  await guardarEnrolamiento(tab.db, { device_uuid: TABLET, device_id: enr.device_id });
  const e0 = await tab.sync.sincronizar(true);
  const idT = await tab.pos.identidad();
  check('B06', idT.location_uuid === feria && idT.company_uuid === company && idT.register.code === 'F1' && e0.texto === 'Todo sincronizado',
    'tablet enrolada: Company -> EVENT -> Register F1 -> Device; snapshot descargado', e0.texto);
  const trustedT = await tab.db.all('SELECT key_id FROM trusted_keys');
  check('B07', trustedT.length === 1 && (await tab.db.all(`SELECT uuid FROM transfers WHERE status = 'PENDING'`)).length === 1,
    'la tablet tiene la transferencia pendiente y la llave de confianza de Centro');

  // =========================================================== SIN INTERNET
  red.arriba = false;
  log('          — se corta la red de la tablet —');
  const ident = async (u, pin) => { const r = await identificar(tab.db, (await tab.db.get(`SELECT uuid FROM staff WHERE name = ?`, [u])).uuid, pin); if (!r.ok) throw new Error(r.error); return r.persona; };
  const lupita = await ident('lupita', PIN.lupita);
  const malo = await identificar(tab.db, lupita.uuid, '0000');
  check('B08', !malo.ok && lupita.role === 'CASHIER', 'PIN offline: lupita entra como CAJERA del evento; un PIN incorrecto no');
  const marta = await ident('marta', PIN.marta);
  await tab.pos.recibirTransferencia(lupita, T1, {}, marta);
  // Transferencia 2 por QR: Centro manda 10 vasos y TAMPOCO tiene Internet (no sincroniza).
  const t2q = q(`EXEC dbo.sp_transfer_send @user_id=${uid('duena')}, @event_location_uuid='${feria}', @event_name=N'Feria León 2026', @lines=N'[{"product_uuid":"${B.uuid}","qty":10}]';`);
  const T2 = String(t2q[0].transfer_uuid).toLowerCase();
  const man = { v: 1, t: T2, c: company, f: centro, to: feria, k: bootC.body.device_id, at: new Date().toISOString(), l: [[B.uuid, '10.00']] };
  const cuerpo = `WXT1.${Buffer.from(JSON.stringify(man)).toString('base64url')}`;
  const qr = `${cuerpo}.${sign(null, Buffer.from(cuerpo), privateKey).toString('base64url')}`;
  const qrMalo = qr.replace(/\.([^.]+)\./, (_, m) => '.' + Buffer.from(JSON.stringify({ ...man, l: [[B.uuid, '100.00']] })).toString('base64url') + '.');
  const vq = verificarQr(qr, await tab.db.all('SELECT key_id, public_key FROM trusted_keys'), { company_uuid: company, location_uuid: feria });
  const vqMalo = verificarQr(qrMalo, await tab.db.all('SELECT key_id, public_key FROM trusted_keys'), { company_uuid: company, location_uuid: feria });
  check('B09', vq.ok && !vqMalo.ok && vqMalo.code === 'FIRMA', 'QR de Centro verificado SIN Internet; el mismo QR con 100 en vez de 10 se rechaza');
  await importarTransferencia(tab.db, aTransferencia(vq.manifiesto), vq.firma);
  await tab.pos.recibirTransferencia(marta, T2, {});
  const stockT = async (u) => (await tab.pos.stock()).find((s) => s.product_uuid === u)?.qty ?? '0';
  check('B10', (await stockT(A.uuid)) === '40' && (await stockT(B.uuid)) === '10', 'la tablet recibe 40 donas (descargadas) y 10 vasos (por QR)');

  // Turno, ventas (32 unidades: efectivo y tarjeta), merma.
  await tab.pos.abrirTurno(lupita, '500');
  for (let i = 0; i < 5; i++) await tab.pos.registrarVenta(lupita, [{ product_uuid: A.uuid, quantity: 4 }], [{ method: 'EFECTIVO', amount: '100.00', received: '200.00' }]);
  for (let i = 0; i < 3; i++) await tab.pos.registrarVenta(lupita, [{ product_uuid: A.uuid, quantity: 4 }], [{ method: 'TARJETA', amount: '100.00', reference: `AUT-${i}` }]);
  await tab.pos.registrarMerma(lupita, B.uuid, '1', 'Se rompió', marta);
  // Mientras tanto Centro sube el precio y publica v2: las ventas offline se quedan con v1.
  q(`UPDATE dbo.products SET price = 28 WHERE id = ${A.id};`);
  const pub2 = await http({ action: 'publish', catalog: JSON.parse(esc('EXEC dbo.sp_catalog_publication')), staff: JSON.parse(esc('EXEC dbo.sp_staff_publication')) }, tC);
  check('B11', (await stockT(A.uuid)) === '8' && (await stockT(B.uuid)) === '9', 'sin Internet: 32 vendidas -> EVENT = 8; merma de 1 vaso -> 9');

  // ---- Reinicio: se cierra la base de golpe y se vuelve a abrir.
  const pendAntes = (await resumen(tab.db)).pendientes;
  tab.raw.close();
  tab = await abrirTablet();
  const turnoTras = await tab.pos.turnoActual();
  check('B12', !!turnoTras && (await tab.db.get('SELECT COUNT(*) AS n FROM sales')).n === 8 && (await stockT(A.uuid)) === '8'
                && (await resumen(tab.db)).pendientes === pendAntes,
    'tras reiniciar: turno abierto, 8 ventas, EVENT = 8 y el outbox intacto', `${pendAntes} pendientes`);
  const lupita2 = await ident('lupita', PIN.lupita);
  const corteT = await tab.pos.cerrarTurno(lupita2, '1000');
  const sh = await tab.db.get(`SELECT expected, counted, difference FROM shifts WHERE uuid = ?`, [corteT.shift_uuid]);
  check('B13', corteT.ciego && sh.expected === '1000.00' && sh.difference === '0.00', 'corte a ciegas de la cajera: 500 fondo + 500 efectivo = 1000 (la tarjeta no entra al cajón)');
  const sinRed = await tab.sync.sincronizar(true);
  check('B14', !sinRed.en_linea && /Sin conexión/.test(sinRed.texto) && sinRed.pendientes > 0, 'sin red: la tablet lo dice y nada se pierde', sinRed.texto);
  evidencia.offline = { pendientes: sinRed.pendientes, texto: sinRed.texto, stock: await tab.pos.stock() };

  // =========================================================== VUELVE INTERNET
  red.arriba = true;
  log('          — vuelve la red —');
  const online = await tab.sync.sincronizar(true);
  check('B15', online.pendientes === 0 && online.rechazados === 0 && online.texto === 'Todo sincronizado', 'al volver la red: todo sube una sola vez', online.texto);
  const nubeVentas = uno(`select count(*)||'/'||sum(total) from sales_facts where location_id = '${feria}'`, 'e2e');
  check('B16', nubeVentas === '8/800.00', 'la nube tiene 8 ventas de la feria por $800', nubeVentas);
  check('B17', uno(`select string_agg(distinct catalog_version::text, ',') from sales_facts where location_id = '${feria}'`, 'e2e') === '1' && pub2.body.catalog_version === 2,
    'el precio cambió en Centro (catálogo v2) pero las ventas offline quedan con v1');
  // Reenviar TODO (se perdió el acuse): DUPLICATE y ningún total cambia.
  const antes = uno(`select (select count(*) from sync_events)||'/'||(select sum(total) from sales_facts)||'/'||(select sum(quantity) from inventory_ledger)`, 'e2e');
  await tab.db.run(`UPDATE outbox SET status = 'PENDING', next_attempt_at = NULL`);
  const reenvio = await tab.nube.enviarEventos({ events: await pendientes(tab.db, 500, '9999'), device_now: new Date().toISOString(), last_seq: 0 });
  await tab.sync.sincronizar(true);
  const despues = uno(`select (select count(*) from sync_events)||'/'||(select sum(total) from sales_facts)||'/'||(select sum(quantity) from inventory_ledger)`, 'e2e');
  check('B18', reenvio.results.every((x) => x.result === 'DUPLICATE') && antes === despues, 'el mismo lote otra vez: DUPLICATE, ningún total cambia', `${reenvio.results.length} eventos`);
  // Centro sincroniza su envío por QR DESPUÉS de que la tablet ya lo recibió.
  const cs = await centroSync();
  check('B19', uno(`select status||'/'||(select qty_received from stock_transfer_lines where transfer_uuid = '${T2}')::text from stock_transfers where transfer_uuid = '${T2}'`, 'e2e') === 'RECEIVED/10.00'
                && cs.results.every((x) => x.result === 'APPLIED'),
    'el envío por QR concilia aunque Centro sincronice después de la feria');

  // Owner: consolidado.
  const res = JSON.parse(comoUsuario('e2e', DUENA, `select resumen_empresa('${company}')::text`));
  const fila = (n) => res.ubicaciones.find((u) => u.nombre === n);
  evidencia.owner = res.ubicaciones.map((u) => ({ nombre: u.nombre, tipo: u.tipo, ventas: u.ventas.neto, tickets: u.ventas.tickets, ultima_sincronizacion: u.ultima_sincronizacion }));
  evidencia.total = res.total;
  check('B20', Number(fila('Centro').ventas.neto) === 100 && Number(fila('Norte').ventas.neto) === 120 && Number(fila('Feria León 2026').ventas.neto) === 800
                && Number(res.total.neto) === 1020 && !!fila('Feria León 2026').ultima_sincronizacion,
    'Owner: Centro $100 + Norte $120 + Feria $800 = $1,020 (con la hora de la última sincronización)');

  // Seguridad por HTTP.
  const otra = await http({ action: 'bootstrap', instance_uuid: randomUUID(), device_uuid: randomUUID(), nombre_negocio: 'Birriería XYZ' });
  const forja = await http({ action: 'events', envelope: { company_uuid: otra.body.company_id }, events: [] }, token);
  check('B21', forja.status === 403 && forja.body.code === 'ENVELOPE_MISMATCH', 'la tablet de I Do Nut no puede publicar como Birriería XYZ');
  const ajena = await http({ action: 'mobile_snapshot' }, otra.body.token);
  check('B22', ajena.status === 403, 'el snapshot de un evento no se entrega a un equipo de otra empresa');

  // =========================================================== RETORNO Y CIERRE
  const martaR = await ident('marta', PIN.marta);
  await tab.pos.regresarSobrante(martaR, [{ product_uuid: A.uuid, quantity: '8' }, { product_uuid: B.uuid, quantity: '9' }]);
  await tab.sync.sincronizar(true);
  check('B23', (await stockT(A.uuid)) === '0' && (await stockT(B.uuid)) === '0', 'la feria regresa 8 donas y 9 vasos: EVENT = 0');
  const bandeja = await http({ action: 'transfer_inbox' }, tC);
  const ret = bandeja.body.returns[0];
  q(`EXEC dbo.sp_transfer_receive_return @user_id=${uid('duena')}, @transfer_uuid='${ret.transfer_uuid}', @event_location_uuid='${feria}', @event_name=N'Feria León 2026',
       @lines=N'${JSON.stringify(ret.lines.map((l) => ({ product_uuid: l.product_uuid, qty_sent: Number(l.qty_sent), qty_received: Number(l.qty_sent) })))}';`);
  q(`EXEC dbo.sp_transfer_receive_return @user_id=${uid('duena')}, @transfer_uuid='${ret.transfer_uuid}', @event_location_uuid='${feria}', @event_name=N'Feria León 2026', @lines=N'[]';`);
  check('B24', stockCentro(A) === 68 && stockCentro(B) === 49, 'Centro recibe el retorno: A = 100 - 40 + 8 = 68 (y recibir dos veces no suma)', `A=${stockCentro(A)} B=${stockCentro(B)}`);
  await centroSync();
  check('B25', uno(`select status from stock_transfers where transfer_uuid = '${ret.transfer_uuid}'`, 'e2e') === 'RECEIVED', 'la nube ve el retorno RECIBIDO por Centro');
  JSON.parse(comoUsuario('e2e', DUENA, `select owner_evento_estado('${company}', '${feria}', 'CLOSED')::text`));
  const conc = JSON.parse(comoUsuario('e2e', DUENA, `select owner_evento_estado('${company}', '${feria}', 'RECONCILED')::text`));
  check('B26', conc.ok && conc.event_status === 'RECONCILED', 'la feria se concilia: inventario en cero, sin turnos ni mercancía en tránsito', JSON.stringify(conc));
  check('B27', uno(`select coalesce(sum(case when location_id = '${feria}' then qty end), 0)::text from location_stock`, 'e2e') === '0.00'
                && uno(`select count(*) from stock_transfers where company_id = '${company}' and status = 'SENT'`, 'e2e') === '0',
    'ledger de la feria = 0 y ninguna transferencia pendiente');

  // Reloj de la tablet 3 horas atrasado: la nube mide el desfase y la dueña lo ve.
  await tab.nube.enviarEventos({ events: [], device_now: new Date(Date.now() - 3 * 3600_000).toISOString(), last_seq: 0 });
  const tabEstado = JSON.parse(comoUsuario('e2e', DUENA, `select estado_dispositivos('${company}')::text`)).find((d) => d.kind === 'MOBILE_POS');
  check('B29', Math.abs(Number(tabEstado.clock_skew_seconds) - 10800) < 120, 'reloj de la tablet atrasado 3 h: la nube mide el desfase y la dueña lo ve en Equipos',
    `${tabEstado.clock_skew_seconds} s`);

  // Revocación al final: lo posterior queda en cuarentena.
  JSON.parse(comoUsuario('e2e', DUENA, `select owner_revocar_dispositivo('${company}', '${enr.device_id}')::text`));
  const tardia = await tab.nube.enviarEventos({ device_now: new Date().toISOString(), last_seq: 999, events: [{ local_seq: 999, event_uuid: randomUUID(), event_type: 'SALE_RECORDED',
    aggregate_type: 'SALE', aggregate_uuid: randomUUID(), occurred_at: new Date(Date.now() + 60_000).toISOString(), schema_version: 1, payload: { total: '25.00', business_date: '2026-11-02', refunded_total: '0' } }] });
  const estadoRev = await tab.sync.sincronizar(true);
  check('B28', tardia.results[0].result === 'QUARANTINED' && estadoRev.revocado, 'tablet revocada: lo posterior a la baja queda en cuarentena; ya no recibe maestros');
  evidencia.dispositivos = JSON.parse(comoUsuario('e2e', DUENA, `select estado_dispositivos('${company}')::text`));
  tab.raw.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }

  // ================================================================== PARTE C
  log('\nFASE 2 · PARTE C · reversa\n');
  const d1 = aplicar(F2_DOWN, 'e2e');
  check('C01', d1.ok && uno(`select to_regclass('public.inventory_ledger') is null and to_regclass('respaldo.fase2_rb_inventory_ledger') is not null`, 'e2e') === 't',
    'la reversa respalda lo de la Fase 2 y lo retira', d1.err);
  const fn = (n) => uno(`select pg_get_functiondef('public.${n}(jsonb)'::regprocedure) like '%QUARANTINED%'`, 'e2e');
  check('C02', fn('sync_ingest') === 'f' && uno(`select count(*) from respaldo.fase2_funciones_previas`, 'e2e') === '6'
                && uno(`select string_agg(distinct addons::text, ',') from licenses where 'MOBILE_POS' = any(addons)`, 'e2e') === ''
                && uno(`select active from license_catalog where code = 'ADDON_MOBILE_POS'`, 'e2e') === 'f',
    'vuelven las 6 funciones exactas de la Fase 1; MOBILE_POS se retira sin borrar la auditoría de precios');
  const d2 = aplicar(F2_DOWN, 'e2e'), r1 = aplicar(F2, 'e2e'), r2 = aplicar(F2, 'e2e');
  check('C03', d2.ok && r1.ok && r2.ok && fn('sync_ingest') === 't' && uno(`select active from license_catalog where code = 'ADDON_MOBILE_POS'`, 'e2e') === 't',
    'reversa idempotente; la Fase 2 se vuelve a aplicar (dos veces) y el complemento regresa', d2.err || r1.err || r2.err);
  mkdirSync(join(RAIZ, 'docs', 'evidencia'), { recursive: true });
  writeFileSync(join(RAIZ, 'docs', 'evidencia', 'fase2-idonut-e2e.json'), JSON.stringify(evidencia, null, 2) + '\n');
  log('\n   · Owner (lo que ve la dueña):');
  for (const u of evidencia.owner) log(`          ${u.tipo.padEnd(6)} ${u.nombre.padEnd(16)} $${String(u.ventas).padStart(8)}  ${u.tickets} tickets  última sync ${u.ultima_sincronizacion ?? '—'}`);
  log(`          TOTAL              $${String(evidencia.total.neto).padStart(8)}`);
} catch (e) {
  fallos++;
  log(`\nERROR: ${e?.stack || e}`);
} finally {
  docker(['rm', '-f', NOMBRE]);
  try { eliminar(CENTRO); } catch { /* noop */ }
}
log(`\n${pasos - fallos}/${pasos} comprobaciones correctas${fallos ? ` · ${fallos} FALLAS` : ''}\n`);
process.exit(fallos ? 1 : 0);
