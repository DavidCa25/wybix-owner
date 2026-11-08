// ============================================================================
//  AVISOS POR WHATSAPP · prueba de punta a punta sobre Postgres real
//
//      node --no-warnings scripts/probar-whatsapp.mjs
//
//  Copia la base local de Supabase (contenedor supabase_db_sb-local) a una
//  base temporal, aplica las migraciones que le faltan (dos veces la nuestra:
//  idempotente) y corre el flujo con el PROVEEDOR SIMULADO:
//    · el negocio conecta SU WhatsApp (enlace de un solo uso -> página ->
//      whatsapp-conectar con el Graph simulado), token cifrado en la base;
//    · la caja marca un pedido listo -> función whatsapp-avisos -> sale por
//      el número del negocio;
//    · el ciclo del motor planea las membresías por vencer y las manda;
//    · Meta (simulado) reporta leído; el cliente se da de baja.
//  Comprueba idempotencia, opt-out, vigencia y permisos con los defaults de
//  Supabase. La base temporal se borra al terminar.
// ============================================================================
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { avisosWhatsapp, cicloWhatsApp, cifradorDe, conectarWhatsapp, grafoSimulado, webhookWhatsapp, whatsappSimulado } from '../supabase/functions/_shared/whatsapp.ts';

const container = 'supabase_db_sb-local', db = 'wybix_tmp_whatsapp', DUMP = '/tmp/wybix-whatsapp.dump';
const run = (args, input) => { const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw Error(r.stderr.slice(0, 800)); return r.stdout; };
const sql = (text) => run(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A'], text);
const uno = (text) => { const o = sql(text).trim(); return o ? JSON.parse(o) : null; };

/* rpc de la función: `public.fn(p jsonb)`. rpcArgs: argumentos con nombre. */
const lit = (v) => v == null ? 'null' : `$v$${typeof v === 'object' ? JSON.stringify(v) : String(v)}$v$`;
const CONJUNTOS = new Set(['wa_tomar', 'wa_tomar_uno']);
let equipo = null;
const rpc = async (fn, p) => {
  /* La credencial ya la probó pos-sync; aquí el equipo autenticado es el de la prueba. */
  if (fn === 'device_autenticar') return equipo;
  return uno(`select public.${fn}(${lit(p)}::jsonb)::text;`);
};
const rpcArgs = async (fn, a = {}) => {
  const args = Object.entries(a).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
  if (CONJUNTOS.has(fn)) return uno(`select coalesce(jsonb_agg(to_jsonb(t)), '[]')::text from public.${fn}(${args}) t;`);
  return uno(`select to_jsonb(public.${fn}(${args}))::text;`);
};
let wa = whatsappSimulado();
const clave = await cifradorDe(randomBytes(32).toString('base64'));
const grafo = grafoSimulado();
const entorno = () => ({ wa, grafo, clave, app: { id: 'simulado', configId: 'simulado', version: 'v23.0' }, conectarUrl: 'https://web.test/whatsapp/conectar' });
const llamarCaja = async (cuerpo) => (await avisosWhatsapp(new Request('https://local.test/whatsapp-avisos', {
  method: 'POST', headers: { 'x-wybix-device': 'credencial-de-prueba-123456' }, body: JSON.stringify(cuerpo) }), { rpc, rpcArgs, entorno: entorno() })).json();
const pagina = async (cuerpo) => { const r = await conectarWhatsapp(new Request('https://web.test/backend/functions/v1/whatsapp-conectar', {
  method: 'POST', body: JSON.stringify(cuerpo) }), { rpcArgs, entorno: entorno() }); return { status: r.status, ...(await r.json()) }; };
const NUMERO = '109876543210';
let pasos = 0;
const ok = (titulo) => { pasos++; console.log(`   ok  ${titulo}`); };

const existe = run(['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', `select 1 from pg_database where datname='${db}'`]);
if (existe.trim()) throw Error('La base temporal ya existe; no se sobrescribe.');
let creada = false;
try {
  run(['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--no-owner', '--no-privileges', '--schema=public', '--schema=auth', '--schema=extensions', '-Fc', '-f', DUMP]);
  run(['exec', container, 'createdb', '-U', 'postgres', db]); creada = true;
  sql('DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS extensions CASCADE;');
  run(['exec', container, 'pg_restore', '-U', 'postgres', '-d', db, '--no-owner', '--no-privileges', '--exit-on-error', DUMP]);
  /* Los defaults de Supabase: todo lo nuevo nace abierto a anon/authenticated si la migración no lo cierra. */
  sql('alter default privileges in schema public grant all on tables to anon,authenticated,service_role;alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;');
  const ultima = run(['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', 'select max(version) from supabase_migrations.schema_migrations']).trim();
  const faltan = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql') && f.slice(0, 14) > ultima).sort();
  for (const f of faltan) sql(readFileSync('supabase/migrations/' + f, 'utf8'));
  sql(readFileSync('supabase/migrations/20261028140000_whatsapp_avisos.sql', 'utf8'));
  console.log(`\nAVISOS POR WHATSAPP   (${db}; ${faltan.length} migraciones sobre ${ultima}, la de WhatsApp dos veces)\n`);

  // ------------------------------------------------------------ permisos
  sql(`do $$ begin
    if has_table_privilege('anon','public.wa_messages','SELECT') or has_table_privilege('authenticated','public.wa_optouts','INSERT')
       or has_table_privilege('authenticated','public.wa_settings','UPDATE')
       or has_function_privilege('anon','public.wa_pedido_listo(jsonb)','EXECUTE') or has_function_privilege('authenticated','public.wa_baja(jsonb)','EXECUTE')
       or has_function_privilege('authenticated','public.wa_tomar(integer)','EXECUTE')
       or has_table_privilege('anon','public.wa_cuentas','SELECT') or has_table_privilege('authenticated','public.wa_conexiones','SELECT')
       or has_function_privilege('anon','public.wa_credencial(uuid)','EXECUTE') or has_function_privilege('anon','public.wa_conexion_sesion(text)','EXECUTE') then raise exception 'Grants abiertos'; end if;
    if not has_function_privilege('service_role','public.wa_pedido_listo(jsonb)','EXECUTE') then raise exception 'Falta service_role'; end if;
  end $$;`);
  ok('anon/authenticated no tocan tablas ni funciones de WhatsApp; service_role sí');

  // ------------------------------------------------------------ fixtures
  const neg = randomUUID(), suc = randomUUID(), pri = randomUUID(), sec = randomUUID();
  sql(`insert into public.negocios (id, nombre, status) values ('${neg}', 'I Do Nut QA', 'ACTIVE');
       insert into public.sucursales (id, negocio_id, nombre, device_key, status, timezone) values ('${suc}', '${neg}', 'Centro', 'qa-${suc}', 'ACTIVE', 'America/Mexico_City');
       insert into public.devices (id, company_id, location_id, kind, status) values ('${pri}', '${neg}', '${suc}', 'POS_PRIMARY', 'ACTIVE'), ('${sec}', '${neg}', '${suc}', 'POS_SECONDARY', 'ACTIVE');`);
  equipo = { ok: true, device_id: pri, company_id: neg, location_id: suc, kind: 'POS_PRIMARY' };

  // -------------------------------------------------------------- ajustes
  let r = await llamarCaja({ action: 'config', accion: 'leer' });
  assert.equal(r.config.pedido_listo, false); assert.equal(r.config.membresia, false);
  ok('sin ajustes guardados todo está apagado');
  equipo = { ...equipo, device_id: sec };
  r = await llamarCaja({ action: 'config', accion: 'guardar', config: { pedido_listo: true } });
  assert.equal(r.code, 'NOT_PRIMARY');
  equipo = { ...equipo, device_id: pri };
  ok('una caja secundaria no cambia los ajustes');

  // --------------------------------------------------------- pedido listo
  const aviso = randomUUID();
  const pedido = { action: 'pedido_listo', id: aviso, numero: 12, telefono: '55 1234 5678', url: 'http://192.168.1.20:8787/p/0123456789ABCDEF0123456789ABCDEF' };
  r = await llamarCaja(pedido);
  assert.equal(r.code, 'DESACTIVADO'); assert.equal(wa.enviados.length, 0);
  ok('apagado: la caja recibe DESACTIVADO y no sale nada');

  r = await llamarCaja({ action: 'config', accion: 'guardar', config: { pedido_listo: true, membresia: true, dias_antes: 3, como_renovar: 'paga en caja o por transferencia.' } });
  assert.equal(r.success, true); assert.equal(r.config.dias_antes, 3); assert.equal(r.cuenta, null);
  r = await llamarCaja(pedido);
  assert.equal(r.code, 'SIN_NUMERO'); assert.equal(wa.enviados.length, 0);
  ok('encendido pero sin el WhatsApp del negocio conectado: SIN_NUMERO, no sale nada');

  // ------------------------------------------- conectar el número del negocio
  equipo = { ...equipo, device_id: sec };
  r = await llamarCaja({ action: 'conexion', accion: 'iniciar' });
  assert.equal(r.code, 'NOT_PRIMARY');
  equipo = { ...equipo, device_id: pri };
  const viejo1 = /#t=([0-9a-f]{64})$/.exec((await llamarCaja({ action: 'conexion', accion: 'iniciar' })).url)[1];
  r = await llamarCaja({ action: 'conexion', accion: 'iniciar' });
  const t = /#t=([0-9a-f]{64})$/.exec(r.url)[1];
  assert.equal((await pagina({ action: 'sesion', t: viejo1 })).code, 'ENLACE_VENCIDO', 'pedir otro enlace invalida el anterior');
  assert.equal(uno(`select count(*)::text from public.wa_conexiones where token_hash = '${t}'`), 0, 'en la base solo está el hash');
  let s = await pagina({ action: 'sesion', t });
  assert.equal(s.negocio, 'I Do Nut QA'); assert.equal(s.modo, 'simulado');
  s = await pagina({ action: 'finalizar', t, code: 'CODIGO-DE-META-1', waba_id: '99887766', phone_number_id: NUMERO });
  assert.equal(s.success, true, JSON.stringify(s)); assert.equal(s.cuenta.status, 'ACTIVA');
  assert.equal((await pagina({ action: 'finalizar', t, code: 'CODIGO-DE-META-2', waba_id: '99887766', phone_number_id: NUMERO })).code, 'ENLACE_VENCIDO');
  const cuentaFila = uno(`select to_jsonb(c)::text from public.wa_cuentas c where company_id = '${neg}'`);
  assert.ok(!cuentaFila.token_cifrado.includes('sim-token'), 'token cifrado en la base');
  assert.match(await clave.descifrar(cuentaFila.token_cifrado), /^sim-token-CODIGO-DE-META-1/);
  assert.equal(Object.values(cuentaFila.plantillas).filter((v) => v === 'APPROVED').length, 4);
  r = await llamarCaja({ action: 'config', accion: 'leer' });
  assert.equal(r.cuenta.status, 'ACTIVA'); assert.equal(r.cuenta.token_cifrado, undefined, 'la caja nunca ve el token');
  ok('conectar: enlace de un solo uso (solo el hash en la base), Embedded Signup simulado, token cifrado, 4 plantillas');

  const otroNeg = randomUUID(), tOtro = 'c'.repeat(64);
  sql(`insert into public.negocios (id, nombre, status) values ('${otroNeg}', 'Otro', 'ACTIVE');
       insert into public.wa_conexiones (token_hash, company_id, device_id, expires_at)
       values (encode(sha256('${tOtro}'::bytea), 'hex'), '${otroNeg}', '${pri}', now() + interval '5 minutes');`);
  s = await pagina({ action: 'finalizar', t: tOtro, code: 'CODIGO-DE-META-3', waba_id: '11223344', phone_number_id: NUMERO });
  assert.equal(s.code, 'NUMERO_OCUPADO');
  ok('un número ya conectado a un negocio no se puede conectar a otro');

  sql(`update public.wa_cuentas set plantillas = plantillas || '{"wybix_pedido_listo_seguimiento":"PENDING","wybix_pedido_listo":"PENDING"}' where company_id = '${neg}'`);
  r = await llamarCaja({ ...pedido, id: randomUUID() });
  assert.equal(r.code, 'PLANTILLA_PENDIENTE');
  sql(`update public.wa_cuentas set plantillas = plantillas || '{"wybix_pedido_listo_seguimiento":"APPROVED","wybix_pedido_listo":"APPROVED"}' where company_id = '${neg}'`);
  ok('sin la plantilla aprobada en la WABA del negocio no se encola');

  r = await llamarCaja(pedido);
  assert.equal(r.code, 'ENCOLADO'); assert.equal(r.status, 'SENT');
  assert.equal(wa.enviados.length, 1);
  assert.equal(wa.enviados[0].phone, '525512345678', 'teléfono normalizado con lada 52');
  assert.equal(wa.enviados[0].desde, NUMERO, 'sale por el número del negocio');
  assert.equal(wa.enviados[0].template, 'wybix_pedido_listo_seguimiento');
  assert.deepEqual(wa.enviados[0].params, ['12', 'I Do Nut QA', pedido.url]);
  ok('pedido listo: se encola y sale en el acto con número, negocio y enlace de seguimiento');

  r = await llamarCaja(pedido);
  assert.equal(r.code, 'YA'); assert.equal(wa.enviados.length, 1);
  await cicloWhatsApp({ rpc: rpcArgs, wa, clave });
  assert.equal(wa.enviados.length, 1);
  ok('idempotente: el mismo aviso otra vez (caja o ciclo) no vuelve a salir');

  r = await llamarCaja({ ...pedido, id: randomUUID(), telefono: '123' });
  assert.equal(r.code, 'TEL_INVALIDO');
  r = await llamarCaja({ ...pedido, id: randomUUID(), url: 'javascript:alert(1)' });
  assert.equal(wa.enviados.at(-1).template, 'wybix_pedido_listo', 'un enlace que no es http(s) se descarta');
  ok('teléfono inválido no se encola; enlace raro se descarta');

  // ------------------------------------------------ estados de Meta (webhook)
  const SECRETO = 'secreto-de-la-app-de-meta-123', VERIFICA = 'token-de-verificacion-123';
  const webhook = async (value) => {
    const raw = JSON.stringify({ entry: [{ id: '99887766', changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMERO }, ...value } }] }] });
    return webhookWhatsapp(new Request('https://local.test/whatsapp-webhook', { method: 'POST', body: raw,
      headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRETO).update(raw).digest('hex')}` } }), { appSecret: SECRETO, verifyToken: VERIFICA, rpc, rpcArgs });
  };
  const primero = uno(`select to_jsonb(m)::text from public.wa_messages m where ref_key = '${aviso}'`);
  await webhook({ statuses: [{ id: primero.provider_ref, status: 'read' }] });
  await webhook({ statuses: [{ id: primero.provider_ref, status: 'delivered' }] });
  const leido = uno(`select to_jsonb(m)::text from public.wa_messages m where ref_key = '${aviso}'`);
  assert.equal(leido.status, 'READ'); assert.ok(leido.read_at && leido.delivered_at);
  ok('webhook: leído se registra y un «entregado» tardío no lo regresa');

  // -------------------------------------------------------------- opt-out
  const bajaOtro = uno(`select public.wa_baja(${lit({ message_id: primero.id, phone: '5219999999999', phone_number_id: NUMERO, source: 'BOTON' })}::jsonb)::text`);
  assert.equal(bajaOtro.code, 'NOT_FOUND');
  const bajaOtroNumero = uno(`select public.wa_baja(${lit({ message_id: primero.id, phone: '5215512345678', phone_number_id: '555555555', source: 'BOTON' })}::jsonb)::text`);
  assert.equal(bajaOtroNumero.code, 'NOT_FOUND', 'por un número que no es el del negocio no hay baja');
  await webhook({ messages: [{ from: '5215512345678', type: 'button', button: { payload: `BAJA:${primero.id}` } }] });
  r = await llamarCaja({ ...pedido, id: randomUUID() });
  assert.equal(r.code, 'OPT_OUT'); assert.equal(wa.enviados.length, 2);
  const omitido = uno(`select to_jsonb(m)::text from public.wa_messages m where status = 'SKIPPED' and last_error = 'OPT_OUT' and kind = 'PEDIDO_LISTO'`);
  assert.ok(omitido, 'queda registrado como omitido');
  ok('opt-out: el botón de otro teléfono u otro número no da de baja; el del cliente sí, y el siguiente aviso queda SKIPPED');

  r = await llamarCaja({ action: 'telefono', accion: 'estado_tel', telefono: '5512345678' });
  assert.equal(r.baja, true);
  r = await llamarCaja({ action: 'telefono', accion: 'alta', telefono: '5512345678' });
  assert.equal(r.baja, false);
  ok('la caja consulta y reactiva a petición del cliente');

  // ----------------------------------------------------------- membresías
  /* Un mediodía de la Ciudad de México, para no depender de la hora real. */
  const mediodia = uno(`select to_jsonb(((current_date + time '12:00') at time zone 'America/Mexico_City'))::text`);
  const plan = randomUUID(), m3 = randomUUID(), m0 = randomUUID(), m9 = randomUUID(), mBaja = randomUUID();
  sql(`insert into public.club_plans (uuid, company_id, name) values ('${plan}', '${neg}', 'Club Donut');
       insert into public.club_memberships (uuid, company_id, plan_uuid, customer_name, phone, paid_until, location_id) values
        ('${m3}', '${neg}', '${plan}', 'Ana', '5511110000', current_date + 3, '${suc}'),
        ('${m0}', '${neg}', '${plan}', 'Luis', '5522220000', current_date, '${suc}'),
        ('${m9}', '${neg}', '${plan}', 'Eva', '5533330000', current_date + 9, '${suc}'),
        ('${mBaja}', '${neg}', '${plan}', 'Sin avisos', '5544440000', current_date + 2, '${suc}');
       insert into public.wa_optouts (company_id, phone, source) values ('${neg}', '525544440000', 'CAJA');`);
  const madrugada = uno(`select to_jsonb(((current_date + time '03:00') at time zone 'America/Mexico_City'))::text`);
  assert.equal(await rpcArgs('wa_planear_membresias', { p_forzar: true, p_ahora: madrugada }), 0);
  ok('a las 3:00 de la sucursal no se planea ningún recordatorio');

  assert.equal(await rpcArgs('wa_planear_membresias', { p_forzar: true, p_ahora: mediodia }), 3);
  assert.equal(await rpcArgs('wa_planear_membresias', { p_forzar: true, p_ahora: mediodia }), 0);
  const antes = wa.enviados.length;
  const ciclo = await cicloWhatsApp({ rpc: rpcArgs, wa, clave });
  assert.equal(ciclo.ok, 2);
  const nuevos = wa.enviados.slice(antes);
  const porTel = Object.fromEntries(nuevos.map((m) => [m.phone, m]));
  assert.equal(porTel['525511110000'].template, 'wybix_membresia_por_vencer');
  assert.deepEqual(porTel['525511110000'].params.slice(0, 2), ['Club Donut', 'I Do Nut QA']);
  assert.equal(porTel['525511110000'].params[3], 'paga en caja o por transferencia');
  assert.equal(porTel['525522220000'].template, 'wybix_membresia_vence_hoy');
  assert.equal(porTel['525533330000'], undefined, 'a 9 días no se avisa con dias_antes = 3');
  assert.equal(porTel['525544440000'], undefined, 'la baja se respeta');
  ok('membresías: por vencer (3 días) y vence hoy salen por el ciclo; a 9 días no; la baja se respeta; planear dos veces no duplica');

  sql(`update public.club_memberships set paid_until = current_date + 33 where uuid = '${m0}';
       update public.club_memberships set paid_until = current_date + 2 where uuid = '${m9}';`);
  assert.equal(await rpcArgs('wa_planear_membresias', { p_forzar: true, p_ahora: mediodia }), 1);
  ok('renovar abre un ciclo nuevo: el que entra en la ventana recibe su aviso');

  const nueva = () => sql(`insert into public.club_memberships (uuid, company_id, plan_uuid, phone, paid_until, location_id)
                            values ('${randomUUID()}', '${neg}', '${plan}', '55${Math.floor(10000000 + Math.random() * 89999999)}', current_date + 1, '${suc}');`);
  sql('update public.wa_planner_state set last_run = null;');   // los ciclos de arriba ya gastaron la hora
  nueva();
  assert.equal(await rpcArgs('wa_planear_membresias', { p_ahora: mediodia }), 1);
  nueva();
  assert.equal(await rpcArgs('wa_planear_membresias', { p_ahora: mediodia }), 0, 'dentro de la hora no vuelve a trabajar');
  assert.equal(await rpcArgs('wa_planear_membresias', { p_forzar: true, p_ahora: mediodia }), 1);
  ok('sin forzar, el planeador trabaja una vez por hora');

  // ------------------------------------------------------------- vigencia
  const viejo = randomUUID();
  r = await llamarCaja({ ...pedido, id: viejo, telefono: '5566660000' });
  wa = whatsappSimulado({ fallar: () => ({ ok: false, error: 'meta 503', permanente: false }) });
  sql(`update public.wa_messages set status = 'PENDING', expires_at = now() - interval '1 minute' where ref_key = '${viejo}'`);
  await cicloWhatsApp({ rpc: rpcArgs, wa, clave });
  const vencido = uno(`select to_jsonb(m)::text from public.wa_messages m where ref_key = '${viejo}'`);
  assert.equal(vencido.status, 'SKIPPED'); assert.equal(vencido.last_error, 'VENCIDA');
  ok('un pedido listo vencido (más de 30 min) ya no sale');

  // ------------------------------------------- plantillas y cuenta por webhook
  const wbx = async (field, value) => {
    const raw = JSON.stringify({ entry: [{ id: '99887766', changes: [{ field, value }] }] });
    return webhookWhatsapp(new Request('https://local.test/whatsapp-webhook', { method: 'POST', body: raw,
      headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRETO).update(raw).digest('hex')}` } }), { appSecret: SECRETO, verifyToken: VERIFICA, rpc, rpcArgs });
  };
  await wbx('message_template_status_update', { event: 'PAUSED', message_template_name: 'wybix_membresia_vence_hoy', message_template_language: 'es_MX' });
  assert.equal(uno(`select to_jsonb(plantillas->>'wybix_membresia_vence_hoy')::text from public.wa_cuentas where company_id = '${neg}'`), 'PAUSED');
  ok('webhook: Meta pausa una plantilla y queda registrada en la cuenta del negocio');

  r = await llamarCaja({ action: 'registro' });
  assert.ok(r.resumen.enviados >= 4 && r.resumen.leidos === 1 && r.resumen.omitidos >= 2, JSON.stringify(r.resumen));
  assert.ok(r.avisos.every((a) => /^•••\d{4}$/.test(a.telefono)), 'el registro enmascara el teléfono');
  ok('registro de la caja: enviados, leídos, omitidos; teléfonos enmascarados');

  // ---------------------------------------------------------- desconectar
  const pend = randomUUID();
  wa = whatsappSimulado({ fallar: () => ({ ok: false, error: 'meta 503', permanente: false }) });
  r = await llamarCaja({ ...pedido, id: pend, telefono: '5577770000' });
  assert.equal(r.status, 'PENDING');
  await wbx('account_update', { event: 'PARTNER_REMOVED' });
  const cu = uno(`select to_jsonb(c)::text from public.wa_cuentas c where company_id = '${neg}'`);
  assert.equal(cu.status, 'DESCONECTADA'); assert.equal(cu.token_cifrado, null, 'el token se borra');
  wa = whatsappSimulado();
  sql(`update public.wa_messages set next_attempt_at = now() where ref_key = '${pend}'`);
  await cicloWhatsApp({ rpc: rpcArgs, wa, clave });
  assert.equal(wa.enviados.length, 0);
  assert.equal(uno(`select to_jsonb(last_error)::text from public.wa_messages where ref_key = '${pend}'`), 'SIN_NUMERO');
  r = await llamarCaja({ ...pedido, id: randomUUID() });
  assert.equal(r.code, 'SIN_NUMERO');
  ok('el negocio quita a Wybix en Meta: cuenta DESCONECTADA, token borrado, lo pendiente no sale');

  console.log(`\nWHATSAPP_OK: ${pasos} comprobaciones con el proveedor simulado sobre Postgres real`);
} finally {
  if (creada) run(['exec', container, 'dropdb', '-U', 'postgres', db]);
  run(['exec', container, 'rm', '-f', DUMP]);
}
