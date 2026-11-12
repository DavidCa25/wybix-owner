-- ============================================================================
--  CANAL DE PRECIOS DEL EVENTO (20261111120000) · corre después de marca.test.sql
--  en el mismo contenedor (usa t_check, t_qa, t_s y t_duena de las fases).
-- ============================================================================
create or replace function t_canal_dev() returns uuid language sql as $$
  select d.id from public.devices d where d.kind = 'MOBILE_POS' and d.status = 'ACTIVE'
     and d.location_id = (t_s('feria', 'location_id'))::uuid order by d.created_at desc limit 1 $$;
create or replace function t_canal_guardar(p_aal text, p_canal text) returns text language sql as $$
  select t_qa(t_duena(), p_aal, format('select owner_evento_canal(%L, %L, %L)::text', t_s('centro', 'company_id'), t_s('feria', 'location_id'), p_canal)) $$;

-- La sucursal base publica un catálogo con canales (uno inactivo).
insert into public.catalog_publications (location_id, company_id, version, content_hash, payload)
select s.home_location_id, s.negocio_id, coalesce((select max(version) from public.catalog_publications where location_id = s.home_location_id), 0) + 1, 'QA-CANAL',
       coalesce((select payload from public.catalog_publications where location_id = s.home_location_id order by version desc limit 1), '{}'::jsonb)
         || jsonb_build_object('commercial', jsonb_build_object('version', 1,
              'channels', jsonb_build_array(
                jsonb_build_object('id', 'LOCAL', 'name', 'Mostrador', 'active', true, 'inheritBase', true),
                jsonb_build_object('id', 'FERIA', 'name', 'Feria', 'active', true, 'inheritBase', false),
                jsonb_build_object('id', 'VIEJO', 'name', 'Canal viejo', 'active', false, 'inheritBase', true)),
              'prices', '[]'::jsonb, 'promotions', '[]'::jsonb, 'combos', '[]'::jsonb))
  from public.sucursales s where s.id = (t_s('feria', 'location_id'))::uuid;

select t_check('CANAL00', t_canal_dev() is not null, 'hay una tablet activa en la feria');
select t_check('CANAL01',
  (public.mobile_snapshot(jsonb_build_object('device_id', t_canal_dev(), 'commercial_schema', 2))->'location' ? 'default_channel')
  and public.mobile_snapshot(jsonb_build_object('device_id', t_canal_dev(), 'commercial_schema', 2))->'location'->'default_channel' = 'null'::jsonb,
  'sin canal elegido, la tablet recibe default_channel = null (Mostrador)');
select t_check('CANAL02',
  not has_function_privilege('anon', 'public.owner_evento_canal(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.owner_evento_canales(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.wx_canales_evento(uuid)', 'execute'),
  'anon no lee ni cambia el canal; el auxiliar no es RPC');
select t_check('CANAL03',
  (select count(*) from jsonb_array_elements((t_qa(t_duena(), 'aal1', format('select owner_evento_canales(%L, %L)::text',
     t_s('centro', 'company_id'), t_s('feria', 'location_id')))::jsonb)->'canales')) = 3,
  'la dueña ve los canales del catálogo de la sucursal base');
select t_check('CANAL04', (t_canal_guardar('aal1', 'FERIA')::jsonb)->>'code' = 'MFA_REQUIRED', 'cambiar el canal pide segundo factor');
select t_check('CANAL05',
  (t_canal_guardar('aal2', 'NO_EXISTE')::jsonb)->>'code' = 'BAD_CHANNEL'
  and (t_canal_guardar('aal2', 'VIEJO')::jsonb)->>'code' = 'BAD_CHANNEL',
  'un canal que no existe o está inactivo se rechaza');
select t_check('CANAL06', (t_canal_guardar('aal2', 'FERIA')::jsonb)->>'ok' = 'true', 'la dueña elige Feria');
-- Por separado: dentro de una sentencia, las funciones stable ven los datos de antes del update.
select t_check('CANAL07',
  public.mobile_snapshot(jsonb_build_object('device_id', t_canal_dev(), 'commercial_schema', 2))->'location'->>'default_channel' = 'FERIA'
  and exists (select 1 from public.cloud_audit where action = 'EVENTO_CANAL'),
  'la tablet recibe default_channel = FERIA y queda auditado');
select t_check('CANAL08',
  (t_qa(gen_random_uuid(), 'aal2', format('select owner_evento_canal(%L, %L, ''LOCAL'')::text', t_s('centro', 'company_id'), t_s('feria', 'location_id')))::jsonb)->>'ok' = 'false',
  'alguien ajeno a la empresa no lo cambia');
select t_check('CANAL09', (t_canal_guardar('aal2', 'LOCAL')::jsonb)->>'ok' = 'true', 'volver a Mostrador');
select t_check('CANAL10', (select canal_precio from public.sucursales where id = (t_s('feria', 'location_id'))::uuid) is null,
  'Mostrador se guarda como nulo');

drop function t_canal_dev(); drop function t_canal_guardar(text, text);

select 'ok|' || id || '|' || msg || coalesce(' · ' || det, '') from t_res where ok and id like 'CANAL%' order by n;
select 'FALLA|' || id || '|' || msg || coalesce(' · ' || det, '') from t_res where not ok and id like 'CANAL%' order by n;
