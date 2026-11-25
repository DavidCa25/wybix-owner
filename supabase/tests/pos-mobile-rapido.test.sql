-- ============================================================================
--  POS MOBILE RÁPIDO (20261124120000) · corre después de canal-evento.test.sql
--  en el mismo contenedor (usa t_check y t_s).
-- ============================================================================
create or replace function t_rap_dev() returns uuid language sql as $$
  select d.id from public.devices d where d.kind = 'MOBILE_POS' and d.status = 'ACTIVE'
     and d.location_id = (t_s('feria', 'location_id'))::uuid order by d.created_at desc limit 1 $$;
create or replace function t_rap_snap(p jsonb) returns jsonb language sql as $$
  select public.mobile_snapshot(jsonb_build_object('device_id', t_rap_dev(), 'commercial_schema', 3) || p) $$;

select t_check('RAPIDO01',
  (t_rap_snap('{}'::jsonb)->'catalog') is not null and jsonb_typeof(t_rap_snap('{}'::jsonb)->'staff') = 'array',
  'una tablet que no dice qué tiene recibe catálogo y personal (compatibilidad con tablets viejas)');
select t_check('RAPIDO02',
  (t_rap_snap(jsonb_build_object('catalog_version', (t_rap_snap('{}'::jsonb)->>'catalog_version')::bigint,
                                 'security_revision', (t_rap_snap('{}'::jsonb)->>'security_revision')::bigint))->'catalog') = 'null'::jsonb
  and (t_rap_snap(jsonb_build_object('catalog_version', (t_rap_snap('{}'::jsonb)->>'catalog_version')::bigint,
                                     'security_revision', (t_rap_snap('{}'::jsonb)->>'security_revision')::bigint))->'staff') = 'null'::jsonb
  and (t_rap_snap(jsonb_build_object('catalog_version', (t_rap_snap('{}'::jsonb)->>'catalog_version')::bigint,
                                     'security_revision', (t_rap_snap('{}'::jsonb)->>'security_revision')::bigint))->>'sin_cambios')::boolean,
  'con la versión vigente no se reenvía el catálogo ni el personal');
select t_check('RAPIDO03',
  (t_rap_snap(jsonb_build_object('catalog_version', (t_rap_snap('{}'::jsonb)->>'catalog_version')::bigint - 1))->'catalog') is not null
  and (t_rap_snap(jsonb_build_object('catalog_version', (t_rap_snap('{}'::jsonb)->>'catalog_version')::bigint - 1))->>'catalog_version')
      = (t_rap_snap('{}'::jsonb)->>'catalog_version'),
  'con una versión vieja el catálogo sí llega, con su versión');
-- El latido y la lectura van en sentencias distintas: una misma sentencia no ve su propio UPDATE.
select t_set('rap_latido', public.mobile_latido(jsonb_build_object('device_id', t_rap_dev(), 'pendientes', 0, 'app_version', '0.4.0',
  'stats', jsonb_build_object('total_ms', 640, 'modo', 'completo', 'catalogo', 'sin_cambios', 'secreto', 'no', 'error', repeat('x', 200)))));
select t_check('RAPIDO04',
  (t_s('rap_latido', 'ok'))::boolean
  and (select sync_stats->>'total_ms' = '640' and sync_stats->>'catalogo' = 'sin_cambios'
              and not (sync_stats ? 'secreto') and not (sync_stats ? 'error') and sync_stats ? 'at'
         from public.devices where id = t_rap_dev()),
  'el latido guarda solo las métricas conocidas y cortas');
select t_check('RAPIDO05',
  not has_function_privilege('anon', 'public.mobile_snapshot(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.mobile_latido(jsonb)', 'execute'),
  'las funciones de la tablet siguen fuera del alcance de anon y authenticated');

drop function t_rap_snap(jsonb); drop function t_rap_dev();

select 'ok|' || id || '|' || msg || coalesce(' · ' || det, '') from t_res where ok and id like 'RAPIDO%' order by n;
select 'FALLA|' || id || '|' || msg || coalesce(' · ' || det, '') from t_res where not ok and id like 'RAPIDO%' order by n;
