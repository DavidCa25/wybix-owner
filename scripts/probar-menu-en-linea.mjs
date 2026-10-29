/**
 * MENÚ EN LÍNEA EN LA NUBE (POS 0067), SIN TOCAR PRODUCCIÓN.
 *
 *     node --no-warnings scripts/probar-menu-en-linea.mjs [--conservar]
 *
 * Sobre el contenedor de scripts/probar-fase3.mjs (toda la cadena de
 * migraciones con datos de forma de producción; se crea si no existe):
 *
 *   1. la migración 20261028130000 se aplica dos veces y nadie más que
 *      service_role ve sus tablas y funciones;
 *   2. por las Edge Functions REALES (_shared/pos-sync.ts y
 *      _shared/menu-publico.ts) por HTTP simulado: la caja publica el menú y
 *      sus fotos, el celular lo lee, pide, la caja lo baja, confirma, sube
 *      estados y el celular los ve; precio recalculado, modificadores,
 *      disponibilidad, anti-abuso, idempotencia, caja sin latido, slug ajeno,
 *      una caja que no es la principal.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { manejarPosSync } from '../supabase/functions/_shared/pos-sync.ts';
import { manejarMenuPublico } from '../supabase/functions/_shared/menu-publico.ts';
import { rpcPostgrest } from '../supabase/functions/_shared/nube.ts';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOMBRE = 'wybix-menu-prueba';
const MIG = join(RAIZ, 'supabase', 'migrations', '20261028130000_menu_en_linea.sql');
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
/* PostgREST simulado: lo mismo que rpcPostgrest, contra psql. */
const fetchSimulado = async (url, init) => {
  const fn = String(url).split('/rpc/')[1];
  const out = await rpcPsql(fn, JSON.parse(init.body).p);
  return { ok: true, status: 200, json: async () => out };
};
const rpc = rpcPostgrest('http://sb', 'service', fetchSimulado);
const sha = async (t) => createHash('sha256').update(t).digest('hex');
const depsMenu = { rpc, hash: sha, sal: 'sal-prueba' };
const depsSync = { rpc, espejo: { escribir: async () => null, existeAlerta: async () => false }, borrarUsuario: async () => {} };

const caja = async (token, action, cuerpo = {}) => {
  const r = await manejarPosSync(new Request('http://x/pos-sync', { method: 'POST', headers: { 'x-wybix-device': token, 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...cuerpo }) }), depsSync);
  return { status: r.status, ...(await r.json()) };
};
const celular = async (metodo, query, cuerpo, ip = '201.10.10.10') => {
  const r = await manejarMenuPublico(new Request(`http://x/menu-publico${query}`, {
    method: metodo, headers: { 'content-type': 'application/json', 'x-forwarded-for': `${ip}, 10.0.0.1` },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined }), depsMenu);
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, cache: r.headers.get('cache-control'), tipo: ct, ...(ct.startsWith('application/json') ? await r.json() : { bytes: (await r.arrayBuffer()).byteLength }) };
};

const t0 = Date.now();
try {
  if (docker(['exec', NOMBRE, 'pg_isready', '-U', 'postgres']).code !== 0) {
    console.log('\n(no está el contenedor de la Fase 3: se crea con probar-fase3.mjs --conservar)');
    const f3 = spawnSync(process.execPath, ['--no-warnings', join(RAIZ, 'scripts', 'probar-fase3.mjs'), '--conservar'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, WYBIX_PRUEBA_CONTENEDOR: NOMBRE } });
    const resumen = (f3.stdout || '').trim().split(/\r?\n/).filter((l) => /comprobaciones|FALLA/.test(l)).slice(-6).join(' | ');
    check('MENU-00', docker(['exec', NOMBRE, 'pg_isready', '-U', 'postgres']).code === 0, 'cadena completa de migraciones (Fase 3)', resumen);
  }
  console.log('\nMENÚ EN LÍNEA · migración\n');
  for (const vez of [1, 2]) { const a = psql(readFileSync(MIG, 'utf8')); check(`MENU-MIG${vez}`, a.code === 0, `20261028130000 (vez ${vez})`, a.err.replace(/^(NOTICE|WARNING).*$/gm, '').trim().slice(0, 300)); }
  const priv = uno(`select count(*) from information_schema.role_table_grants where table_name in ('menu_publicaciones','menu_imagenes','menu_pedidos') and grantee in ('anon','authenticated','PUBLIC');`);
  check('MENU-01', priv === '0', 'anon/authenticated no tienen ningún permiso sobre las tablas', `${priv} grants`);
  const fpriv = uno(`select count(*) from pg_proc p where p.proname like 'menu_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));`);
  check('MENU-02', fpriv === '0', 'ni pueden ejecutar sus funciones', `${fpriv} con execute`);

  /* Dos cajas principales de sucursales distintas, con credencial conocida. */
  const filas = uno(`select string_agg(id::text || ':' || location_id::text, ',') from (select distinct on (location_id) id, location_id from devices
                      where kind = 'POS_PRIMARY' and status = 'ACTIVE' order by location_id, id limit 2) x;`).split(',');
  const [A, B] = filas.map((f) => ({ id: f.split(':')[0], loc: f.split(':')[1], token: 'tok-' + randomUUID().replace(/-/g, '') }));
  for (const c of [A, B]) uno(`update devices set credential_hash = wx_hash('${c.token}') where id = '${c.id}'; delete from menu_publicaciones where location_id = '${c.loc}';
    delete from menu_imagenes where location_id = '${c.loc}'; delete from menu_pedidos where location_id = '${c.loc}';`);
  const sec = uno(`select id from devices where kind = 'POS_SECONDARY' and status = 'ACTIVE' limit 1;`);
  const tokSec = 'tok-' + randomUUID().replace(/-/g, '');
  if (sec) uno(`update devices set credential_hash = wx_hash('${tokSec}') where id = '${sec}';`);
  const slug = 'cafe-' + randomUUID().slice(0, 6);

  console.log('\nMENÚ EN LÍNEA · la caja publica\n');
  const catalogo = {
    categorias: [{ id: 1, nombre: 'Cafés' }, { id: 2, nombre: 'Donas' }],
    productos: [
      { id: 10, nombre: 'Latte', precio: 55, categoria_id: 1, imagen: 3, disponible: null, grupos: [100, 101] },
      { id: 11, nombre: 'Dona glaseada', precio: 25, categoria_id: 2, imagen: null, disponible: 4, grupos: [] },
      { id: 12, nombre: 'Rol de canela', precio: 40, categoria_id: 2, imagen: null, disponible: 0, grupos: [] },
    ],
    grupos: [
      { id: 100, nombre: 'Tamaño', rol: 'SIZE', min: 1, max: 1, requerido: true, opciones: [{ id: 1000, nombre: 'Chico', delta: 0, disponible: null }, { id: 1001, nombre: 'Grande', delta: 10, disponible: null }] },
      { id: 101, nombre: 'Extras', rol: 'ADDON', min: 0, max: 2, requerido: false, opciones: [{ id: 1010, nombre: 'Shot extra', delta: 12, disponible: null }, { id: 1011, nombre: 'Leche de almendra', delta: 8, disponible: 0 }] },
    ],
  };
  const marca = { color: '#e4007c', acento: '#ffd23f', logo: null };
  const pubA = await caja(A.token, 'menu_publicar', { activo: true, slug, recibe_pedidos: true, minutos_estimados: 12, negocio: 'Café QA', marca, catalogo });
  check('MENU-03', pubA.success && pubA.url === `/m/${slug}` && JSON.stringify(pubA.faltan_imagenes) === '[10]', 'publica el menú y pide la foto del latte', JSON.stringify(pubA.faltan_imagenes));
  const pubB = await caja(B.token, 'menu_publicar', { activo: true, slug, catalogo });
  check('MENU-04', pubB.status === 403 && pubB.code === 'SLUG_TAKEN', 'otra sucursal no puede tomar la misma dirección');
  if (sec) {
    const s2 = await caja(tokSec, 'menu_publicar', { activo: true, slug: 'otra-' + slug, catalogo });
    check('MENU-05', !s2.success && s2.code === 'NOT_PRIMARY', 'una caja secundaria no publica');
  }
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, 7)]).toString('base64');
  const fo = await caja(A.token, 'menu_imagen', { product_id: 10, version: 3, mime: 'image/jpeg', data: jpg });
  check('MENU-06', fo.success, 'sube la foto');
  const fo2 = await caja(A.token, 'menu_imagen', { product_id: 10, version: 3, mime: 'text/html', data: jpg });
  check('MENU-07', !fo2.success, 'una "foto" que no es imagen no entra');
  const pubA2 = await caja(A.token, 'menu_publicar', { activo: true, slug, recibe_pedidos: true, minutos_estimados: 12, negocio: 'Café QA', marca, catalogo });
  check('MENU-08', pubA2.success && pubA2.faltan_imagenes.length === 0, 'al volver a publicar ya no falta la foto');

  console.log('\nMENÚ EN LÍNEA · el celular\n');
  const menu = await celular('GET', `?slug=${slug}`);
  check('MENU-09', menu.success && menu.abierto === true && menu.catalogo.productos.length === 3 && menu.marca.color === '#e4007c' && menu.negocio === 'Café QA',
    'lee el menú, la marca y que está abierto', `cache ${menu.cache}`);
  check('MENU-10', !JSON.stringify(menu).includes(A.loc) && !JSON.stringify(menu).includes('company'), 'sin ids internos de empresa o sucursal');
  const foto = await celular('GET', `?slug=${slug}&img=10&v=3`);
  check('MENU-11', foto.status === 200 && foto.tipo === 'image/jpeg' && foto.bytes === 2003 && /immutable/.test(foto.cache), 'sirve la foto con caché larga');
  check('MENU-12', (await celular('GET', '?slug=no-existe-zz')).status === 404, 'un slug que no existe: 404');

  const pedir = (extra = {}, ip) => celular('POST', '', {
    slug, cliente_nombre: 'Ana  Ruiz', cliente_telefono: '477 123 4567', origen: 'mesa', nota: 'para llevar', idem: randomUUID(),
    lineas: [{ product_id: 10, cantidad: 2, opciones: [1001, 1010], nota: 'muy caliente' }, { product_id: 11, cantidad: 1, opciones: [] }],
    ...extra }, ip);
  const p1 = await pedir({ precio: 1, total: 1 });
  check('MENU-13', p1.status === 201 && /^[0-9a-f]{32}$/.test(p1.token) && Number(p1.total) === 179, 'pide; el total sale del catálogo, no del celular', `total ${p1.total} (2×(55+10+12)+25)`);
  const idem = randomUUID();
  const d1 = await pedir({ idem }, '201.10.10.11'), d2 = await pedir({ idem }, '201.10.10.11');
  check('MENU-14', d1.token === d2.token && d2.repetido, 'doble toque: el mismo pedido');
  const malos = [
    [{ lineas: [{ product_id: 10, cantidad: 1, opciones: [] }] }, 'BAD_OPTIONS', 'sin el tamaño requerido'],
    [{ lineas: [{ product_id: 10, cantidad: 1, opciones: [1000, 1001] }] }, 'BAD_OPTIONS', 'dos tamaños'],
    [{ lineas: [{ product_id: 11, cantidad: 1, opciones: [1001] }] }, 'BAD_OPTIONS', 'una opción de otro producto'],
    [{ lineas: [{ product_id: 10, cantidad: 1, opciones: [1000, 1011] }] }, 'UNAVAILABLE', 'una opción agotada'],
    [{ lineas: [{ product_id: 12, cantidad: 1, opciones: [] }] }, 'UNAVAILABLE', 'un producto agotado'],
    [{ lineas: [{ product_id: 11, cantidad: 5, opciones: [] }] }, 'UNAVAILABLE', 'más de lo disponible'],
    [{ lineas: [{ product_id: 99, cantidad: 1, opciones: [] }] }, 'UNAVAILABLE', 'un producto que no está en el menú'],
    [{ lineas: [{ product_id: 11, cantidad: 0, opciones: [] }] }, 'BAD_REQUEST', 'cantidad cero'],
    [{ lineas: [] }, 'BAD_REQUEST', 'sin productos'],
    [{ cliente_nombre: 'A' }, 'BAD_NAME', 'sin nombre'],
    [{ cliente_telefono: '12345' }, 'BAD_PHONE', 'teléfono corto'],
  ];
  let i = 20;
  for (const [extra, code, que] of malos) {
    const r = await pedir(extra, `201.20.0.${i++}`);
    check(`MENU-${i}`, !r.success && r.code === code, `rechaza ${que}`, r.code);
  }

  console.log('\nMENÚ EN LÍNEA · anti-abuso\n');
  const ipAbuso = '201.99.99.99';
  const res = [];
  for (let k = 0; k < 21; k++) res.push(await pedir({ cliente_telefono: `47700000${String(k).padStart(2, '0')}` }, ipAbuso));
  check('MENU-40', res.slice(0, 20).every((r) => r.success) && res[20].status === 429 && res[20].code === 'RATE_LIMIT',
    'la misma IP (el Wi-Fi del local): 20 pedidos en 10 minutos pasan y el 21º se frena');
  const t1 = await pedir({ cliente_telefono: '4779990000' }, '201.50.0.1'), t2 = await pedir({ cliente_telefono: '4779990000' }, '201.50.0.2'), t3 = await pedir({ cliente_telefono: '4779990000' }, '201.50.0.3');
  check('MENU-41', t1.success && t2.success && t3.code === 'RATE_LIMIT', 'el mismo teléfono: 2 en espera y el 3º se frena');
  const ipGuardada = uno(`select count(*) from menu_pedidos where ip_hash like '201.%' or ip_hash is null;`);
  check('MENU-42', ipGuardada === '0', 'la IP nunca se guarda, solo su hash');
  const grande = await celular('POST', '', { slug, x: 'a'.repeat(20000) });
  check('MENU-43', grande.status === 413, 'un cuerpo enorme se rechaza antes de llegar a la base');

  console.log('\nMENÚ EN LÍNEA · la caja baja y responde\n');
  const est0 = await celular('GET', `?pedido=${p1.token}`);
  check('MENU-50', est0.estado === 'RECIBIDO' && est0.nombre === 'Ana' && !JSON.stringify(est0).includes('4771234567'), 'el celular ve RECIBIDO, su primer nombre y nunca el teléfono');
  const b1 = await caja(A.token, 'menu_bandeja', { estados: [], confirmar: [] });
  const mio = (b1.pedidos || []).find((x) => x.lineas?.[0]?.nota === 'muy caliente' && x.cliente_telefono === '4771234567');
  check('MENU-51', b1.success && b1.abierto && mio && mio.lineas.length === 2 && mio.lineas[0].opciones.length === 2 && mio.lineas[0].uuid && mio.origen === 'MESA',
    'la bandeja trae el pedido con uuid por línea y sus opciones', `${(b1.pedidos || []).length} pedidos`);
  check('MENU-52', mio && mio.cliente_nombre === 'Ana Ruiz' && mio.cliente_telefono === '4771234567', 'nombre y teléfono normalizados');
  const b2 = await caja(A.token, 'menu_bandeja', { estados: [], confirmar: [] });
  check('MENU-53', (b2.pedidos || []).some((x) => x.id === mio.id), 'sin confirmar, vuelve a llegar (la caja no lo pierde)');
  const b3 = await caja(A.token, 'menu_bandeja', { estados: [], confirmar: (b2.pedidos || []).map((x) => x.id) });
  check('MENU-54', b3.success && !(b3.pedidos || []).some((x) => x.id === mio.id), 'confirmado, ya no se reenvía');
  const bB = await caja(B.token, 'menu_bandeja', { estados: [{ id: mio.id, estado: 'RECHAZADO', motivo: 'x' }] });
  check('MENU-55', bB.success && bB.estados_aplicados.length === 0 && (bB.pedidos || []).length === 0, 'otra sucursal no ve ni toca los pedidos ajenos');
  for (const [estado, numero] of [['PREPARANDO', 7], ['LISTO', 7]]) {
    const r = await caja(A.token, 'menu_bandeja', { estados: [{ id: mio.id, estado, numero_dia: numero }] });
    const e = await celular('GET', `?pedido=${p1.token}`);
    check(`MENU-56-${estado}`, r.estados_aplicados.includes(mio.id) && e.estado === estado && e.numero === 7, `el celular ve ${estado} con el número del día`);
  }
  const rech = (b2.pedidos || []).find((x) => x.id !== mio.id);
  await caja(A.token, 'menu_bandeja', { estados: [{ id: rech.id, estado: 'RECHAZADO', motivo: 'Se acabaron las donas' }] });
  const tokRech = uno(`select token from menu_pedidos where id = '${rech.id}';`);
  const eR = await celular('GET', `?pedido=${tokRech}`);
  check('MENU-57', eR.estado === 'RECHAZADO' && eR.motivo === 'Se acabaron las donas', 'un rechazo llega con su motivo');

  console.log('\nMENÚ EN LÍNEA · caja sin internet\n');
  const sinBajar = await pedir({ cliente_telefono: '4778887777' }, '201.70.0.1');
  uno(`update menu_publicaciones set latido_en = now() - interval '5 minutes' where location_id = '${A.loc}';`);
  const cerrado = await celular('GET', `?slug=${slug}`);
  const pc = await pedir({}, '201.60.0.1');
  check('MENU-60', cerrado.abierto === false && pc.code === 'CLOSED', 'sin latido de la caja: el menú se ve, pero no recibe pedidos');
  uno(`update menu_pedidos set creado_en = now() - interval '40 minutes' where location_id = '${A.loc}' and confirmado_en is null;`);
  const vieja = sinBajar.token;
  const bv = await caja(A.token, 'menu_bandeja', { estados: [] });
  const ev = await celular('GET', `?pedido=${vieja}`);
  check('MENU-61', sinBajar.success && (bv.pedidos || []).length === 0 && ev.estado === 'SIN_RESPUESTA', 'lo que la caja no bajó en 30 min ya no le llega y el cliente ve SIN_RESPUESTA');
  check('MENU-62', bv.abierto === true, 'el latido de la bandeja reabre el menú');
  const apagar = await caja(A.token, 'menu_publicar', { activo: false, slug, catalogo: null });
  check('MENU-63', apagar.success && (await celular('GET', `?slug=${slug}`)).status === 404, 'despublicar: la página ya no existe');
  check('MENU-64', (await celular('GET', `?pedido=${p1.token}`)).estado === 'LISTO', 'pero el seguimiento de un pedido hecho sigue');
} catch (e) {
  check('MENU-Z', false, 'la prueba se interrumpió', e.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  if (!process.argv.includes('--conservar')) docker(['rm', '-f', NOMBRE]);
}
console.log(`\n${pasos - fallos}/${pasos} comprobaciones correctas${fallos ? ` · ${fallos} FALLAS` : ''} · ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(fallos ? 1 : 0);
