/**
 * GRUPOS DE EMPRESAS EN LA NUBE (POS 0080 · MultiEmpresa), SIN TOCAR PRODUCCIÓN.
 *
 *     node --no-warnings scripts/probar-grupos.mjs [--conservar]
 *
 * Sobre el contenedor de scripts/probar-fase3.mjs (toda la cadena de
 * migraciones; se crea si no existe), por la Edge Function REAL
 * (_shared/pos-sync.ts) con HTTP simulado:
 *
 *   1. la migración se aplica dos veces y nadie más que service_role ve sus
 *      tablas o ejecuta sus funciones;
 *   2. enlace con código: un uso, caduca, no se usa en la propia empresa, una
 *      empresa en un grupo de varias no se mueve sola, una sola sí;
 *   3. consulta: solo empresas del grupo (una ajena recibe NOT_IN_GROUP), el
 *      resumen sale de los hechos y el catálogo de lo publicado;
 *   4. bandeja: forma validada, idempotente por client_key, entrega al menos
 *      una vez (reentrega a los 10 min), solo el destino responde, salir del
 *      grupo cancela lo pendiente;
 *   5. una caja secundaria no puede nada de esto.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { manejarPosSync } from '../supabase/functions/_shared/pos-sync.ts';
import { rpcPostgrest } from '../supabase/functions/_shared/nube.ts';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOMBRE = 'wybix-grupos-prueba';
const MIG = join(RAIZ, 'supabase', 'migrations', '20261108120000_grupos_empresas.sql');
const conservar = process.argv.includes('--conservar');
let fallos = 0, pasos = 0;
const check = (id, ok, msg, det = '') => { pasos++; if (!ok) fallos++; console.log(`   ${ok ? 'ok   ' : 'FALLA'}  ${id}. ${msg}${det ? '  · ' + det : ''}`); };
const docker = (args, entrada) => { const r = spawnSync('docker', args, { input: entrada, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const psql = (s) => docker(['exec', '-i', NOMBRE, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A'], s);
const uno = (s) => { const r = psql(s); if (r.code !== 0) throw new Error(r.err.slice(0, 300)); return r.out.trim(); };

const rpcPsql = async (fn, p) => {
  if (!/^[a-z_]+$/.test(fn)) throw new Error('rpc inválida');
  const et = '$j' + randomUUID().replace(/-/g, '') + '$';
  const r = psql(`set role service_role; select public.${fn}(${et}${JSON.stringify(p)}${et}::jsonb)::text;`);
  if (r.code !== 0) throw new Error(`${fn}: ${r.err.trim().slice(0, 300)}`);
  return JSON.parse(r.out.trim() || 'null');
};
const fetchSimulado = async (url, init) => ({ ok: true, status: 200, json: async () => rpcPsql(String(url).split('/rpc/')[1], JSON.parse(init.body).p) });
const depsSync = { rpc: rpcPostgrest('http://sb', 'service', fetchSimulado), espejo: { escribir: async () => null, existeAlerta: async () => false }, borrarUsuario: async () => {} };

const llamar = async (token, action, cuerpo = {}) => {
  const headers = { 'content-type': 'application/json', ...(token ? { 'x-wybix-device': token } : {}) };
  const r = await manejarPosSync(new Request('http://x/pos-sync', { method: 'POST', headers, body: JSON.stringify({ action, ...cuerpo }) }), depsSync);
  return { status: r.status, ...(await r.json()) };
};

/** Una empresa nueva, con su caja principal (como la primera vez que sincroniza un POS). */
async function empresaNueva(nombre) {
  const r = await llamar(null, 'bootstrap', { instance_uuid: randomUUID(), device_uuid: randomUUID(), nombre_negocio: nombre, nombre_sucursal: 'Matriz' });
  if (!r.success) throw new Error(`bootstrap ${nombre}: ${JSON.stringify(r)}`);
  return { nombre, token: r.token, company: r.company_id, loc: r.location_id, device: r.device_id };
}

const t0 = Date.now();
try {
  if (docker(['exec', NOMBRE, 'pg_isready', '-U', 'postgres']).code !== 0) {
    console.log('\n(no está el contenedor: se arma la cadena de la Fase 3)');
    const f3 = spawnSync(process.execPath, ['--no-warnings', join(RAIZ, 'scripts', 'probar-fase3.mjs'), '--conservar'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, WYBIX_PRUEBA_CONTENEDOR: NOMBRE } });
    const resumen = (f3.stdout || '').trim().split(/\r?\n/).filter((l) => /comprobaciones|FALLA/.test(l)).slice(-6).join(' | ');
    check('GR-00', docker(['exec', NOMBRE, 'pg_isready', '-U', 'postgres']).code === 0, 'cadena completa de migraciones (Fase 3)', resumen);
  }

  console.log('\nGRUPOS · migración\n');
  for (const vez of [1, 2]) {
    const a = psql(readFileSync(MIG, 'utf8'));
    check(`GR-MIG${vez}`, a.code === 0, `se aplica (vez ${vez})`, a.err.replace(/^(NOTICE|WARNING).*$/gm, '').trim().slice(0, 300));
  }
  const priv = uno(`select count(*) from information_schema.role_table_grants where table_name like 'company_group%' and grantee in ('anon','authenticated','PUBLIC');`);
  check('GR-01', priv === '0', 'anon/authenticated no tienen permisos sobre las tablas', `${priv} grants`);
  const fpriv = uno(`select count(*) from pg_proc p where (p.proname like 'grupo\\_%' or p.proname like 'wx\\_grupo%' or p.proname = 'wx_mismo_grupo')
                      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));`);
  check('GR-02', fpriv === '0', 'ni pueden ejecutar sus funciones', `${fpriv} con execute`);

  const A = await empresaNueva('I Do Nut QA');
  const B = await empresaNueva('Birrialtlan QA');
  const C = await empresaNueva('Tercera QA');
  const D = await empresaNueva('Ajena QA');

  console.log('\nGRUPOS · enlace con código\n');
  const codA = await llamar(A.token, 'grupo_codigo');
  check('GR-03', codA.success && /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codA.code), 'la caja principal genera un código', codA.code);
  const propio = await llamar(A.token, 'grupo_unir', { code: codA.code });
  check('GR-04', propio.status === 403 && propio.code === 'SAME_COMPANY', 'no se usa en la misma empresa');
  const uneB = await llamar(B.token, 'grupo_unir', { code: codA.code.toLowerCase().replace(/-/g, ' ') });
  check('GR-05', uneB.success && uneB.ya_estaba === false, 'otra empresa se une (el código se acepta sin guiones ni mayúsculas)');
  const otraVez = await llamar(C.token, 'grupo_unir', { code: codA.code });
  check('GR-06', otraVez.status === 403 && otraVez.code === 'BAD_CODE', 'el código es de un solo uso');
  const codB = await llamar(B.token, 'grupo_codigo');
  uno(`update company_group_codes set expires_at = now() - interval '1 minute' where code_hash = wx_codigo_hash('${codB.code}');`);
  check('GR-07', (await llamar(C.token, 'grupo_unir', { code: codB.code })).code === 'BAD_CODE', 'un código caducado no sirve');
  const codB2 = await llamar(B.token, 'grupo_codigo');
  check('GR-08', (await llamar(C.token, 'grupo_unir', { code: codB2.code })).success, 'cualquiera del grupo puede invitar: entra una tercera');

  const listaA = await llamar(A.token, 'grupo_listar');
  const nombres = (listaA.empresas || []).map((e) => e.nombre).sort();
  check('GR-09', JSON.stringify(nombres) === JSON.stringify(['Birrialtlan QA', 'Tercera QA']), 'A ve a las otras dos, no a sí misma', JSON.stringify(nombres));
  check('GR-10', listaA.empresas.every((e) => e.ubicaciones.length === 1 && e.ubicaciones[0].instance_uuid), 'con su ubicación y su instancia (para no duplicar las locales)');
  const listaD = await llamar(D.token, 'grupo_listar');
  check('GR-11', listaD.success && listaD.grupo === null && listaD.empresas.length === 0, 'una empresa sin grupo no ve a nadie');

  const codD = await llamar(D.token, 'grupo_codigo');   // D queda en su propio grupo, de una
  const codC = await llamar(C.token, 'grupo_codigo');
  check('GR-12', (await llamar(D.token, 'grupo_unir', { code: codC.code })).success, 'una empresa sola en su grupo se cambia a otro');
  check('GR-13', (await llamar(D.token, 'grupo_salir')).success, 'y puede salir');
  const codA2 = await llamar(A.token, 'grupo_codigo');
  const atrapada = await llamar(B.token, 'grupo_unir', { code: codD.code });
  check('GR-14', atrapada.code === 'BAD_CODE' || atrapada.code === 'IN_OTHER_GROUP', 'el código de un grupo que se vació no mete a nadie a escondidas', atrapada.code);
  const codDnuevo = await llamar(D.token, 'grupo_codigo');
  const mover = await llamar(B.token, 'grupo_unir', { code: codDnuevo.code });
  check('GR-15', mover.status === 403 && mover.code === 'IN_OTHER_GROUP', 'una empresa en un grupo de varias no se mueve sola');
  void codA2;

  console.log('\nGRUPOS · consulta (Fase 2)\n');
  const hoy = uno(`select current_date::text;`);
  const turno = randomUUID();
  uno(`insert into sales_facts (sale_uuid, company_id, location_id, business_date, occurred_at, total, refunded_total, version)
       values ('${randomUUID()}', '${B.company}', '${B.loc}', '${hoy}', now(), 300, 0, 1),
              ('${randomUUID()}', '${B.company}', '${B.loc}', '${hoy}', now(), 200, 50, 1),
              ('${randomUUID()}', '${B.company}', '${B.loc}', '${hoy}'::date - 3, now() - interval '3 days', 999, 0, 1);
       insert into shift_facts (shift_uuid, company_id, location_id, status, business_date, opened_at, opening_cash, version)
       values ('${turno}', '${B.company}', '${B.loc}', 'OPEN', '${hoy}', now(), 500, 1);
       insert into cash_movement_facts (movement_uuid, company_id, location_id, shift_uuid, type, amount, business_date, version)
       values ('${randomUUID()}', '${B.company}', '${B.loc}', '${turno}', 'OPENING', 500, '${hoy}', 1),
              ('${randomUUID()}', '${B.company}', '${B.loc}', '${turno}', 'SALE', 450, '${hoy}', 1),
              ('${randomUUID()}', '${B.company}', '${B.loc}', '${turno}', 'WITHDRAW', -100, '${hoy}', 1);
       update devices set last_sync_at = now() where id = '${B.device}';`);
  const res = await llamar(A.token, 'grupo_resumen', { company_id: B.company, desde: hoy, hasta: hoy });
  check('GR-16', res.success && Number(res.ventas) === 450 && res.tickets === 2, 'ventas netas y tickets del día salen de los hechos', `${res.ventas}/${res.tickets}`);
  check('GR-17', res.turnos_abiertos === 1 && Number(res.efectivo_en_caja) === 850, 'turno abierto y efectivo del cajón (fondo + movimientos)', String(res.efectivo_en_caja));
  check('GR-18', !!res.ultima_sync && !!res.ultima_venta, 'dice cuándo sincronizó (para «Datos al…»)');
  const semana = await llamar(A.token, 'grupo_resumen', { company_id: B.company, desde: uno(`select (current_date - 6)::text;`), hasta: hoy });
  check('GR-19', Number(semana.ventas) === 1449 && semana.tickets === 3, 'el periodo se respeta', `${semana.ventas}`);
  const ajena = await llamar(D.token, 'grupo_resumen', { company_id: B.company });
  check('GR-20', ajena.status === 403 && ajena.code === 'NOT_IN_GROUP', 'una empresa ajena no consulta');
  const yoMisma = await llamar(A.token, 'grupo_resumen', { company_id: A.company });
  check('GR-21', yoMisma.code === 'NOT_IN_GROUP', 'ni la propia por esta vía (la propia se lee de su base)');

  const catalogo = { products: [
    { uuid: randomUUID(), nombre: 'Taco de birria', price: '35.00', sellable: true, active: true, category_uuid: null },
    { uuid: randomUUID(), nombre: 'Consomé', price: '40.00', sellable: true, active: true, category_uuid: null },
    { uuid: randomUUID(), nombre: 'Viejo', price: '1.00', sellable: true, active: false, category_uuid: null },
  ], categories: [] };
  const pub = await llamar(B.token, 'publish', { catalog: catalogo });
  check('GR-22', pub.success, 'B publica su catálogo como siempre');
  const cat = await llamar(A.token, 'grupo_catalogo', { company_id: B.company });
  check('GR-23', cat.success && cat.productos.length === 2 && cat.productos[0].nombre === 'Consomé' && cat.productos[1].precio === 35,
    'A lo ve: solo lo activo, ordenado, con precio numérico', JSON.stringify(cat.productos.map((p) => p.nombre)));
  check('GR-24', (await llamar(D.token, 'grupo_catalogo', { company_id: B.company })).code === 'NOT_IN_GROUP', 'una ajena no lo ve');

  console.log('\nGRUPOS · bandeja (Fase 3)\n');
  const taco = catalogo.products[0].uuid;
  const llave = randomUUID();
  const pedir = (token, extra = {}) => llamar(token, 'grupo_comando', { company_id: B.company, kind: 'PRODUCTO_PRECIO',
    payload: { product_uuid: taco, nombre: 'Taco de birria', precio: 38 }, client_key: llave, requested_by: 'david', ...extra });
  const c1 = await pedir(A.token);
  check('GR-25', c1.success && c1.status === 'PENDIENTE' && c1.repetido === false, 'A pide un cambio de precio a B');
  const c1b = await pedir(A.token);
  check('GR-26', c1b.success && c1b.id === c1.id && c1b.repetido === true, 'reintentar con la misma clave no duplica');
  check('GR-27', (await pedir(A.token, { client_key: randomUUID(), payload: { product_uuid: taco, precio: -1 } })).status === 400, 'un precio negativo no entra');
  check('GR-28', (await pedir(A.token, { client_key: randomUUID(), kind: 'BORRAR_TODO' })).status === 400, 'un tipo que no existe no entra');
  check('GR-29', (await pedir(A.token, { client_key: randomUUID(), company_id: D.company })).code === 'NOT_IN_GROUP', 'no se le pide nada a una ajena');
  const alta = await llamar(A.token, 'grupo_comando', { company_id: B.company, kind: 'PRODUCTO_ALTA',
    payload: { nombre: 'Quesabirria', precio: 55 }, client_key: randomUUID(), requested_by: 'david' });
  check('GR-30', alta.success, 'y un alta de producto');

  const bandeja = await llamar(B.token, 'grupo_bandeja');
  check('GR-31', bandeja.success && bandeja.comandos.length === 2 && bandeja.comandos[0].empresa === 'I Do Nut QA',
    'B recoge sus dos pedidos, con quién los pidió', `${bandeja.comandos.length}`);
  check('GR-32', (await llamar(B.token, 'grupo_bandeja')).comandos.length === 0, 'recién entregados no se repiten');
  uno(`update company_group_commands set delivered_at = now() - interval '11 minutes' where id = '${alta.id}';`);
  const re = await llamar(B.token, 'grupo_bandeja');
  check('GR-33', re.comandos.length === 1 && re.comandos[0].id === alta.id, 'el que no respondió en 10 min se vuelve a entregar');
  check('GR-34', (await llamar(C.token, 'grupo_comando_resultado', { id: c1.id, ok: true })).code === 'NOT_FOUND', 'solo el destino responde');
  check('GR-35', (await llamar(B.token, 'grupo_comando_resultado', { id: c1.id, ok: true, detail: 'Precio actualizado.' })).success, 'B responde que lo aplicó');
  check('GR-36', (await llamar(B.token, 'grupo_comando_resultado', { id: c1.id, ok: false })).code === 'NOT_FOUND', 'y ya no se puede cambiar la respuesta');
  const mios = await llamar(A.token, 'grupo_comandos');
  const visto = mios.comandos.find((x) => x.id === c1.id);
  check('GR-37', visto?.status === 'APLICADO' && visto.empresa === 'Birrialtlan QA' && visto.detail === 'Precio actualizado.', 'A ve el resultado');
  check('GR-38', mios.comandos.find((x) => x.id === alta.id)?.status === 'ENTREGADO', 'y lo que sigue en camino');

  const deC = await llamar(C.token, 'grupo_comando', { company_id: B.company, kind: 'PRODUCTO_ALTA', payload: { nombre: 'De la tercera', precio: 10 }, client_key: randomUUID() });
  check('GR-39', (await llamar(C.token, 'grupo_salir')).success, 'C sale del grupo');
  const cancelado = uno(`select status from company_group_commands where id = '${deC.id}';`);
  check('GR-40', cancelado === 'RECHAZADO', 'lo que tenía pendiente se cancela', cancelado);
  check('GR-41', !(await llamar(A.token, 'grupo_listar')).empresas.some((e) => e.nombre === 'Tercera QA'), 'y deja de verse');

  const sec = uno(`select id from devices where kind = 'POS_SECONDARY' and status = 'ACTIVE' limit 1;`);
  if (sec) {
    const tok = 'tok-' + randomUUID().replace(/-/g, '');
    uno(`update devices set credential_hash = wx_hash('${tok}') where id = '${sec}';`);
    const s = await Promise.all(['grupo_codigo', 'grupo_listar', 'grupo_bandeja'].map((a) => llamar(tok, a)));
    check('GR-42', s.every((x) => x.status === 403 && x.code === 'NOT_PRIMARY'), 'una caja secundaria no puede nada de esto');
  }
} catch (e) {
  check('GR-XX', false, 'la prueba se interrumpió', e.message);
} finally {
  if (!conservar) docker(['rm', '-f', NOMBRE]);
}
console.log(`\n${pasos - fallos}/${pasos} comprobaciones · ${((Date.now() - t0) / 1000).toFixed(1)} s${fallos ? ` · ${fallos} FALLAS` : ''}\n`);
process.exit(fallos ? 1 : 0);
