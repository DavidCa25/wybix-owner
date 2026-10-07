-- ============================================================================
--  REVERSA de 20261002120000_fase1_multiempresa.sql
-- ----------------------------------------------------------------------------
--  Solo para recuperación. NO es una migración (no va en supabase/migrations):
--  se corre a mano, con respaldo previo del proyecto, y después se despliegan
--  de nuevo las Edge Functions ANTERIORES (pos-sync, fiscal-*, link-owner).
--
--  QUÉ HACE
--    1. Copia TODO lo que la Fase 1 creó a `respaldo.fase1_rb_*` (equipos,
--       membresías, hechos, emisores y facturas con su empresa). Nada se
--       pierde: si se vuelve a aplicar la Fase 1, se puede reimportar.
--    2. Restaura las políticas RLS respaldadas, los privilegios por omisión de
--       Supabase y los grants del catálogo de licencias.
--    3. Quita funciones, disparador, vista, tablas y columnas nuevas.
--
--  EFECTOS QUE HAY QUE SABER
--    · Los POS ya actualizados (credencial por equipo) dejan de sincronizar
--      hasta reaprovisionarse con `provision` (token por sucursal).
--    · Las funciones fiscales anteriores vuelven a confiar en el issuerId de la
--      petición: la vulnerabilidad P0 regresa. Es una reversa de emergencia.
--
--  Todo en UNA transacción: si algo falla, no queda a medias.
--  Idempotente: se puede correr dos veces.
-- ============================================================================

begin;

-- 1) Respaldo de lo nuevo -----------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['accounts', 'company_memberships', 'company_invites', 'employees', 'registers', 'devices',
                           'device_enrollments', 'sync_events', 'sales_facts', 'shift_facts', 'cash_movement_facts',
                           'notification_outbox', 'fiscal_issuers', 'fiscal_issuer_claims', 'fiscal_invoices',
                           'fiscal_invoice_claims', 'cloud_audit', 'reconciliation_items'] loop
    if to_regclass('public.' || t) is not null and to_regclass('respaldo.fase1_rb_' || t) is null then
      execute format('create table respaldo.fase1_rb_%s as select * from public.%I', t, t);
    end if;
  end loop;
  if to_regclass('respaldo.fase1_rb_sucursales') is null and exists (
       select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sucursales' and column_name = 'instance_uuid') then
    create table respaldo.fase1_rb_sucursales as
      select id, tipo, status, instance_uuid, install_secret_hash, starts_at, ends_at, home_location_id, timezone from public.sucursales;
  end if;
  if to_regclass('respaldo.fase1_rb_licencias') is null and exists (
       select 1 from information_schema.columns where table_schema = 'public' and table_name = 'licenses' and column_name = 'company_id') then
    create table respaldo.fase1_rb_licencias as select id, company_id, account_id from public.licenses;
    create table respaldo.fase1_rb_activaciones as select id, device_id, location_id, kind from public.license_activations;
  end if;
end $$;
revoke all on all tables in schema respaldo from anon, authenticated;

-- 2) Políticas, privilegios y catálogo ------------------------------------------
do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
            where schemaname = 'public'
              and tablename in ('negocios', 'sucursales', 'resumen_ventas', 'tendencia_ventas', 'top_productos',
                                'cortes_caja', 'alertas', 'seguridad_riesgo')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
  if to_regclass('respaldo.fase1_politicas') is not null then
    for r in select * from respaldo.fase1_politicas loop
      execute format('create policy %I on public.%I as %s for %s to %s %s %s',
        r.policyname, r.tablename, r.permissive, r.cmd,
        (select string_agg(quote_ident(x), ', ') from unnest(r.roles) x),
        case when r.qual is not null then 'using (' || r.qual || ')' else '' end,
        case when r.with_check is not null then 'with check (' || r.with_check || ')' else '' end);
    end loop;
  end if;
end $$;

do $$
declare t text;
begin
  -- Privilegios por omisión de Supabase (lo que había antes).
  foreach t in array array['negocios', 'sucursales', 'resumen_ventas', 'tendencia_ventas', 'top_productos',
                           'cortes_caja', 'alertas', 'seguridad_riesgo', 'owner_apps', 'negocio_app_quota'] loop
    execute format('grant all on table public.%I to anon, authenticated, service_role', t);
  end loop;
end $$;

update public.license_catalog c set grants = r.grants
  from respaldo.fase1_license_catalog_grants r
 where r.code = c.code and c.grants is distinct from r.grants;

-- 3) Objetos nuevos -----------------------------------------------------------
drop trigger if exists tr_sucursales_token_legado on public.sucursales;
drop view if exists public.fase1_conciliacion;

-- wx_proyectar recibe el tipo fila de `devices`: se va antes que la tabla.
do $$ begin
  if to_regclass('public.devices') is not null then
    execute 'drop function if exists public.wx_proyectar(public.devices, text, jsonb)';
  end if;
end $$;
-- Primero las tablas: sus políticas dependen de las funciones de membresía.
drop table if exists public.fiscal_invoice_claims, public.fiscal_invoices, public.fiscal_issuer_claims, public.fiscal_issuers,
  public.notification_outbox, public.cash_movement_facts, public.shift_facts, public.sales_facts, public.sync_events,
  public.device_enrollments, public.devices, public.registers, public.employees, public.company_invites,
  public.company_memberships, public.cloud_audit, public.reconciliation_items cascade;

do $$
declare f text;
begin
  foreach f in array array[
    'wx_rol(uuid)', 'wx_es_miembro(uuid)', 'wx_puede_ubicacion(uuid)', 'mis_empresas()', 'resumen_empresa(uuid, date)',
    'company_entitlements(uuid)', 'device_autenticar(jsonb)', 'wx_emitir_dispositivo(uuid, text, uuid, jsonb)',
    'pos_bootstrap(jsonb)', 'pos_enroll(jsonb)', 'pos_whoami(jsonb)', 'wx_actor_admin(jsonb)', 'pos_create_location(jsonb)',
    'pos_create_enrollment(jsonb)', 'pos_install_secret(jsonb)', 'pos_vincular_licencia(jsonb)', 'wx_tr_token_legado()',
    'sync_ingest(jsonb)', 'membresia_crear_invitacion(jsonb)',
    'membresia_aceptar_invitacion(jsonb)', 'pos_borrar_cuenta(jsonb)', 'fiscal_autorizar(jsonb)',
    'fiscal_registrar_emisor(jsonb)', 'fiscal_persona_de_empresa(jsonb)', 'fiscal_registrar_factura(jsonb)',
    'fiscal_marcar_cancelacion(jsonb)', 'fiscal_reclamar_historico(jsonb)', 'fiscal_conciliar_emisor(jsonb)', 'fiscal_legado_libre(jsonb)', 'pos_provision_legado(jsonb)',
    'wx_audit(text, text, uuid, text, text, jsonb)', 'wx_pendiente(text, text, uuid, jsonb)'
  ] loop
    execute format('drop function if exists public.%s', f);
  end loop;
end $$;

alter table public.license_activations drop constraint if exists license_activations_kind_check;
alter table public.license_activations drop column if exists device_id, drop column if exists location_id, drop column if exists kind;
alter table public.licenses drop column if exists company_id, drop column if exists account_id;

-- Ubicaciones creadas en la Fase 1 no traen device_key: se les pone uno
-- sintético para poder restaurar el NOT NULL de antes.
update public.sucursales set device_key = 'fase1:' || id where device_key is null;
alter table public.sucursales alter column device_key set not null;
alter table public.sucursales drop constraint if exists sucursales_tipo_check, drop constraint if exists sucursales_status_check;
drop index if exists public.ux_sucursales_instance;
drop index if exists public.ux_sucursales_install_secret;
drop index if exists public.ix_sucursales_negocio;
alter table public.sucursales drop column if exists home_location_id, drop column if exists tipo, drop column if exists status,
  drop column if exists instance_uuid, drop column if exists install_secret_hash, drop column if exists starts_at,
  drop column if exists ends_at, drop column if exists timezone, drop column if exists updated_at;
alter table public.negocios drop constraint if exists negocios_status_check;
alter table public.negocios drop column if exists account_id, drop column if exists status, drop column if exists updated_at;
drop table if exists public.accounts;

drop function if exists public.wx_hash(text);
drop function if exists public.wx_token_nuevo(text);
drop function if exists public.wx_codigo_nuevo();
drop function if exists public.wx_codigo_hash(text);
drop function if exists public.wx_uuid(text);
-- La tabla respaldo.fase1_politicas y fase1_license_catalog_grants se quedan:
-- si se vuelve a aplicar la Fase 1, NO se respaldan encima (ver la migración).

commit;
