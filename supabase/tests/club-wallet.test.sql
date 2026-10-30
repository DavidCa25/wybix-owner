-- ============================================================================
--  CLUB EN WALLET · se corre DESPUÉS de club.test.sql, en la misma sesión de
--  probar-fase3 (usa a Mariana, sus puntos, su tarjeta y su membresía).
-- ============================================================================
create temp table w (k text primary key, v jsonb);
create or replace function pg_temp.wv(k text) returns jsonb language sql as $$ select v from w where w.k = $1 $$;

-- Permisos: nada para anon/authenticated; todo para service_role.
select pg_temp.chk('WAL01', not has_table_privilege('anon', 'public.club_wallet_pases', 'SELECT')
  and not has_table_privilege('authenticated', 'public.club_wallet_dispositivos', 'INSERT')
  and not has_function_privilege('anon', 'public.club_wallet_estado(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.club_wallet_emitir(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.club_pull(jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.club_wallet_marcar(jsonb)', 'EXECUTE'), 'tablas y funciones cerradas salvo service_role');

-- Emitir: un pase por teléfono; el segundo intento devuelve el mismo serial.
insert into w select 'e1', club_wallet_emitir(jsonb_build_object('device_id', pg_temp.dev('Centro'), 'serial', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'phone', '(477) 312-4588', 'customer_name', 'Mariana López'));
insert into w select 'e2', club_wallet_emitir(jsonb_build_object('device_id', pg_temp.dev('Norte'), 'serial', 'bbbbbbbbbbbbbbbbbbbbbbbb', 'phone', '+52 477 312 4588'));
select pg_temp.chk('WAL02', (pg_temp.wv('e1')->>'serial') = 'aaaaaaaaaaaaaaaaaaaaaaaa' and (pg_temp.wv('e1')->>'nuevo')::boolean
  and (pg_temp.wv('e2')->>'serial') = 'aaaaaaaaaaaaaaaaaaaaaaaa' and not (pg_temp.wv('e2')->>'nuevo')::boolean, 'un pase por empresa y teléfono, desde cualquier sucursal');
select pg_temp.chk('WAL03', (club_wallet_emitir(jsonb_build_object('device_id', gen_random_uuid(), 'serial', 'cccccccccccccccccccccccc', 'phone', '4771112233')))->>'code' = 'DENIED'
  and (club_wallet_emitir(jsonb_build_object('device_id', pg_temp.dev('Centro'), 'serial', 'cccccccccccccccccccccccc', 'phone', '123')))->>'code' = 'BAD_REQUEST', 'equipo desconocido o teléfono corto: no');

-- Estado: puntos y sellos de todas las sucursales, membresía y nombre del negocio.
insert into w select 'st', club_wallet_estado('{"serial":"aaaaaaaaaaaaaaaaaaaaaaaa"}');
select pg_temp.chk('WAL04', (pg_temp.wv('st')->'puntos'->>'activo')::boolean and (pg_temp.wv('st')->'puntos'->>'saldo')::int =
    (select sum(delta) from club_ledger where phone = '4773124588' and program = 'POINTS'), 'saldo = suma de movimientos del teléfono');
select pg_temp.chk('WAL05', exists (select 1 from jsonb_array_elements(pg_temp.wv('st')->'sellos') s where s->>'nombre' = 'Café 9+1' and (s->>'llevas')::int = 1 and (s->>'requeridos')::int = 9),
  'tarjeta de sellos con lo que lleva');
select pg_temp.chk('WAL06', pg_temp.wv('st')->'membresias'->0->>'estado' = 'ACTIVA' and pg_temp.wv('st')->'membresias'->0->>'plan' = 'Club Café'
  and pg_temp.wv('st')->>'negocio' = (select nombre from negocios where id = (select company_id from devices where id = pg_temp.dev('Centro'))), 'membresía vigente y negocio');

-- Resolver: solo la propia empresa.
select pg_temp.chk('WAL07', (club_wallet_resolver(jsonb_build_object('device_id', pg_temp.dev('Norte'), 'serial', 'aaaaaaaaaaaaaaaaaaaaaaaa')))->>'phone' = '4773124588'
  and (club_wallet_resolver(jsonb_build_object('device_id', (select d.id from devices d where d.status = 'ACTIVE' and d.kind = 'POS_PRIMARY'
         and d.company_id <> (select company_id from devices where id = pg_temp.dev('Centro')) limit 1), 'serial', 'aaaaaaaaaaaaaaaaaaaaaaaa')))->>'ok' is distinct from 'true',
  'Norte reconoce el pase; otra empresa no');

-- Ciclo: limpiar, y un movimiento nuevo vuelve a ensuciar SOLO ese pase.
insert into w select 'pend', club_wallet_pendientes('{}');
select pg_temp.chk('WAL08', exists (select 1 from jsonb_array_elements(pg_temp.wv('pend')->'pases') x where x->>'serial' = 'aaaaaaaaaaaaaaaaaaaaaaaa'), 'el pase nuevo está pendiente');
insert into w select 'm1', club_wallet_marcar(jsonb_build_object('serial', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'huella', 'h1',
  'visto', (select x->>'visto' from jsonb_array_elements(pg_temp.wv('pend')->'pases') x where x->>'serial' = 'aaaaaaaaaaaaaaaaaaaaaaaa')));
select pg_temp.chk('WAL09', (pg_temp.wv('m1')->>'cambio')::boolean and (select sucio_en is null from club_wallet_pases where serial = 'aaaaaaaaaaaaaaaaaaaaaaaa'), 'marcar limpia y fecha el pase');
select pg_temp.chk('WAL10', not (club_wallet_marcar('{"serial":"aaaaaaaaaaaaaaaaaaaaaaaa","huella":"h1"}')->>'cambio')::boolean, 'misma huella: sin cambio');
insert into r values ('m3', to_jsonb(gen_random_uuid()));
insert into w select 'sub', pg_temp.subir(pg_temp.dev('Norte'), jsonb_build_array(
  pg_temp.ev('LOYALTY_LEDGER', pg_temp.u('m3'), 1, jsonb_build_object('customer_name', 'Mariana López', 'phone', '477-312-4588', 'program', 'POINTS', 'delta', 7, 'kind', 'EARN', 'created_local', '2026-10-28T09:00:00'))));
select pg_temp.chk('WAL11', (select sucio_en is not null from club_wallet_pases where serial = 'aaaaaaaaaaaaaaaaaaaaaaaa')
  and (club_wallet_estado('{"serial":"aaaaaaaaaaaaaaaaaaaaaaaa"}')->'puntos'->>'saldo')::int = (pg_temp.wv('st')->'puntos'->>'saldo')::int + 7,
  'puntos ganados en Norte ensucian el pase y suben el saldo');
-- Carrera: si se ensucia DESPUÉS de lo que vio el ciclo, marcar no lo limpia.
insert into w select 'm2', club_wallet_marcar(jsonb_build_object('serial', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'huella', 'h2', 'visto', (now() - interval '1 hour')::text));
select pg_temp.chk('WAL12', pg_temp.wv('m2')->>'ok' = 'true' and (select sucio_en is not null from club_wallet_pases where serial = 'aaaaaaaaaaaaaaaaaaaaaaaa'),
  'un cambio posterior a lo visto sigue pendiente');

-- PassKit: registro, lista por fecha, baja por token.
select pg_temp.chk('WAL13', (club_wallet_registrar('{"device_library_id":"dev1","serial":"aaaaaaaaaaaaaaaaaaaaaaaa","push_token":"t1"}')->>'nuevo')::boolean
  and not (club_wallet_registrar('{"device_library_id":"dev1","serial":"aaaaaaaaaaaaaaaaaaaaaaaa","push_token":"t2"}')->>'nuevo')::boolean
  and (club_wallet_registrar('{"device_library_id":"dev1","serial":"ffffffffffffffffffffffff","push_token":"t1"}')->>'ok') = 'false', 'registro idempotente; pase inexistente no');
insert into w select 'ser', club_wallet_seriales('{"device_library_id":"dev1"}');
select pg_temp.chk('WAL14', pg_temp.wv('ser')->'serials' = '["aaaaaaaaaaaaaaaaaaaaaaaa"]'::jsonb
  and jsonb_array_length(club_wallet_seriales(jsonb_build_object('device_library_id', 'dev1', 'desde', pg_temp.wv('ser')->>'ultimo'))->'serials') = 0,
  'passesUpdatedSince: con la última etiqueta ya no hay nada');
select pg_temp.chk('WAL15', exists (select 1 from jsonb_array_elements(club_wallet_pendientes('{}')->'pases') x where x->'tokens' = '["t2"]'::jsonb)
  and (club_wallet_baja_token('{"push_token":"t2"}')->>'bajas')::int = 1, 'el ciclo ve el token y APNs 410 lo da de baja');

-- La caja sube su marca: todos los pases de la empresa se ensucian.
update club_wallet_pases set sucio_en = null;
insert into w select 'marca', club_wallet_marca(jsonb_build_object('device_id', pg_temp.dev('Centro'), 'fondo', '#d0466c', 'texto', '#ffffff', 'etiqueta', '#ffe3ea'));
select pg_temp.chk('WAL16', pg_temp.wv('marca')->>'ok' = 'true'
  and (club_wallet_estado('{"serial":"aaaaaaaaaaaaaaaaaaaaaaaa"}')->'marca'->>'fondo') = '#d0466c'
  and (select sucio_en is not null from club_wallet_pases where serial = 'aaaaaaaaaaaaaaaaaaaaaaaa'), 'marca guardada y pases pendientes');

-- club_pull lleva los pases a todas las cajas de la empresa.
select pg_temp.chk('WAL17', exists (select 1 from jsonb_array_elements(club_pull(jsonb_build_object('device_id', pg_temp.dev('Norte'), 'desde', (now() - interval '1 day')::text))->'wallet_passes') x
  where x->>'serial' = 'aaaaaaaaaaaaaaaaaaaaaaaa' and x->>'phone' = '4773124588'), 'club_pull trae serial y teléfono');
