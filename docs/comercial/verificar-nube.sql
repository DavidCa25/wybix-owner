-- Solo lectura: sin datos personales ni credenciales.
select
 exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_facts' and column_name='commercial_snapshot') as venta_snapshot_ok,
 exists(select 1 from information_schema.columns where table_schema='public' and table_name='sale_line_facts' and column_name='commercial_snapshot') as partidas_snapshot_ok,
 not has_function_privilege('anon','public.mobile_snapshot(jsonb)','EXECUTE') and not has_function_privilege('authenticated','public.mobile_snapshot(jsonb)','EXECUTE') as snapshot_privado_ok,
 not has_function_privilege('anon','public.commercial_sales_summary(uuid,date)','EXECUTE') and has_function_privilege('authenticated','public.commercial_sales_summary(uuid,date)','EXECUTE') as reporte_permisos_ok,
 (select count(*)=2 from supabase_migrations.schema_migrations where version in ('20261012120000','20261012130000')) as historial_comercial_ok;
