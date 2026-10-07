-- ============================================================================
--  REVERSA de 20261010120000_fase2_event_mobile.sql
-- ----------------------------------------------------------------------------
--  Solo para recuperación. NO es una migración (no va en supabase/migrations):
--  se corre a mano, con respaldo previo del proyecto, y después se despliega
--  la Edge Function pos-sync ANTERIOR (sin publish / mobile_* / transfer_inbox).
--
--  QUÉ HACE
--    1. Copia TODO lo que la Fase 2 creó a `respaldo.fase2_rb_*`: personal por
--       evento, publicaciones de catálogo, ledger, transferencias, líneas de
--       venta, versiones de apps, y las columnas nuevas (estado del evento,
--       PIN publicado, llaves de firma, huellas). Nada se pierde.
--    2. Restaura el texto EXACTO de las seis funciones de la Fase 1 que la
--       Fase 2 redefinió (respaldo.fase2_funciones_previas).
--    3. Quita funciones, vista, tablas y columnas nuevas; regresa las
--       restricciones (complementos, resultado de sync) y los privilegios de
--       la Fase 1 sobre `employees`.
--
--  EFECTOS QUE HAY QUE SABER
--    · Las tablets (MOBILE_POS) dejan de sincronizar: sus eventos quedan en su
--      outbox local y se suben cuando la Fase 2 vuelva a aplicarse.
--    · Los eventos de sync en CUARENTENA se mueven al respaldo (la restricción
--      de la Fase 1 no admite ese resultado).
--    · Las licencias pierden el complemento MOBILE_POS (queda en el respaldo).
--
--  Todo en UNA transacción: si algo falla, no queda a medias.
--  Idempotente: se puede correr dos veces.
-- ============================================================================

begin;

-- 1) Respaldo de lo nuevo -----------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['location_staff', 'catalog_publications', 'inventory_ledger', 'stock_transfers',
                           'stock_transfer_lines', 'sale_line_facts', 'app_releases'] loop
    if to_regclass('public.' || t) is not null and to_regclass('respaldo.fase2_rb_' || t) is null then
      execute format('create table respaldo.fase2_rb_%s as select * from public.%I', t, t);
    end if;
  end loop;
  if to_regclass('respaldo.fase2_rb_sucursales') is null and exists (
       select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sucursales' and column_name = 'event_status') then
    create table respaldo.fase2_rb_sucursales as
      select id, event_status, codigo, server_fingerprint, security_revision, reconciled_at, reconciliation from public.sucursales;
  end if;
  if to_regclass('respaldo.fase2_rb_employees') is null and exists (
       select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'pin_hash') then
    create table respaldo.fase2_rb_employees as
      select id, pin_hash, pin_sal, pin_algo, pin_set_at, branch_role, published_at from public.employees;
  end if;
  if to_regclass('respaldo.fase2_rb_devices') is null and exists (
       select 1 from information_schema.columns where table_schema = 'public' and table_name = 'devices' and column_name = 'signing_public_key') then
    create table respaldo.fase2_rb_devices as
      select id, signing_public_key, pending_events, last_seq, clock_skew_seconds from public.devices;
    create table respaldo.fase2_rb_device_enrollments as select id, register_id from public.device_enrollments;
    create table respaldo.fase2_rb_sales_facts as select * from public.sales_facts where catalog_version is not null or folio_text is not null or invoice_requested;
    create table respaldo.fase2_rb_sync_events as select * from public.sync_events where result = 'QUARANTINED' or local_seq is not null;
    create table respaldo.fase2_rb_licencias as select id, addons from public.licenses where 'MOBILE_POS' = any(addons);
  end if;
end $$;
revoke all on all tables in schema respaldo from anon, authenticated;

-- 2) Las funciones de la Fase 1, tal como estaban ------------------------------
do $$
declare r record;
begin
  if to_regclass('respaldo.fase2_funciones_previas') is not null then
    for r in select * from respaldo.fase2_funciones_previas loop
      execute r.definicion;
    end loop;
  end if;
end $$;

-- 3) Objetos nuevos -----------------------------------------------------------
-- wx_ledger y wx_proyectar_f2 reciben tipos fila: se van antes que sus tablas.
do $$
declare f text;
begin
  foreach f in array array[
    'wx_uuid_det(text)', 'wx_permite(uuid, text)', 'evento_cambiar_estado(jsonb)', 'evento_asignar_personal(jsonb)',
    'evento_codigo_tablet(jsonb)', 'dispositivo_revocar(jsonb)', 'pos_registrar_llave(jsonb)', 'pos_publicar(jsonb)',
    'wx_ledger(uuid, public.sucursales, uuid, uuid, text, numeric, text, uuid, uuid, uuid, text, timestamptz)',
    'wx_normalizar_evento(jsonb, text)', 'wx_proyectar_f2(public.devices, public.sucursales, jsonb, uuid)',
    'mobile_snapshot(jsonb)', 'mobile_inbox(jsonb)', 'mobile_latido(jsonb)', 'pos_transfer_inbox(jsonb)',
    'ubicacion_resolver_clon(jsonb)', 'conciliar_automatico()', 'conciliar_licencia(jsonb)', 'conciliar_owner_app(jsonb)',
    'owner_crear_evento(uuid, jsonb)', 'owner_evento_estado(uuid, uuid, text, boolean, text)',
    'owner_asignar_personal(uuid, uuid, uuid, text, boolean)', 'owner_codigo_tablet(uuid, uuid, text)',
    'owner_revocar_dispositivo(uuid, uuid)', 'owner_resolver_clon(uuid, uuid, text)', 'owner_empleados(uuid)',
    'estado_dispositivos(uuid)'
  ] loop
    begin
      execute format('drop function if exists public.%s', f);
    exception when undefined_object then null;  -- tipo fila ya inexistente en una segunda corrida
    end;
  end loop;
end $$;

drop view if exists public.location_stock;
drop table if exists public.sale_line_facts, public.stock_transfer_lines, public.stock_transfers, public.inventory_ledger,
  public.catalog_publications, public.location_staff, public.app_releases cascade;

-- Resultado de sync: la Fase 1 solo admite APPLIED / STALE / REJECTED.
delete from public.sync_events where result = 'QUARANTINED';
alter table public.sync_events drop constraint if exists sync_events_result_check;
alter table public.sync_events add constraint sync_events_result_check check (result in ('APPLIED', 'STALE', 'REJECTED'));
drop index if exists public.ix_sync_events_loc_seq;
alter table public.sync_events drop column if exists seq, drop column if exists local_seq;

alter table public.sales_facts drop column if exists catalog_version, drop column if exists folio_text, drop column if exists invoice_requested;
alter table public.devices drop column if exists signing_public_key, drop column if exists pending_events,
  drop column if exists last_seq, drop column if exists clock_skew_seconds;
alter table public.device_enrollments drop column if exists register_id;

-- Empleados: fuera el PIN publicado; de vuelta el SELECT de tabla completa de la Fase 1.
revoke select on public.employees from authenticated;
alter table public.employees drop column if exists pin_hash, drop column if exists pin_sal, drop column if exists pin_algo,
  drop column if exists pin_set_at, drop column if exists branch_role, drop column if exists published_at;
grant select on table public.employees to authenticated;

alter table public.sucursales drop constraint if exists sucursales_event_status_check;
drop index if exists public.ux_sucursales_codigo;
alter table public.sucursales drop column if exists event_status, drop column if exists codigo, drop column if exists server_fingerprint,
  drop column if exists security_revision, drop column if exists reconciled_at, drop column if exists reconciliation;

-- Complementos: solo MULTIBRANCH, como en Licenciamiento v2.
update public.licenses set addons = array_remove(addons, 'MOBILE_POS') where 'MOBILE_POS' = any(addons);
alter table public.licenses drop constraint if exists licenses_addons_check;
alter table public.licenses add constraint licenses_addons_check check (addons <@ array['MULTIBRANCH']::text[]);

-- Catálogo: fuera las claves de la Fase 2. El complemento NO se borra: su alta
-- quedó en license_catalog_price_history (auditoría, no se toca); se DESACTIVA
-- con motivo, y la migración lo reactiva solo si fue esta reversa quien lo apagó.
update public.license_catalog set grants = grants - 'temporary_locations' - 'mobile_pos_max'
 where code in ('EDITION_MONO', 'EDITION_MULTI');
select set_config('wybix.reason', 'reversa de la Fase 2', true), set_config('wybix.source', 'MIGRATION', true);
update public.license_catalog set active = false, notes = 'Retirado por la reversa de la Fase 2.'
 where code = 'ADDON_MOBILE_POS' and active;

-- respaldo.fase2_funciones_previas se queda: si la Fase 2 se vuelve a aplicar,
-- NO se respalda encima (ver la migración) y la próxima reversa sigue sirviendo.

commit;
