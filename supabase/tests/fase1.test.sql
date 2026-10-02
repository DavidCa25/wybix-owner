-- ============================================================================
--  PRUEBAS DE LA FASE 1 EN LA NUBE (Postgres 17 desechable)
--  auth-emulado.sql + migraciones previas + fase1-datos-legado.sql + la
--  migración de la Fase 1 (dos veces). Las corre scripts/probar-fase1.mjs.
--
--    MIG  la migración conserva lo que había y no inventa dueños
--    ENR  enrolamiento: empresa -> ubicación -> equipo
--    EMP  multiempresa y RLS: A no lee ni toca a B
--    SYN  hechos idempotentes
--    FIS  CFDI: identidad -> empresa -> emisor -> factura
--    IDN  I Do Nut: una empresa, Centro y Norte
--    PRV  privilegios: nada sensible al alcance de anon/authenticated
--
--  Cada comprobación deja una fila en t_res; la corrida falla si alguna es false.
-- ============================================================================
create table if not exists t_res (n serial, id text, ok boolean, msg text, det text);
grant all on t_res to public;
grant usage on sequence t_res_n_seq to public;
create or replace function t_check(p_id text, p_ok boolean, p_msg text, p_det text default null) returns void
language sql as $$ insert into t_res (id, ok, msg, det) values (p_id, coalesce(p_ok, false), p_msg, p_det) $$;

create table if not exists t_ctx (k text primary key, v jsonb);
create or replace function t_set(p_k text, p_v jsonb) returns jsonb language sql as $$
  insert into t_ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v returning v $$;
create or replace function t_get(p_k text) returns jsonb language sql as $$ select v from t_ctx where k = p_k $$;
create or replace function t_s(p_k text, p_campo text) returns text language sql as $$ select v->>p_campo from t_ctx where k = p_k $$;

-- Ejecuta p_sql como p_rol con la identidad p_user y devuelve el primer valor
-- (o ERR:<sqlstate>). Es exactamente lo que vería la app con ese JWT.
create or replace function t_q(p_user uuid, p_sql text, p_rol text default 'authenticated') returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', case when p_user is null then '' else json_build_object('sub', p_user, 'role', p_rol)::text end, true);
  execute format('set local role %I', p_rol);
  begin
    execute p_sql into r;
  exception when others then
    execute 'reset role';
    return 'ERR:' || sqlstate;
  end;
  execute 'reset role';
  return r;
end $$;

create or replace function t_ev(p_type text, p_agg text, p_agg_uuid uuid, p_ver bigint, p_payload jsonb, p_event uuid default gen_random_uuid())
returns jsonb language sql as $$
  select jsonb_build_object('event_uuid', p_event, 'event_type', p_type, 'aggregate_type', p_agg, 'aggregate_uuid', p_agg_uuid,
                            'aggregate_version', p_ver, 'occurred_at', now(), 'payload_version', 1, 'payload', p_payload)
$$;

-- ============================================================== MIG · migración
select t_check('MIG01', (select count(*) from negocios) = 7 and (select count(*) from sucursales) = 7,
  'no se fusiona ni se borra ninguna empresa/ubicación existente (7/7)');
select t_check('MIG02', (select count(*) from company_memberships where role = 'OWNER' and origin = 'MIGRATED_OWNER_ID') = 1,
  'el dueño ligado por owner_id queda como membresía OWNER');
select t_check('MIG03', exists (select 1 from reconciliation_items where kind = 'OWNER_APP_UNVERIFIED')
                  and not exists (select 1 from company_memberships where user_id = '10000000-0000-0000-0000-00000000000b'),
  'la app ligada solo con el id del negocio NO recibe acceso: queda para conciliar');
select t_check('MIG04', (select count(*) from devices where legacy_token and status = 'ACTIVE') = 3,
  'los 3 tokens de sucursal se vuelven equipos (credencial igual, sin reemitir)');
select t_check('MIG05', (device_autenticar('{"token":"token-legado-uno-0123456789abcdef"}')->>'ok')::boolean,
  'el token anterior sigue autenticando (POS sin actualizar no se rompen)');
select t_check('MIG06', (select company_id from licenses where id = '40000000-0000-0000-0000-000000000001') = '20000000-0000-0000-0000-000000000001',
  'licencia con evidencia única -> su empresa');
select t_check('MIG07', (select company_id from licenses where id = '40000000-0000-0000-0000-000000000002') is null
                  and exists (select 1 from reconciliation_items where kind = 'LICENSE_UNLINKED' and ref = '40000000-0000-0000-0000-000000000002'),
  'licencia sin evidencia: NO se inventa empresa, queda pendiente');
select t_check('MIG08', (select count(*) from respaldo.fase1_politicas) = 5,
  'las políticas reemplazadas quedaron respaldadas', (select count(*) from respaldo.fase1_politicas)::text);
select t_check('MIG09', (select grants ? 'locations_max' and grants ? 'companies_max' and grants ? 'mobile_pos' from license_catalog where code = 'EDITION_MONO')
                  and (select (license_runtime(id) ? 'locations_max') = false from licenses limit 1),
  'derechos nuevos preparados en el catálogo; el certificado firmado (license_runtime) no cambia');
select t_check('MIG10', t_q('10000000-0000-0000-0000-00000000000a', 'select count(*) from sucursales') = '1'
                  and t_q('10000000-0000-0000-0000-00000000000a', 'select count(*) from cortes_caja') = '1',
  'el dueño anterior sigue viendo SU sucursal (y ahora también sus cortes)');
select t_check('MIG11', t_q('10000000-0000-0000-0000-00000000000b', 'select count(*) from resumen_ventas') = '0',
  'la app no verificada no ve nada');

-- ============================================================== ENR · enrolamiento
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-00000000000a', 'duena@idonut.mx'),
  ('b0000000-0000-0000-0000-00000000000b', 'dueno@otra.mx'),
  ('ab000000-0000-0000-0000-0000000000ab', 'socio@ambas.mx'),
  ('e0000000-0000-0000-0000-00000000000e', 'encargado@idonut.mx'),
  ('f0000000-0000-0000-0000-00000000000f', 'nadie@prueba.mx');

-- Centro: primera instalación.
select t_set('centro', pos_bootstrap('{"instance_uuid":"c0000000-0000-0000-0000-0000000000c1","device_uuid":"c0000000-0000-0000-0000-00000000d001","nombre_negocio":"I Do Nut","nombre_sucursal":"Centro","name":"CAJA-CENTRO-1"}'));
select t_check('ENR01', (t_s('centro', 'ok'))::boolean and (t_s('centro', 'created'))::boolean and t_s('centro', 'install_secret') like 'wxi_%',
  'Centro: la primera instalación crea empresa + ubicación BRANCH + equipo principal');
select t_set('n_empresas', to_jsonb((select count(*) from negocios)));

-- Segunda PC de Centro (MISMA base de SQL Server): intentar bootstrap NO crea nada.
select t_set('centro2_boot', pos_bootstrap('{"instance_uuid":"c0000000-0000-0000-0000-0000000000c1","device_uuid":"c0000000-0000-0000-0000-00000000d002","nombre_negocio":"I Do Nut"}'));
select t_check('ENR02', t_s('centro2_boot', 'code') = 'INSTANCE_KNOWN' and (select count(*) from negocios) = (t_get('n_empresas'))::int,
  'segunda PC de Centro: la instancia ya existe, NO se crea otra empresa');
-- Se une con la llave de instalación que vive en la base compartida.
select t_set('centro2', pos_enroll(jsonb_build_object('install_secret', t_s('centro', 'install_secret'),
  'instance_uuid', 'c0000000-0000-0000-0000-0000000000c1', 'device_uuid', 'c0000000-0000-0000-0000-00000000d002', 'kind', 'POS_SECONDARY', 'name', 'CAJA-CENTRO-2')));
select t_check('ENR03', t_s('centro2', 'company_id') = t_s('centro', 'company_id') and t_s('centro2', 'location_id') = t_s('centro', 'location_id')
                  and (select count(*) from negocios) = (t_get('n_empresas'))::int,
  'dos PCs de Centro = UNA empresa, UNA ubicación, dos equipos');
select t_check('ENR04', pos_enroll(jsonb_build_object('install_secret', t_s('centro', 'install_secret'),
  'instance_uuid', 'c0000000-0000-0000-0000-0000000000ff', 'device_uuid', gen_random_uuid(), 'kind', 'POS_SECONDARY'))->>'code' = 'DENIED',
  'la llave de instalación desde OTRA base: DENEGADO');
select t_check('ENR05', pos_enroll(jsonb_build_object('install_secret', 'wxi_inventada_0000000000000000000000',
  'instance_uuid', 'c0000000-0000-0000-0000-0000000000c1', 'device_uuid', gen_random_uuid(), 'kind', 'POS_SECONDARY'))->>'code' = 'DENIED',
  'llave de instalación falsa: DENEGADO');

-- La dueña se liga con el QR (invitación) que muestra la principal.
select t_set('inv_duena', membresia_crear_invitacion(jsonb_build_object('device_id', t_s('centro', 'device_id'))));
select t_set('acepta_duena', membresia_aceptar_invitacion(jsonb_build_object('code', t_s('inv_duena', 'code'), 'user_id', 'a0000000-0000-0000-0000-00000000000a')));
select t_check('ENR06', (t_s('acepta_duena', 'ok'))::boolean and t_s('acepta_duena', 'role') = 'OWNER',
  'la dueña acepta la invitación del POS: membresía OWNER');
select t_check('ENR07', membresia_aceptar_invitacion(jsonb_build_object('code', t_s('inv_duena', 'code'), 'user_id', 'f0000000-0000-0000-0000-00000000000f'))->>'code' = 'DENIED',
  'la invitación es de un solo uso');
select t_check('ENR08', membresia_crear_invitacion(jsonb_build_object('device_id', t_s('centro', 'device_id')))->>'code' = 'OWNER_EXISTS',
  'con dueña ya ligada, el POS no puede invitar a otro OWNER (ya no basta conocer el negocio)');
select t_check('ENR09', membresia_crear_invitacion(jsonb_build_object('device_id', t_s('centro2', 'device_id')))->>'code' = 'DENIED',
  'una caja secundaria no invita');

-- La dueña crea Norte desde su app (misma empresa) y Norte la reclama.
select t_set('norte_alta', pos_create_location(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a',
  'company_id', t_s('centro', 'company_id'), 'nombre', 'Norte', 'tipo', 'BRANCH')));
select t_check('ENR10', (t_s('norte_alta', 'ok'))::boolean and (select status from sucursales where id = (t_s('norte_alta', 'location_id'))::uuid) = 'PENDING',
  'la dueña crea la ubicación Norte (pendiente hasta que su POS la reclame)');
select t_set('norte', pos_enroll(jsonb_build_object('code', lower(t_s('norte_alta', 'code')), 'instance_uuid', 'c0000000-0000-0000-0000-0000000000a2',
  'device_uuid', 'c0000000-0000-0000-0000-00000000e001', 'kind', 'POS_PRIMARY', 'name', 'CAJA-NORTE-1')));
select t_check('ENR11', (t_s('norte', 'ok'))::boolean and t_s('norte', 'company_id') = t_s('centro', 'company_id')
                  and t_s('norte', 'location_id') = t_s('norte_alta', 'location_id')
                  and (select status from sucursales where id = (t_s('norte', 'location_id'))::uuid) = 'ACTIVE',
  'Norte (otra base de SQL Server) entra a la MISMA empresa que Centro');
select t_check('ENR12', pos_enroll(jsonb_build_object('code', t_s('norte_alta', 'code'), 'instance_uuid', 'c0000000-0000-0000-0000-0000000000a3',
  'device_uuid', gen_random_uuid(), 'kind', 'POS_PRIMARY'))->>'code' = 'DENIED',
  'el código de Norte no se puede reusar');
select t_check('ENR13', pos_create_location(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a',
  'company_id', t_s('centro', 'company_id'), 'nombre', 'Bodega', 'tipo', 'WAREHOUSE'))->>'code' = 'RESERVED_TYPE'
               and pos_create_location(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a',
  'company_id', t_s('centro', 'company_id'), 'nombre', 'Moto', 'tipo', 'MOBILE'))->>'code' = 'RESERVED_TYPE',
  'WAREHOUSE y MOBILE están reservados: no se pueden crear');
select t_set('feria', pos_create_location(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'nombre', 'Feria del Libro', 'tipo', 'EVENT',
  'home_location_id', t_s('centro', 'location_id'), 'starts_at', '2026-11-01', 'ends_at', '2026-11-10')));
select t_check('ENR14', (t_s('feria', 'ok'))::boolean and (select tipo from sucursales where id = (t_s('feria', 'location_id'))::uuid) = 'EVENT',
  'EVENT es el mismo concepto de ubicación (con fechas y sucursal base)');

-- Otra empresa (B) para las pruebas negativas.
select t_set('b', pos_bootstrap('{"instance_uuid":"b0000000-0000-0000-0000-0000000000b1","device_uuid":"b0000000-0000-0000-0000-00000000d001","nombre_negocio":"Otra Empresa"}'));
select t_set('acepta_b', membresia_aceptar_invitacion(jsonb_build_object('code',
  membresia_crear_invitacion(jsonb_build_object('device_id', t_s('b', 'device_id')))->>'code', 'user_id', 'b0000000-0000-0000-0000-00000000000b')));
select t_check('ENR15', pos_create_location(jsonb_build_object('device_id', t_s('b', 'device_id'), 'nombre', 'Intrusa', 'tipo', 'EVENT',
  'home_location_id', t_s('centro', 'location_id')))->>'code' = 'DENIED',
  'un equipo de B no puede colgar una ubicación de una sucursal de A');
select t_check('ENR16', pos_create_location(jsonb_build_object('user_id', 'b0000000-0000-0000-0000-00000000000b',
  'company_id', t_s('centro', 'company_id'), 'nombre', 'Intrusa'))->>'code' = 'DENIED',
  'el dueño de B no puede crear ubicaciones en A');
select t_check('ENR17', pos_create_enrollment(jsonb_build_object('device_id', t_s('b', 'device_id'), 'location_id', t_s('centro', 'location_id')))->>'code' = 'DENIED',
  'el equipo de B no puede emitir códigos para una ubicación de A');

-- Encargado de A: membresía VIEWER solo de Centro. Socio con A y B.
select membresia_aceptar_invitacion(jsonb_build_object('user_id', 'e0000000-0000-0000-0000-00000000000e', 'code',
  membresia_crear_invitacion(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a', 'company_id', t_s('centro', 'company_id'),
    'role', 'VIEWER', 'location_ids', jsonb_build_array(t_s('centro', 'location_id'))))->>'code'));
select membresia_aceptar_invitacion(jsonb_build_object('user_id', 'ab000000-0000-0000-0000-0000000000ab', 'code',
  membresia_crear_invitacion(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a', 'company_id', t_s('centro', 'company_id'), 'role', 'ADMIN'))->>'code'));
select membresia_aceptar_invitacion(jsonb_build_object('user_id', 'ab000000-0000-0000-0000-0000000000ab', 'code',
  membresia_crear_invitacion(jsonb_build_object('user_id', 'b0000000-0000-0000-0000-00000000000b', 'company_id', t_s('b', 'company_id'), 'role', 'VIEWER'))->>'code'));
select t_check('ENR18', pos_create_location(jsonb_build_object('user_id', 'e0000000-0000-0000-0000-00000000000e',
  'company_id', t_s('centro', 'company_id'), 'nombre', 'X'))->>'code' = 'DENIED',
  'un VIEWER no crea ubicaciones');
select t_check('ENR19', membresia_crear_invitacion(jsonb_build_object('user_id', 'ab000000-0000-0000-0000-0000000000ab',
  'company_id', t_s('centro', 'company_id'), 'role', 'OWNER'))->>'code' = 'DENIED',
  'un ADMIN no puede nombrar OWNER');

-- POS anterior que ya sincronizaba: se actualiza conservando SU empresa.
select t_set('legado', pos_bootstrap('{"instance_uuid":"d0000000-0000-0000-0000-0000000000d1","device_uuid":"d0000000-0000-0000-0000-00000000d001","legacy_token":"token-legado-uno-0123456789abcdef"}'));
select t_check('ENR20', (t_s('legado', 'ok'))::boolean and t_s('legado', 'company_id') = '20000000-0000-0000-0000-000000000001'
                  and t_s('legado', 'location_id') = '30000000-0000-0000-0000-000000000001' and not (t_s('legado', 'created'))::boolean,
  'POS anterior con token: se queda con SU empresa y ubicación (no crea otra)');
select t_check('ENR21', (device_autenticar('{"token":"token-legado-uno-0123456789abcdef"}')->>'code') = 'BAD_TOKEN'
                  and (device_autenticar(jsonb_build_object('token', t_s('legado', 'token')))->>'ok')::boolean,
  'al actualizar, el token anterior deja de valer y vale la credencial nueva del equipo');
select t_check('ENR22', pos_bootstrap('{"instance_uuid":"d0000000-0000-0000-0000-0000000000ff","device_uuid":"d0000000-0000-0000-0000-00000000d009","legacy_token":"token-legado-dos-0123456789abcdef"}')->>'ok' = 'true'
                  and pos_bootstrap('{"instance_uuid":"d0000000-0000-0000-0000-0000000000ee","device_uuid":"d0000000-0000-0000-0000-00000000d008","legacy_token":"token-legado-tres-0123456789abcde"}')->>'ok' = 'true',
  'los otros POS anteriores también se actualizan');
-- Simulación del bug viejo: una caja secundaria que se aprovisionó su propio
-- negocio, sobre la MISMA base que otra. No se fusiona sola: queda pendiente.
update sucursales set sync_token_hash = wx_hash('token-duplicado-0123456789abcdefgh') where id = '30000000-0000-0000-0000-000000000004';
select t_set('dup', pos_bootstrap('{"instance_uuid":"d0000000-0000-0000-0000-0000000000d1","device_uuid":"d0000000-0000-0000-0000-00000000d004","legacy_token":"token-duplicado-0123456789abcdefgh"}'));
select t_check('ENR23', t_s('dup', 'location_id') = '30000000-0000-0000-0000-000000000001'
                  and exists (select 1 from reconciliation_items where kind = 'LOCATION_DUPLICATE' and ref = '30000000-0000-0000-0000-000000000004'),
  'duplicado del modelo viejo (misma base): el equipo va a la ubicación canónica y el duplicado queda para conciliar');
select t_check('ENR24', (select count(*) from devices where location_id = (t_s('centro', 'location_id'))::uuid and kind = 'POS_PRIMARY' and status = 'ACTIVE') = 1,
  'una ubicación tiene UNA caja principal activa');

-- ============================================================== SYN · hechos
select t_set('v1', jsonb_build_object('uuid', gen_random_uuid()));  -- venta Centro 1
select t_set('v2', jsonb_build_object('uuid', gen_random_uuid()));  -- venta Centro 2
select t_set('t1', jsonb_build_object('uuid', gen_random_uuid()));  -- turno Centro
select t_set('m1', jsonb_build_object('uuid', gen_random_uuid()));  -- retiro Centro
select t_set('caja1', jsonb_build_object('uuid', gen_random_uuid()));
select t_set('cajera', jsonb_build_object('uuid', gen_random_uuid()));
select t_set('encargada', jsonb_build_object('uuid', gen_random_uuid()));

select t_set('lote_centro', jsonb_build_array(
  t_ev('SHIFT_OPENED', 'SHIFT', (t_s('t1', 'uuid'))::uuid, 100, jsonb_build_object('shift_uuid', t_s('t1', 'uuid'), 'closure_id', 31, 'status', 'OPEN',
       'business_date', current_date, 'opened_local', to_char((now() - interval '6 hours') at time zone 'America/Mexico_City', 'YYYY-MM-DD"T"HH24:MI:SS'), 'opening_cash', 500,
       'register', jsonb_build_object('uuid', t_s('caja1', 'uuid'), 'code', 'C1', 'name', 'Caja 1'),
       'opened_by', jsonb_build_object('uuid', t_s('cajera', 'uuid'), 'name', 'lupita'))),
  t_ev('SALE_RECORDED', 'SALE', (t_s('v1', 'uuid'))::uuid, 101, jsonb_build_object('sale_uuid', t_s('v1', 'uuid'), 'folio', 1001,
       'business_date', current_date, 'total', 250.50, 'paid_amount', 250.50, 'balance', 0, 'payment_method', 'EFECTIVO', 'refunded_total', 0,
       'register', jsonb_build_object('uuid', t_s('caja1', 'uuid'), 'code', 'C1', 'name', 'Caja 1'),
       'user', jsonb_build_object('uuid', t_s('cajera', 'uuid'), 'name', 'lupita'))),
  t_ev('SALE_RECORDED', 'SALE', (t_s('v2', 'uuid'))::uuid, 102, jsonb_build_object('sale_uuid', t_s('v2', 'uuid'), 'folio', 1002,
       'business_date', current_date, 'total', 120, 'paid_amount', 120, 'balance', 0, 'payment_method', 'TARJETA', 'refunded_total', 20,
       'register', jsonb_build_object('uuid', t_s('caja1', 'uuid'), 'code', 'C1', 'name', 'Caja 1'),
       'user', jsonb_build_object('uuid', t_s('cajera', 'uuid'), 'name', 'lupita'))),
  t_ev('CASH_MOVEMENT_RECORDED', 'CASH_MOVEMENT', (t_s('m1', 'uuid'))::uuid, 103, jsonb_build_object('movement_uuid', t_s('m1', 'uuid'),
       'type', 'OUT', 'amount', 100, 'business_date', current_date, 'shift_uuid', t_s('t1', 'uuid'),
       'user', jsonb_build_object('uuid', t_s('cajera', 'uuid'), 'name', 'lupita'))),
  t_ev('SHIFT_CLOSED', 'SHIFT', (t_s('t1', 'uuid'))::uuid, 104, jsonb_build_object('shift_uuid', t_s('t1', 'uuid'), 'closure_id', 31, 'status', 'CLOSED',
       'business_date', current_date, 'opened_local', to_char((now() - interval '6 hours') at time zone 'America/Mexico_City', 'YYYY-MM-DD"T"HH24:MI:SS'),
       'closed_local', to_char((now() - interval '10 minutes') at time zone 'America/Mexico_City', 'YYYY-MM-DD"T"HH24:MI:SS'), 'opening_cash', 500,
       'cash_expected', 650.50, 'cash_counted', 640, 'difference', -10.50, 'blind_count', true,
       'register', jsonb_build_object('uuid', t_s('caja1', 'uuid'), 'code', 'C1', 'name', 'Caja 1'),
       'opened_by', jsonb_build_object('uuid', t_s('cajera', 'uuid'), 'name', 'lupita'),
       'closed_by', jsonb_build_object('uuid', t_s('encargada', 'uuid'), 'name', 'marta'),
       'authorized_by', jsonb_build_object('uuid', t_s('encargada', 'uuid'), 'name', 'marta')))
));
select t_set('r1', sync_ingest(jsonb_build_object('device_id', t_s('centro', 'device_id'),
  'envelope', jsonb_build_object('company_uuid', t_s('centro', 'company_id'), 'location_uuid', t_s('centro', 'location_id'),
                                 'instance_uuid', 'c0000000-0000-0000-0000-0000000000c1'), 'events', t_get('lote_centro'))));
select t_check('SYN01', (select bool_and(x->>'result' = 'APPLIED') from jsonb_array_elements(t_get('r1')->'results') x)
                  and (select count(*) from sales_facts where location_id = (t_s('centro', 'location_id'))::uuid) = 2,
  'lote de Centro aplicado: 2 ventas, turno, retiro y cierre');
select t_set('suma_antes', to_jsonb((select sum(total) from sales_facts)));
select t_set('r2', sync_ingest(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'events', t_get('lote_centro'))));
select t_check('SYN02', (select bool_and(x->>'result' = 'DUPLICATE') from jsonb_array_elements(t_get('r2')->'results') x)
                  and (select count(*) from sync_events) = 5 and (select sum(total) from sales_facts) = (t_get('suma_antes'))::numeric,
  'el MISMO lote otra vez (mismos event_uuid): DUPLICATE y un solo efecto');
select t_check('SYN03', (select count(*) from notification_outbox where kind = 'SHIFT_CLOSED' and ref_uuid = (t_s('t1', 'uuid'))::uuid) = 1,
  'SHIFT_CLOSED deja UN aviso pendiente (correo/push/in-app), aunque el evento llegue dos veces');
select t_check('SYN04', (select status from shift_facts where shift_uuid = (t_s('t1', 'uuid'))::uuid) = 'CLOSED'
                  and (select closed_by_uuid from shift_facts where shift_uuid = (t_s('t1', 'uuid'))::uuid) = (t_s('encargada', 'uuid'))::uuid
                  and (select register_uuid from shift_facts where shift_uuid = (t_s('t1', 'uuid'))::uuid) = (t_s('caja1', 'uuid'))::uuid,
  'el corte llega con quién lo cerró y de qué caja');
-- Un evento VIEJO (versión menor) que llega tarde no pisa el estado nuevo.
select t_set('r3', sync_ingest(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'events', jsonb_build_array(
  t_ev('SHIFT_OPENED', 'SHIFT', (t_s('t1', 'uuid'))::uuid, 99, jsonb_build_object('status', 'OPEN', 'business_date', current_date))))));
select t_check('SYN05', t_get('r3')->'results'->0->>'result' = 'APPLIED' and (select status from shift_facts where shift_uuid = (t_s('t1', 'uuid'))::uuid) = 'CLOSED',
  'un evento atrasado (versión menor) se acepta pero no revierte el turno cerrado');
select t_check('SYN06', sync_ingest(jsonb_build_object('device_id', t_s('centro', 'device_id'),
  'envelope', jsonb_build_object('company_uuid', t_s('b', 'company_id')), 'events', '[]'::jsonb))->>'code' = 'ENVELOPE_MISMATCH',
  'el sobre no decide la empresa: si dice otra, se rechaza el lote');
select t_check('SYN07', sync_ingest(jsonb_build_object('device_id', t_s('centro2', 'device_id'), 'events', '[]'::jsonb))->>'code' = 'NOT_PRIMARY',
  'las cajas secundarias no sincronizan (lo hace la principal de la base)');
-- B intenta pisar una venta de A con un evento nuevo y luego reenviar un evento de A.
select t_set('r4', sync_ingest(jsonb_build_object('device_id', t_s('b', 'device_id'), 'events', jsonb_build_array(
  t_ev('SALE_UPDATED', 'SALE', (t_s('v1', 'uuid'))::uuid, 999999, jsonb_build_object('total', 1, 'business_date', current_date)),
  t_get('lote_centro')->0))));
select t_check('SYN08', (select bool_and(x->>'result' = 'REJECTED') from jsonb_array_elements(t_get('r4')->'results') x)
                  and (select total from sales_facts where sale_uuid = (t_s('v1', 'uuid'))::uuid) = 250.50
                  and (select company_id from sales_facts where sale_uuid = (t_s('v1', 'uuid'))::uuid) = (t_s('centro', 'company_id'))::uuid,
  'B no puede sobrescribir una venta de A ni confirmar eventos de A');

-- Norte: dos ventas y un turno abierto.
select t_set('rn', sync_ingest(jsonb_build_object('device_id', t_s('norte', 'device_id'), 'events', jsonb_build_array(
  t_ev('SHIFT_OPENED', 'SHIFT', gen_random_uuid(), 10, jsonb_build_object('closure_id', 5, 'status', 'OPEN', 'business_date', current_date,
       'opened_local', to_char((now() - interval '3 hours') at time zone 'America/Mexico_City', 'YYYY-MM-DD"T"HH24:MI:SS'), 'opening_cash', 300,
       'register', jsonb_build_object('uuid', gen_random_uuid(), 'code', 'N1', 'name', 'Caja Norte'),
       'opened_by', jsonb_build_object('uuid', gen_random_uuid(), 'name', 'pepe'))),
  t_ev('SALE_RECORDED', 'SALE', gen_random_uuid(), 11, jsonb_build_object('folio', 501, 'business_date', current_date, 'total', 80, 'refunded_total', 0)),
  t_ev('SALE_RECORDED', 'SALE', gen_random_uuid(), 12, jsonb_build_object('folio', 502, 'business_date', current_date, 'total', 45.50, 'refunded_total', 0))))));
select t_check('SYN09', (select bool_and(x->>'result' = 'APPLIED') from jsonb_array_elements(t_get('rn')->'results') x),
  'Norte manda sus hechos a la nube (nunca SQL a SQL)');
select t_check('SYN10', (select count(*) from employees where company_id = (t_s('centro', 'company_id'))::uuid) = 3
                  and (select count(*) from registers where company_id = (t_s('centro', 'company_id'))::uuid) = 2,
  'empleados y cajas aparecen con los hechos, dentro de la empresa');

-- ============================================================== IDN · I Do Nut
select t_set('idn', t_q('a0000000-0000-0000-0000-00000000000a', format('select resumen_empresa(%L)::text', t_s('centro', 'company_id')))::jsonb);
select t_check('IDN01', (select count(*) from jsonb_array_elements(t_get('idn')->'ubicaciones') u where u->>'tipo' = 'BRANCH') = 2,
  'la dueña ve Centro y Norte en la misma empresa');
select t_check('IDN02', (select (u->'ventas'->>'neto')::numeric from jsonb_array_elements(t_get('idn')->'ubicaciones') u where u->>'nombre' = 'Centro') = 350.50
                  and (select (u->'ventas'->>'tickets')::int from jsonb_array_elements(t_get('idn')->'ubicaciones') u where u->>'nombre' = 'Centro') = 2,
  'Centro: ventas de hoy (250.50 + 120 - 20 devuelto = 350.50, 2 tickets)');
select t_check('IDN03', (select (u->'ventas'->>'neto')::numeric from jsonb_array_elements(t_get('idn')->'ubicaciones') u where u->>'nombre' = 'Norte') = 125.50,
  'Norte: ventas de hoy (80 + 45.50)');
select t_check('IDN04', (select (u->'ultimo_corte'->>'diferencia')::numeric from jsonb_array_elements(t_get('idn')->'ubicaciones') u where u->>'nombre' = 'Centro') = -10.50
                  and (select u->'ultimo_corte'->>'cerrado_por' from jsonb_array_elements(t_get('idn')->'ubicaciones') u where u->>'nombre' = 'Centro') = 'marta',
  'Centro: último corte con diferencia y quién lo cerró');
select t_check('IDN05', (select jsonb_array_length(u->'turnos_abiertos') from jsonb_array_elements(t_get('idn')->'ubicaciones') u where u->>'nombre' = 'Norte') = 1,
  'Norte: turno abierto en este momento');
select t_check('IDN06', (t_get('idn')->'total'->>'neto')::numeric = 476.00,
  'total de la empresa = Centro + Norte (476.00)');
select t_check('IDN07', t_q('e0000000-0000-0000-0000-00000000000e', format('select jsonb_array_length(resumen_empresa(%L)->''ubicaciones'')::text', t_s('centro', 'company_id'))) = '1',
  'el encargado limitado a Centro solo ve Centro');

-- ============================================================== EMP · multiempresa y RLS
select t_check('EMP01', t_q('b0000000-0000-0000-0000-00000000000b', format('select count(*) from sales_facts where company_id = %L', t_s('centro', 'company_id'))) = '0'
                  and t_q('b0000000-0000-0000-0000-00000000000b', format('select count(*) from sucursales where negocio_id = %L', t_s('centro', 'company_id'))) = '0'
                  and t_q('b0000000-0000-0000-0000-00000000000b', format('select count(*) from shift_facts where company_id = %L', t_s('centro', 'company_id'))) = '0'
                  and t_q('b0000000-0000-0000-0000-00000000000b', format('select count(*) from negocios where id = %L', t_s('centro', 'company_id'))) = '0',
  'B no lee nada de A (empresa, ubicaciones, ventas, turnos)');
select t_check('EMP02', t_q('b0000000-0000-0000-0000-00000000000b', format('select resumen_empresa(%L)::text', t_s('centro', 'company_id'))) = 'ERR:42501',
  'B pide el resumen de A: DENEGADO');
select t_check('EMP03', t_q('b0000000-0000-0000-0000-00000000000b', 'update alertas set leida = true where sucursal_id = ''30000000-0000-0000-0000-000000000001'' returning 1') is null
                  and (select bool_and(not leida) from alertas where sucursal_id = '30000000-0000-0000-0000-000000000001'),
  'B no puede modificar alertas de otra empresa');
select t_check('EMP04', t_q('a0000000-0000-0000-0000-00000000000a', format('update sales_facts set total = 0 where company_id = %L returning 1', t_s('centro', 'company_id'))) like 'ERR:%'
                  and t_q('a0000000-0000-0000-0000-00000000000a', format('insert into sucursales (negocio_id, nombre) values (%L, ''x'') returning 1', t_s('centro', 'company_id'))) like 'ERR:%',
  'ni la dueña escribe directo: los datos solo entran por hechos/funciones');
select t_check('EMP05', t_q('ab000000-0000-0000-0000-0000000000ab', 'select jsonb_array_length(mis_empresas())::text') = '2'
                  and t_q('ab000000-0000-0000-0000-0000000000ab', format('select (resumen_empresa(%L)->>''company_id'')', t_s('b', 'company_id'))) = t_s('b', 'company_id')
                  and t_q('ab000000-0000-0000-0000-0000000000ab', format('select (resumen_empresa(%L)->>''company_id'')', t_s('centro', 'company_id'))) = t_s('centro', 'company_id'),
  'un usuario con A y B puede seleccionar las dos');
select t_check('EMP06', t_q('e0000000-0000-0000-0000-00000000000e', format('select resumen_empresa(%L)::text', t_s('b', 'company_id'))) = 'ERR:42501'
                  and t_q('e0000000-0000-0000-0000-00000000000e', format('select count(*) from sucursales where negocio_id = %L', t_s('b', 'company_id'))) = '0',
  'un empleado de A sin membresía en B no tiene acceso a B');
select t_check('EMP07', t_q('e0000000-0000-0000-0000-00000000000e', format('select count(*) from sales_facts where location_id = %L', t_s('norte', 'location_id'))) = '0'
                  and t_q('e0000000-0000-0000-0000-00000000000e', format('select count(*) from sales_facts where location_id = %L', t_s('centro', 'location_id'))) = '2',
  'membresía limitada a una ubicación: ve Centro, no Norte');
select t_check('EMP08', t_q('f0000000-0000-0000-0000-00000000000f', 'select count(*) from sucursales') = '0'
                  and t_q('f0000000-0000-0000-0000-00000000000f', 'select jsonb_array_length(mis_empresas())::text') = '0',
  'un usuario sin membresía no ve nada');
select t_check('EMP09', t_q('a0000000-0000-0000-0000-00000000000a', 'select count(*) from company_memberships') = '3'
                  and t_q('e0000000-0000-0000-0000-00000000000e', 'select count(*) from company_memberships') = '1',
  'la dueña ve las membresías de su empresa; el encargado solo la suya');
select t_check('EMP10', t_q(null, 'select count(*) from sucursales', 'anon') like 'ERR:%'
                  and t_q(null, 'select count(*) from sales_facts', 'anon') like 'ERR:%',
  'anon no lee nada');
select t_check('EMP11', not exists (select 1 from pg_policies where schemaname = 'public' and (qual like '%account%' or with_check like '%account%')),
  'la cuenta comercial (accounts) no aparece en ninguna política: nunca da acceso');

-- ============================================================== FIS · CFDI
select t_set('emisor_a', fiscal_registrar_emisor(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'person_id', 'fapi-person-A',
  'rfc', 'IDN010101AAA', 'legal_name', 'I DO NUT', 'tax_regime', '601', 'zip_code', '64000')));
select t_set('emisor_b', fiscal_registrar_emisor(jsonb_build_object('device_id', t_s('b', 'device_id'), 'person_id', 'fapi-person-B',
  'rfc', 'OTR010101BBB', 'legal_name', 'OTRA', 'tax_regime', '601', 'zip_code', '01000')));
select t_check('FIS01', (t_s('emisor_a', 'ok'))::boolean and (t_s('emisor_b', 'ok'))::boolean, 'cada empresa registra su emisor');
select t_check('FIS02', fiscal_autorizar(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'action', 'STAMP', 'issuer_id', t_s('emisor_b', 'issuer_id')))->>'code' = 'DENIED'
                  and fiscal_autorizar(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'action', 'STAMP', 'issuer_id', 'fapi-person-B'))->>'code' = 'DENIED',
  'emisor de otra empresa: DENEGADO (por id de la nube o por id de Fiscalapi)');
select t_check('FIS03', fiscal_autorizar(jsonb_build_object('device_id', t_s('norte', 'device_id'), 'action', 'STAMP', 'issuer_id', 'fapi-person-B'))->>'code' = 'DENIED',
  'equipo de A (Norte) usando el emisor de B: DENEGADO');
select t_set('stamp_a', fiscal_autorizar(jsonb_build_object('device_id', t_s('centro2', 'device_id'), 'action', 'STAMP')));
select t_check('FIS04', (t_s('stamp_a', 'ok'))::boolean and t_get('stamp_a')->'issuer'->>'rfc' = 'IDN010101AAA' and t_get('stamp_a')->'issuer'->>'person_id' = 'fapi-person-A',
  'timbrar desde cualquier caja de A usa el emisor de A (RFC y persona salen de la nube, no de la petición)');
select fiscal_registrar_factura(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'issuer_id', t_s('emisor_a', 'issuer_id'),
  'invoice_id', 'fapi-inv-A1', 'sat_uuid', 'AAAA-1', 'series', 'A', 'folio', '1', 'total', 250.50));
select fiscal_registrar_factura(jsonb_build_object('device_id', t_s('b', 'device_id'), 'issuer_id', t_s('emisor_b', 'issuer_id'),
  'invoice_id', 'fapi-inv-B1', 'total', 99));
select t_check('FIS05', fiscal_autorizar(jsonb_build_object('device_id', t_s('b', 'device_id'), 'action', 'FILES', 'invoice_id', 'fapi-inv-A1'))->>'code' = 'DENIED',
  'XML/PDF de una factura de otra empresa: DENEGADO');
select t_check('FIS06', fiscal_autorizar(jsonb_build_object('device_id', t_s('b', 'device_id'), 'action', 'CANCEL', 'invoice_id', 'fapi-inv-A1'))->>'code' = 'DENIED'
                  and fiscal_marcar_cancelacion(jsonb_build_object('device_id', t_s('b', 'device_id'), 'invoice_id', 'fapi-inv-A1'))->>'code' = 'DENIED'
                  and (select status from fiscal_invoices where fiscalapi_invoice_id = 'fapi-inv-A1') = 'STAMPED',
  'cancelar una factura de otra empresa: DENEGADO y la factura sigue intacta');
select t_check('FIS07', fiscal_autorizar(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'action', 'FILES', 'invoice_id', 'fapi-inv-desconocida'))->>'code' = 'DENIED',
  'una factura que la nube no conoce no se entrega (ni a la propia empresa sin reclamarla)');
select t_check('FIS08', (fiscal_autorizar(jsonb_build_object('device_id', t_s('norte', 'device_id'), 'action', 'FILES', 'invoice_id', 'fapi-inv-A1'))->>'ok')::boolean,
  'otra sucursal de la MISMA empresa sí puede descargar la factura');
select t_check('FIS09', fiscal_registrar_emisor(jsonb_build_object('device_id', t_s('b', 'device_id'), 'person_id', 'fapi-person-A', 'rfc', 'XXX'))->>'code' = 'DENIED'
                  and (select company_id from fiscal_issuers where fiscalapi_person_id = 'fapi-person-A') = (t_s('centro', 'company_id'))::uuid,
  'B no puede apropiarse de la persona fiscal de A');
select t_check('FIS10', fiscal_autorizar(jsonb_build_object('device_id', t_s('centro2', 'device_id'), 'action', 'REGISTER'))->>'code' = 'DENIED',
  'registrar el CSD solo desde la caja principal');
select t_check('FIS11', fiscal_persona_de_empresa(jsonb_build_object('device_id', t_s('b', 'device_id'), 'rfc', 'IDN010101AAA'))->>'person_id' is null,
  'B no descubre la persona fiscal de A por su RFC');
-- Transición: lo histórico se reclama, no se inventa.
select t_set('hist_a', fiscal_reclamar_historico(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'person_id', 'fapi-person-HIST',
  'rfc', 'IDN010101AAA', 'invoices', jsonb_build_array(jsonb_build_object('invoice_id', 'fapi-inv-H1'), jsonb_build_object('invoice_id', 'fapi-inv-H2')))));
select t_check('FIS12', t_s('hist_a', 'issuer_status') = 'PENDING_RECONCILIATION' and (t_get('hist_a')->'invoices'->>'pending_reconciliation')::int = 2,
  'emisor y facturas históricas reclamadas por UNA empresa: pendientes de conciliar (2 facturas)');
select t_check('FIS13', (fiscal_autorizar(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'action', 'STAMP', 'issuer_id', 'fapi-person-HIST'))->>'ok')::boolean,
  'el CFDI legítimo no se rompe: el emisor pendiente sigue timbrando para quien lo reclamó');
select t_set('hist_b', fiscal_reclamar_historico(jsonb_build_object('device_id', t_s('b', 'device_id'), 'person_id', 'fapi-person-HIST',
  'invoices', jsonb_build_array(jsonb_build_object('invoice_id', 'fapi-inv-H1')))));
select t_check('FIS14', t_s('hist_b', 'issuer_status') = 'CONFLICT'
                  and fiscal_autorizar(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'action', 'STAMP', 'issuer_id', 'fapi-person-HIST'))->>'code' = 'ISSUER_CONFLICT'
                  and fiscal_autorizar(jsonb_build_object('device_id', t_s('b', 'device_id'), 'action', 'STAMP', 'issuer_id', 'fapi-person-HIST'))->>'code' = 'DENIED'
                  and fiscal_autorizar(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'action', 'FILES', 'invoice_id', 'fapi-inv-H1'))->>'code' = 'DENIED',
  'si otra empresa reclama lo mismo: CONFLICTO y bloqueado para todas');
select fiscal_conciliar_emisor(jsonb_build_object('issuer_id', (select id from fiscal_issuers where fiscalapi_person_id = 'fapi-person-HIST'),
  'company_id', t_s('centro', 'company_id'), 'decision', 'ASSIGN', 'actor', 'soporte'));
select t_check('FIS15', (select status from fiscal_issuers where fiscalapi_person_id = 'fapi-person-HIST') = 'ACTIVE'
                  and (fiscal_autorizar(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'action', 'FILES', 'invoice_id', 'fapi-inv-H1'))->>'ok')::boolean,
  'Wybix concilia: el emisor queda de A y sus facturas se liberan');
select t_check('FIS16', (select count(*) from cloud_audit where action like 'FISCAL_%' and result = 'DENIED') >= 6,
  'cada intento fiscal denegado queda en la bitácora', (select count(*) from cloud_audit where action like 'FISCAL_%' and result = 'DENIED')::text);
select t_set('pantalla', pos_enroll(jsonb_build_object('install_secret', t_s('b', 'install_secret'), 'instance_uuid', 'b0000000-0000-0000-0000-0000000000b1',
  'device_uuid', gen_random_uuid(), 'kind', 'OPERATIONAL_SCREEN')));
select t_check('FIS17', fiscal_autorizar(jsonb_build_object('device_id', t_s('pantalla', 'device_id'), 'action', 'STAMP'))->>'code' = 'DENIED',
  'una pantalla operativa no timbra');

-- ============================================================== LIC · licencias
select t_check('LIC01', (company_entitlements((t_s('centro', 'company_id'))::uuid)->>'licenses')::int = 0
                  and (company_entitlements((t_s('centro', 'company_id'))::uuid)->>'enforced')::boolean = false,
  'sin licencia ligada, los derechos se informan pero no se aplican (Fase 1)');
insert into licenses (id, license_key, plan, customer_name, max_registers) values
  ('40000000-0000-0000-0000-0000000000c1', 'WYBX-IDN-CENT', 'multi', 'I Do Nut Centro', null),
  ('40000000-0000-0000-0000-0000000000c2', 'WYBX-IDN-NORT', 'mono', 'I Do Nut Norte', 1);
insert into license_activations (license_id, machine_id) values
  ('40000000-0000-0000-0000-0000000000c1', 'PC-IDN-CENTRO'), ('40000000-0000-0000-0000-0000000000c2', 'PC-IDN-NORTE');
select t_set('vinc', jsonb_build_array(pos_vincular_licencia(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'machine_id', 'PC-IDN-CENTRO')),
                                        pos_vincular_licencia(jsonb_build_object('device_id', t_s('norte', 'device_id'), 'machine_id', 'PC-IDN-NORTE'))));
select t_check('LIC02', (t_get('vinc')->0->>'ok')::boolean and (t_get('vinc')->1->>'ok')::boolean
                  and (company_entitlements((t_s('centro', 'company_id'))::uuid)->>'locations_max')::int = 2,
  'licencia -> empresa -> derechos: dos licencias de I Do Nut = 2 ubicaciones');
select t_check('LIC03', pos_vincular_licencia(jsonb_build_object('device_id', t_s('b', 'device_id'), 'machine_id', 'PC-IDN-CENTRO'))->>'code' = 'CONFLICT'
                  and (select company_id from licenses where id = '40000000-0000-0000-0000-0000000000c1') = (t_s('centro', 'company_id'))::uuid,
  'una licencia ya ligada no se reasigna a otra empresa: queda en conflicto');
select t_check('LIC04', (select device_id from license_activations where machine_id = 'PC-IDN-NORTE') = (t_s('norte', 'device_id'))::uuid,
  'la activación de máquina queda ligada al equipo y a su ubicación');

-- ============================================================== PRV · privilegios
select t_check('PRV01', t_q('a0000000-0000-0000-0000-00000000000a', 'select pos_bootstrap(''{}'')::text') = 'ERR:42501'
                  and t_q('a0000000-0000-0000-0000-00000000000a', 'select sync_ingest(''{}'')::text') = 'ERR:42501'
                  and t_q('a0000000-0000-0000-0000-00000000000a', 'select fiscal_autorizar(''{}'')::text') = 'ERR:42501'
                  and t_q('a0000000-0000-0000-0000-00000000000a', 'select membresia_aceptar_invitacion(''{}'')::text') = 'ERR:42501',
  'las funciones de equipos, sincronización y fiscales solo las ejecuta el backend');
select t_check('PRV02', t_q('a0000000-0000-0000-0000-00000000000a', 'select count(*) from devices') = 'ERR:42501'
                  and t_q('a0000000-0000-0000-0000-00000000000a', 'select count(*) from fiscal_issuers') = 'ERR:42501'
                  and t_q('a0000000-0000-0000-0000-00000000000a', 'select count(*) from cloud_audit') = 'ERR:42501'
                  and t_q('a0000000-0000-0000-0000-00000000000a', 'select count(*) from sync_events') = 'ERR:42501',
  'credenciales, emisores, bitácora y eventos crudos fuera del alcance de la app');
select t_check('PRV03', t_q('a0000000-0000-0000-0000-00000000000a', 'select count(*) from respaldo.fase1_politicas') = 'ERR:42501',
  'el respaldo de la migración tampoco es legible');
select t_check('PRV04', not exists (select 1 from devices where credential_hash like 'wxd_%') and not exists (select 1 from sucursales where install_secret_hash like 'wxi_%'),
  'en la base solo hay hashes de credenciales y llaves, nunca el valor');

-- ============================================================== DEL · borrar cuenta
select t_check('DEL01', pos_borrar_cuenta(jsonb_build_object('device_id', t_s('centro', 'device_id')))->>'code' = 'MULTI_LOCATION'
                  and exists (select 1 from negocios where id = (t_s('centro', 'company_id'))::uuid),
  'una sucursal no puede borrar una empresa con varias ubicaciones');
select t_check('DEL02', pos_borrar_cuenta(jsonb_build_object('device_id', t_s('centro2', 'device_id')))->>'code' = 'DENIED',
  'una caja secundaria no borra la cuenta');
select t_set('del_b', pos_borrar_cuenta(jsonb_build_object('device_id', t_s('b', 'device_id'))));
select t_check('DEL03', (t_s('del_b', 'ok'))::boolean and not exists (select 1 from negocios where id = (t_s('b', 'company_id'))::uuid)
                  and (t_get('del_b')->'delete_users') ? 'b0000000-0000-0000-0000-00000000000b'
                  and not ((t_get('del_b')->'delete_users') ? 'ab000000-0000-0000-0000-0000000000ab'),
  'empresa de una sola ubicación: se borra, y solo se borran usuarios que no tienen otra empresa');

select 'ok|' || id || '|' || msg || coalesce(' · ' || det, '') from t_res where ok order by n;
select 'FALLA|' || id || '|' || msg || coalesce(' · ' || det, '') from t_res where not ok order by n;
