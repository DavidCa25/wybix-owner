-- ============================================================================
--  MARCA DEL NEGOCIO (20261107120000) · corre después de tests/fase3.test.sql
--  en el mismo contenedor (usa t_check, t_qa, t_s y t_duena de las fases).
-- ============================================================================
create or replace function t_marca_dev() returns uuid language sql as $$
  select d.id from public.devices d where d.kind = 'MOBILE_POS' and d.status = 'ACTIVE'
     and d.company_id = (t_s('centro', 'company_id'))::uuid order by d.created_at desc limit 1 $$;
create or replace function t_marca_snap(p_hash text default null) returns jsonb language sql as $$
  select public.mobile_snapshot(jsonb_build_object('device_id', t_marca_dev(), 'commercial_schema', 2, 'brand_hash', p_hash)) $$;
create or replace function t_marca_guardar(p_aal text, p jsonb) returns text language sql as $$
  select t_qa(t_duena(), p_aal, format('select owner_marca_guardar(%L, %L::jsonb)::text', t_s('centro', 'company_id'), p::text)) $$;
-- PNG de 1×1 en base64.
create temp table t_logo as select 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='::text as v;

select t_check('MARCA00', t_marca_dev() is not null, 'hay una tablet activa de la empresa para la prueba');
select t_check('MARCA01', (t_marca_snap() ? 'brand') and t_marca_snap()->'brand' = 'null'::jsonb,
  'sin marca configurada, el snapshot dice brand = null (la tablet usa Wybix)');

select t_check('MARCA02',
  not has_function_privilege('anon', 'public.owner_marca_guardar(uuid, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.owner_marca(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.mobile_snapshot(jsonb)', 'execute'),
  'anon no lee ni guarda marcas; el snapshot sigue siendo solo de la Edge Function');

select t_check('MARCA03', (t_marca_guardar('aal1', jsonb_build_object('color', '#e91e63'))::jsonb)->>'code' = 'MFA_REQUIRED',
  'guardar la marca pide segundo factor');
select t_check('MARCA04',
  (t_qa(gen_random_uuid(), 'aal2', format('select owner_marca_guardar(%L, ''{"color":"#000000"}'')::text', t_s('centro', 'company_id')))::jsonb)->>'ok' = 'false',
  'alguien ajeno a la empresa no la cambia');
select t_check('MARCA05', (t_marca_guardar('aal2', jsonb_build_object('color', 'rojo'))::jsonb)->>'code' = 'BAD_COLOR'
  and (t_marca_guardar('aal2', jsonb_build_object('logo', 'https://x.com/logo.png'))::jsonb)->>'code' = 'BAD_LOGO'
  and (t_marca_guardar('aal2', jsonb_build_object('logo', 'data:image/svg+xml;base64,PHN2Zz4='))::jsonb)->>'code' = 'BAD_LOGO'
  and (t_marca_guardar('aal2', jsonb_build_object('logo', 'data:image/png;base64,' || repeat('A', 300000)))::jsonb)->>'code' = 'BAD_LOGO',
  'color inválido, URL, SVG y logo enorme se rechazan');
select t_check('MARCA06', (select marca from public.negocios where id = (t_s('centro', 'company_id'))::uuid) is null,
  'un intento rechazado no cambia nada');

select t_check('MARCA07', (t_marca_guardar('aal2', jsonb_build_object('color', '#e91e63', 'logo', (select v from t_logo)))::jsonb)->>'ok' = 'true',
  'la dueña guarda color y logo');
select t_check('MARCA08', (t_qa(t_duena(), 'aal1', format('select owner_marca(%L)::text', t_s('centro', 'company_id')))::jsonb)->'marca'->>'color' = '#E91E63',
  'se lee de vuelta (color normalizado en mayúsculas)');
select t_check('MARCA09', exists (select 1 from public.cloud_audit where action = 'MARCA_GUARDADA' and company_id = (t_s('centro', 'company_id'))::uuid),
  'queda auditado');

create temp table t_snap as select t_marca_snap() as s;
select t_check('MARCA10', (select s->'brand'->>'color' = '#E91E63' and (s->'brand'->>'logo_incluido')::boolean
                                  and s->'brand'->>'logo' = (select v from t_logo) and length(s->'brand'->>'hash') = 32 from t_snap),
  'la tablet sin marca recibe color, logo y hash');
select t_check('MARCA11', (select not (b->>'logo_incluido')::boolean and b->'logo' = 'null'::jsonb and b->>'color' = '#E91E63'
                             from (select t_marca_snap((select s->'brand'->>'hash' from t_snap))->'brand' as b) x),
  'con el mismo hash, el logo no se vuelve a mandar');
select t_check('MARCA12', (t_marca_snap('otro-hash')->'brand'->>'logo_incluido')::boolean,
  'con un hash distinto, el logo viaja otra vez');

-- Por separado: dentro de UNA sentencia, las funciones stable ven los datos de antes del update.
select t_check('MARCA13', (t_marca_guardar('aal2', '{}'::jsonb)::jsonb)->>'ok' = 'true', 'quitar la marca (color y logo vacíos)');
select t_check('MARCA14', (select marca from public.negocios where id = (t_s('centro', 'company_id'))::uuid) is null
  and t_marca_snap('cualquiera')->'brand' = 'null'::jsonb,
  'sin marca regresa a Wybix y la tablet recibe brand = null');

drop function t_marca_dev(); drop function t_marca_snap(text); drop function t_marca_guardar(text, jsonb);

select 'ok|' || id || '|' || msg || coalesce(' · ' || det, '') from t_res where ok and id like 'MARCA%' order by n;
select 'FALLA|' || id || '|' || msg || coalesce(' · ' || det, '') from t_res where not ok and id like 'MARCA%' order by n;
