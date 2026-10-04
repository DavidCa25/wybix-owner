-- Solo lectura: inventario del backend; nunca devuelve secretos ni filas de clientes.
select jsonb_build_object(
 'migrations',(select coalesce(jsonb_agg(version order by version),'[]') from supabase_migrations.schema_migrations),
 'extensions',(select jsonb_agg(extname order by extname) from pg_extension),
 'tables',(select jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v')),
 'columns',(select jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type) order by table_name,ordinal_position) from information_schema.columns where table_schema='public'),
 'rpcs',(select jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'security_definer',p.prosecdef,'hash',md5(pg_get_functiondef(p.oid))) order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'),
 'policies',(select coalesce(jsonb_agg(jsonb_build_object('table',tablename,'name',policyname,'command',cmd,'roles',roles,'using',qual,'check',with_check) order by tablename,policyname),'[]') from pg_policies where schemaname='public'),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'function',p.proname,'enabled',t.tgenabled,'definition_hash',md5(pg_get_triggerdef(t.oid))) order by c.relname,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid where n.nspname='public' and not t.tgisinternal),
 'license_catalog',(select jsonb_agg(jsonb_build_object('code',code,'kind',kind,'edition',edition,'vertical',vertical,'grants',grants,'active',active,'billing',billing) order by code) from public.license_catalog)
) as inventory;
