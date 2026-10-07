-- ============================================================================
--  FASE 2 · EVENT, WYBIX POS MOBILE, INVENTARIO POR HECHOS Y TRANSFERENCIAS
-- ----------------------------------------------------------------------------
--  Sobre la Fase 1 (empresa -> ubicación -> equipo, hechos idempotentes, RLS
--  por membresía). Agrega:
--
--    EVENT            ubicación temporal (feria) con estado
--                     PLANNED -> OPEN -> CLOSED -> RECONCILED, sucursal base,
--                     fechas, zona horaria. No tiene SQL Server: su autoridad
--                     durante el evento es la tablet (SQLite cifrado).
--    location_staff   quién trabaja en CADA evento y con qué rol (ser
--                     encargado de Centro no da permisos en la feria).
--    catalog_publications  el catálogo que publica la sucursal base, versionado.
--    inventory_ledger el inventario como hechos (TRANSFER_IN, SALE, WASTE...).
--                     Nunca se guarda "stock = 8": el stock es una vista.
--    stock_transfers  sucursal <-> evento, con lo ENVIADO y lo RECIBIDO.
--    MOBILE_POS       tablets: enrolamiento por código con caja asignada,
--                     snapshot, inbox entre tablets, latido, revocación con
--                     CUARENTENA de lo posterior (nada se borra).
--    derechos         mobile_pos, mobile_pos_max, temporary_locations y
--                     locations_max se APLICAN (antes solo se informaban).
--    app_releases     latest / min_supported por app y canal.
--    clones           huella del servidor por sucursal: una base restaurada
--                     en otro equipo no sincroniza en silencio como la original.
--    conciliación     automática solo con evidencia inequívoca + herramientas
--                     manuales (supabase/scripts/conciliar.sql).
--
--  IDEMPOTENTE, NO DESTRUCTIVA. Reversa: supabase/rollback/20261010120000_fase2_event_mobile.down.sql
-- ============================================================================

-- La Fase 2 REDEFINE seis funciones de la Fase 1. Se guarda su texto exacto
-- UNA sola vez (antes de reemplazarlas) para que la reversa las restaure tal
-- cual; aplicarla otra vez no pisa el respaldo con la versión de la Fase 2.
create table if not exists respaldo.fase2_funciones_previas (
  firma text primary key,
  definicion text not null,
  guardada_en timestamptz not null default now()
);
revoke all on respaldo.fase2_funciones_previas from anon, authenticated;
insert into respaldo.fase2_funciones_previas (firma, definicion)
select p.oid::regprocedure::text, pg_get_functiondef(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('company_entitlements', 'pos_create_location', 'device_autenticar', 'sync_ingest', 'pos_enroll', 'resumen_empresa')
   and not exists (select 1 from pg_proc x where x.proname = 'wx_proyectar_f2')
on conflict (firma) do nothing;

-- ============================================================================
--  1. EVENT
-- ============================================================================
alter table public.sucursales add column if not exists event_status text;
alter table public.sucursales add column if not exists codigo text;
alter table public.sucursales add column if not exists server_fingerprint text;
alter table public.sucursales add column if not exists security_revision int not null default 1;
alter table public.sucursales add column if not exists reconciled_at timestamptz;
alter table public.sucursales add column if not exists reconciliation jsonb;

-- Los EVENT que ya existían (creados en Fase 1) nacen PLANNED y ACTIVOS.
update public.sucursales set event_status = 'PLANNED', status = case when status = 'PENDING' then 'ACTIVE' else status end
 where tipo = 'EVENT' and event_status is null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sucursales_event_status_check') then
    alter table public.sucursales add constraint sucursales_event_status_check
      check ((tipo = 'EVENT' and event_status in ('PLANNED', 'OPEN', 'CLOSED', 'RECONCILED')) or (tipo <> 'EVENT' and event_status is null));
  end if;
end $$;
create unique index if not exists ux_sucursales_codigo on public.sucursales (negocio_id, codigo) where codigo is not null;

-- ============================================================================
--  2. PERSONAL POR EVENTO (+ PIN publicado por la sucursal)
-- ============================================================================
alter table public.employees add column if not exists pin_hash text;
alter table public.employees add column if not exists pin_sal text;
alter table public.employees add column if not exists pin_algo text;
alter table public.employees add column if not exists pin_set_at timestamptz;
alter table public.employees add column if not exists branch_role text;
alter table public.employees add column if not exists published_at timestamptz;

create table if not exists public.location_staff (
  location_id uuid not null references public.sucursales(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  company_id uuid not null references public.negocios(id) on delete cascade,
  role text not null check (role in ('CASHIER', 'SUPERVISOR', 'ADMIN')),
  active boolean not null default true,
  assigned_by uuid,
  updated_at timestamptz not null default now(),
  primary key (location_id, employee_id)
);

-- ============================================================================
--  3. CATÁLOGO PUBLICADO POR LA SUCURSAL
-- ============================================================================
create table if not exists public.catalog_publications (
  id bigserial primary key,
  location_id uuid not null references public.sucursales(id) on delete cascade,
  company_id uuid not null references public.negocios(id) on delete cascade,
  version int not null,
  content_hash text not null,
  payload jsonb not null,
  published_at timestamptz not null default now(),
  published_by_device uuid,
  unique (location_id, version),
  unique (location_id, content_hash)
);

-- ============================================================================
--  4. INVENTARIO POR HECHOS Y TRANSFERENCIAS
-- ============================================================================
create table if not exists public.inventory_ledger (
  movement_uuid uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid not null references public.sucursales(id) on delete cascade,
  product_uuid uuid not null,
  type text not null check (type in ('TRANSFER_IN','SALE','SALE_RETURN','CONSUMPTION','WASTE','ADJUSTMENT','RETURN_TRANSFER_OUT','TRANSFER_OUT','RETURN_TRANSFER_IN')),
  quantity numeric(14, 2) not null,
  ref_type text,
  ref_uuid uuid,
  device_id uuid references public.devices(id) on delete set null,
  event_uuid uuid,
  reason text,
  occurred_at timestamptz,
  received_at timestamptz not null default now()
);
create index if not exists ix_ledger_loc_prod on public.inventory_ledger (location_id, product_uuid);

/* El stock es una VISTA de los hechos (con signo). */
create or replace view public.location_stock as
  select company_id, location_id, product_uuid,
         sum(case when type in ('TRANSFER_IN', 'SALE_RETURN', 'RETURN_TRANSFER_IN') then quantity
                  when type = 'ADJUSTMENT' then quantity
                  else -quantity end) as qty
    from public.inventory_ledger
   group by company_id, location_id, product_uuid;

create table if not exists public.stock_transfers (
  transfer_uuid uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  kind text not null check (kind in ('OUT', 'RETURN')),
  from_location_id uuid not null references public.sucursales(id) on delete cascade,
  to_location_id uuid not null references public.sucursales(id) on delete cascade,
  status text not null check (status in ('SENT', 'RECEIVED', 'CANCELLED')),
  signature text,
  branch_confirmed boolean not null default false,
  sent_at timestamptz,
  received_at timestamptz,
  origin_device uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.stock_transfer_lines (
  transfer_uuid uuid not null references public.stock_transfers(transfer_uuid) on delete cascade,
  product_uuid uuid not null,
  product_name text,
  qty_sent numeric(14, 2) not null,
  qty_received numeric(14, 2),
  claimed_sent numeric(14, 2),             -- lo que dijo la otra parte, si difiere (evidencia)
  primary key (transfer_uuid, product_uuid)
);

create table if not exists public.sale_line_facts (
  sale_uuid uuid not null references public.sales_facts(sale_uuid) on delete cascade,
  line_no int not null,
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid not null references public.sucursales(id) on delete cascade,
  product_uuid uuid not null,
  product_name text,
  quantity numeric(14, 2) not null,
  unit_price numeric(14, 2) not null,
  unit_cost numeric(14, 4),
  catalog_version int,
  primary key (sale_uuid, line_no)
);

alter table public.sales_facts add column if not exists catalog_version int;
alter table public.sales_facts add column if not exists folio_text text;
alter table public.sales_facts add column if not exists invoice_requested boolean not null default false;

-- ============================================================================
--  5. TABLETS (MOBILE_POS): caja, llave de firma, latido, cuarentena
-- ============================================================================
alter table public.devices add column if not exists signing_public_key text;
alter table public.devices add column if not exists pending_events int;
alter table public.devices add column if not exists last_seq bigint;
alter table public.devices add column if not exists clock_skew_seconds int;
alter table public.device_enrollments add column if not exists register_id uuid references public.registers(id) on delete set null;

alter table public.sync_events add column if not exists seq bigserial;
alter table public.sync_events add column if not exists local_seq bigint;
alter table public.sync_events drop constraint if exists sync_events_result_check;
alter table public.sync_events add constraint sync_events_result_check check (result in ('APPLIED', 'STALE', 'REJECTED', 'QUARANTINED'));
create unique index if not exists ux_sync_events_seq on public.sync_events (seq);
create index if not exists ix_sync_events_loc_seq on public.sync_events (location_id, seq);

-- ============================================================================
--  6. VERSIONES DE LAS APPS
-- ============================================================================
create table if not exists public.app_releases (
  app text not null,
  channel text not null,
  latest_version text not null,
  min_supported_version text not null,
  notes text,
  published_at timestamptz not null default now(),
  primary key (app, channel)
);
insert into public.app_releases (app, channel, latest_version, min_supported_version, notes)
values ('pos-mobile', 'production', '0.1.0', '0.1.0', 'Primera versión de Wybix POS Mobile.')
on conflict (app, channel) do nothing;

-- ============================================================================
--  7. DERECHOS (catálogo de licencias: claves nuevas, sin precios)
-- ============================================================================
-- El complemento MOBILE_POS se puede asignar a una licencia (antes solo MULTIBRANCH).
alter table public.licenses drop constraint if exists licenses_addons_check;
alter table public.licenses add constraint licenses_addons_check check (addons <@ array['MULTIBRANCH', 'MOBILE_POS']::text[]);

insert into respaldo.fase1_license_catalog_grants (code, grants)
select code, grants from public.license_catalog where code in ('EDITION_MONO', 'EDITION_MULTI')
on conflict (code) do nothing;
update public.license_catalog c
   set grants = jsonb_build_object('temporary_locations', false, 'mobile_pos_max', 0) || c.grants
 where c.code in ('EDITION_MONO', 'EDITION_MULTI') and not (c.grants ? 'temporary_locations');
insert into public.license_catalog (code, kind, label, description, edition, vertical, grants, list_price, reference_price, billing, sort, notes)
select 'ADDON_MOBILE_POS', 'ADDON', 'Wybix POS Mobile y eventos',
       'Ubicaciones temporales (ferias) y una tablet que vende sin Internet.', null, null,
       '{"addon":"MOBILE_POS","mobile_pos":true,"mobile_pos_max":1,"temporary_locations":true,"entitlements":["mobile_pos","temporary_locations"]}',
       null, null, null, 71, 'Precio por definir.'
 where not exists (select 1 from public.license_catalog where code = 'ADDON_MOBILE_POS');
-- Si una reversa lo apagó, vuelve (solo ese caso: un apagado a mano se respeta).
update public.license_catalog set active = true, notes = 'Precio por definir.'
 where code = 'ADDON_MOBILE_POS' and not active and notes = 'Retirado por la reversa de la Fase 2.';

-- ============================================================================
--  8. DERECHOS: se calculan Y SE APLICAN
-- ============================================================================
create or replace function public.wx_uuid_det(p text)
returns uuid language sql immutable set search_path = public as $$ select md5(p)::uuid $$;

/* Derechos de la EMPRESA: suma de sus licencias activas (edición + complementos).
   null = sin límite. `enforced`: desde la Fase 2 se aplican al crear y enrolar;
   perder un derecho nunca borra nada, solo impide acciones NUEVAS. */
create or replace function public.company_entitlements(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record; a record; g jsonb; n int := 0;
        loc_max int := 0; loc_inf boolean := false; reg_max int := 0; reg_inf boolean := false;
        mob boolean := false; mob_max int := 0; mob_inf boolean := false; temp boolean := false; comp_max int := 1; v_reg int;
begin
  for r in select x.* from public.licenses x where x.company_id = p_company and x.status = 'activa' loop
    n := n + 1;
    g := coalesce((select grants from public.license_catalog where code = case when r.plan = 'multi' then 'EDITION_MULTI' else 'EDITION_MONO' end), '{}');
    for a in select c.grants from public.license_catalog c where c.code in (select 'ADDON_' || u from unnest(coalesce(r.addons, '{}')) u) loop
      g := g || a.grants;
    end loop;
    if g ? 'locations_max' and jsonb_typeof(g->'locations_max') = 'null' then loc_inf := true;
    else loc_max := loc_max + coalesce((g->>'locations_max')::int, 1); end if;
    v_reg := public.license_registers_max(r.plan);
    if v_reg is null then reg_inf := true; else reg_max := reg_max + v_reg; end if;
    if coalesce((g->>'mobile_pos')::boolean, false) then
      mob := true;
      if g ? 'mobile_pos_max' and jsonb_typeof(g->'mobile_pos_max') = 'null' then mob_inf := true;
      else mob_max := mob_max + coalesce((g->>'mobile_pos_max')::int, 0); end if;
    end if;
    temp := temp or coalesce((g->>'temporary_locations')::boolean, false);
    comp_max := greatest(comp_max, coalesce((g->>'companies_max')::int, 1));
  end loop;
  return jsonb_build_object(
    'licenses', n, 'enforced', true,
    'companies_max', case when n = 0 then null else comp_max end,
    'locations_max', case when n = 0 or loc_inf then null else loc_max end,
    'registers_max', case when n = 0 or reg_inf then null else reg_max end,
    'operational_screens_max', null,
    'mobile_pos', mob,
    'mobile_pos_max', case when not mob then 0 when mob_inf then null else mob_max end,
    'temporary_locations', temp,
    'locations_used', (select count(*) from public.sucursales s where s.negocio_id = p_company and s.tipo = 'BRANCH' and s.status in ('ACTIVE', 'PENDING')),
    'mobile_pos_used', (select count(*) from public.devices d where d.company_id = p_company and d.kind = 'MOBILE_POS' and d.status = 'ACTIVE'),
    'events_open', (select count(*) from public.sucursales s where s.negocio_id = p_company and s.tipo = 'EVENT' and s.event_status in ('PLANNED', 'OPEN')));
end $$;

/* ¿Se permite una acción NUEVA? null = sí; si no, el código del motivo. */
create or replace function public.wx_permite(p_company uuid, p_accion text)
returns text language plpgsql stable security definer set search_path = public as $$
declare e jsonb := public.company_entitlements(p_company);
begin
  if p_accion = 'CREATE_BRANCH' then
    if (e->>'licenses')::int = 0 then return 'NO_LICENSE'; end if;
    if e->>'locations_max' is not null and (e->>'locations_used')::int >= (e->>'locations_max')::int then return 'LIMIT_LOCATIONS'; end if;
  elsif p_accion = 'CREATE_EVENT' then
    if not (e->>'temporary_locations')::boolean then return 'NO_ENTITLEMENT_TEMPORARY_LOCATIONS'; end if;
  elsif p_accion = 'ENROLL_MOBILE' then
    if not (e->>'mobile_pos')::boolean then return 'NO_ENTITLEMENT_MOBILE_POS'; end if;
    if e->>'mobile_pos_max' is not null and (e->>'mobile_pos_used')::int >= (e->>'mobile_pos_max')::int then return 'LIMIT_MOBILE_POS'; end if;
  end if;
  return null;
end $$;

-- ============================================================================
--  9. UBICACIONES: BRANCH con límite, EVENT con derecho y estado
-- ============================================================================
create or replace function public.pos_create_location(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wx_actor_admin(p); v_tipo text := upper(coalesce(nullif(p->>'tipo', ''), 'BRANCH'));
        v_loc uuid; v_code text := public.wx_codigo_nuevo(); v_home uuid := public.wx_uuid(p->>'home_location_id');
        v_company uuid; v_permiso text; v_tz text; v_home_tipo text;
begin
  if a is null then
    perform public.wx_audit('UNKNOWN', coalesce(p->>'device_id', p->>'user_id'), public.wx_uuid(p->>'company_id'), 'CREATE_LOCATION', 'DENIED', '{}');
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;
  v_company := (a->>'company_id')::uuid;
  if v_tipo in ('WAREHOUSE', 'MOBILE') then return jsonb_build_object('ok', false, 'code', 'RESERVED_TYPE'); end if;
  if v_tipo not in ('BRANCH', 'EVENT') then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  if coalesce(trim(p->>'nombre'), '') = '' then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  if v_home is not null then
    select tipo, timezone into v_home_tipo, v_tz from public.sucursales where id = v_home and negocio_id = v_company;
    if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  end if;

  v_permiso := public.wx_permite(v_company, case when v_tipo = 'EVENT' then 'CREATE_EVENT' else 'CREATE_BRANCH' end);
  if v_permiso is not null then
    perform public.wx_audit(a->>'kind', a->>'id', v_company, 'CREATE_LOCATION', 'DENIED', jsonb_build_object('code', v_permiso, 'tipo', v_tipo));
    return jsonb_build_object('ok', false, 'code', v_permiso, 'entitlements', public.company_entitlements(v_company));
  end if;

  if v_tipo = 'EVENT' then
    -- Un EVENT vive de su sucursal base: su catálogo, su personal, su mercancía.
    if v_home is null or v_home_tipo <> 'BRANCH' then return jsonb_build_object('ok', false, 'code', 'HOME_REQUIRED'); end if;
    insert into public.sucursales (negocio_id, nombre, tipo, status, event_status, starts_at, ends_at, home_location_id, timezone, codigo)
    values (v_company, left(trim(p->>'nombre'), 120), 'EVENT', 'ACTIVE', 'PLANNED',
            nullif(p->>'starts_at', '')::timestamptz, nullif(p->>'ends_at', '')::timestamptz, v_home,
            coalesce(nullif(p->>'timezone', ''), v_tz, 'America/Mexico_City'), nullif(upper(trim(coalesce(p->>'codigo', ''))), ''))
    returning id into v_loc;
    perform public.wx_audit(a->>'kind', a->>'id', v_company, 'CREATE_LOCATION', 'OK', jsonb_build_object('location_id', v_loc, 'tipo', 'EVENT'));
    return jsonb_build_object('ok', true, 'location_id', v_loc, 'company_id', v_company, 'tipo', 'EVENT', 'event_status', 'PLANNED',
                              'entitlements', public.company_entitlements(v_company));
  end if;

  insert into public.sucursales (negocio_id, nombre, tipo, status, starts_at, ends_at, home_location_id)
  values (v_company, left(trim(p->>'nombre'), 120), 'BRANCH', 'PENDING', null, null, null)
  returning id into v_loc;
  insert into public.device_enrollments (company_id, location_id, purpose, kinds, code_hash, expires_at, created_by_device, created_by_user)
  values (v_company, v_loc, 'CLAIM_LOCATION', array['POS_PRIMARY'], public.wx_codigo_hash(v_code), now() + interval '72 hours',
          case when a->>'kind' = 'DEVICE' then (a->>'id')::uuid end, case when a->>'kind' = 'USER' then (a->>'id')::uuid end);
  perform public.wx_audit(a->>'kind', a->>'id', v_company, 'CREATE_LOCATION', 'OK', jsonb_build_object('location_id', v_loc, 'tipo', 'BRANCH'));
  return jsonb_build_object('ok', true, 'location_id', v_loc, 'company_id', v_company, 'code', v_code,
                            'expires_at', now() + interval '72 hours', 'entitlements', public.company_entitlements(v_company));
end $$;

/*
 * Estado de un EVENT:  PLANNED -> OPEN -> CLOSED -> RECONCILED  (CLOSED -> OPEN reabre).
 * RECONCILED exige: sin turnos abiertos, sin transferencias en tránsito, y
 * el inventario del evento en cero (o `forzar` con motivo: el faltante o
 * sobrante queda registrado, no se esconde).
 */
create or replace function public.evento_cambiar_estado(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wx_actor_admin(p); s public.sucursales%rowtype; v_nuevo text := upper(coalesce(p->>'status', ''));
        v_resto jsonb; v_transito int; v_turnos int;
begin
  if a is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  select * into s from public.sucursales where id = public.wx_uuid(p->>'location_id') and negocio_id = (a->>'company_id')::uuid for update;
  if not found or s.tipo <> 'EVENT' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if not ((s.event_status = 'PLANNED' and v_nuevo = 'OPEN') or (s.event_status = 'OPEN' and v_nuevo = 'CLOSED')
          or (s.event_status = 'CLOSED' and v_nuevo in ('OPEN', 'RECONCILED'))) then
    return jsonb_build_object('ok', false, 'code', 'BAD_TRANSITION', 'from', s.event_status, 'to', v_nuevo);
  end if;
  if v_nuevo = 'RECONCILED' then
    select count(*) into v_turnos from public.shift_facts where location_id = s.id and status = 'OPEN';
    select count(*) into v_transito from public.stock_transfers where (from_location_id = s.id or to_location_id = s.id) and status = 'SENT';
    select coalesce(jsonb_agg(jsonb_build_object('product_uuid', product_uuid, 'qty', qty)), '[]') into v_resto
      from public.location_stock where location_id = s.id and qty <> 0;
    if v_turnos > 0 then return jsonb_build_object('ok', false, 'code', 'SHIFTS_OPEN'); end if;
    if v_transito > 0 then return jsonb_build_object('ok', false, 'code', 'TRANSFERS_IN_TRANSIT'); end if;
    if jsonb_array_length(v_resto) > 0 and not coalesce((p->>'forzar')::boolean, false) then
      return jsonb_build_object('ok', false, 'code', 'STOCK_NOT_ZERO', 'stock', v_resto);
    end if;
    update public.sucursales set event_status = 'RECONCILED', reconciled_at = now(),
           reconciliation = jsonb_build_object('stock', v_resto, 'motivo', p->>'motivo', 'por', a->>'id'), updated_at = now()
     where id = s.id;
  else
    update public.sucursales set event_status = v_nuevo, updated_at = now() where id = s.id;
  end if;
  perform public.wx_audit(a->>'kind', a->>'id', s.negocio_id, 'EVENT_STATUS', 'OK', jsonb_build_object('location_id', s.id, 'from', s.event_status, 'to', v_nuevo));
  return jsonb_build_object('ok', true, 'event_status', v_nuevo);
end $$;

/* Quién trabaja en el EVENT y con qué rol. */
create or replace function public.evento_asignar_personal(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wx_actor_admin(p); s public.sucursales%rowtype; e public.employees%rowtype; v_role text := upper(coalesce(p->>'role', 'CASHIER'));
begin
  if a is null or v_role not in ('CASHIER', 'SUPERVISOR', 'ADMIN') then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  select * into s from public.sucursales where id = public.wx_uuid(p->>'location_id') and negocio_id = (a->>'company_id')::uuid;
  if not found or s.tipo <> 'EVENT' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  select * into e from public.employees where id = public.wx_uuid(p->>'employee_id') and company_id = s.negocio_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  insert into public.location_staff (location_id, employee_id, company_id, role, active, assigned_by)
  values (s.id, e.id, s.negocio_id, v_role, coalesce((p->>'active')::boolean, true), public.wx_uuid(a->>'id'))
  on conflict (location_id, employee_id) do update set role = excluded.role, active = excluded.active, assigned_by = excluded.assigned_by, updated_at = now();
  update public.sucursales set security_revision = security_revision + 1 where id = s.id;
  perform public.wx_audit(a->>'kind', a->>'id', s.negocio_id, 'EVENT_STAFF', 'OK', jsonb_build_object('location_id', s.id, 'employee_id', e.id, 'role', v_role));
  return jsonb_build_object('ok', true, 'has_pin', e.pin_hash is not null);
end $$;

/* Código para enrolar UNA tablet en un EVENT, con su caja. Aplica derechos. */
create or replace function public.evento_codigo_tablet(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wx_actor_admin(p); s public.sucursales%rowtype; v_permiso text; v_code text := public.wx_codigo_nuevo();
        v_reg uuid; v_n int; v_codigo text;
begin
  if a is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  select * into s from public.sucursales where id = public.wx_uuid(p->>'location_id') and negocio_id = (a->>'company_id')::uuid;
  if not found or s.tipo <> 'EVENT' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if s.event_status not in ('PLANNED', 'OPEN') then return jsonb_build_object('ok', false, 'code', 'EVENT_NOT_OPEN'); end if;
  v_permiso := public.wx_permite(s.negocio_id, 'ENROLL_MOBILE');
  if v_permiso is not null then
    perform public.wx_audit(a->>'kind', a->>'id', s.negocio_id, 'MOBILE_CODE', 'DENIED', jsonb_build_object('code', v_permiso));
    return jsonb_build_object('ok', false, 'code', v_permiso, 'entitlements', public.company_entitlements(s.negocio_id));
  end if;
  select count(*) + 1 into v_n from public.registers where location_id = s.id;
  v_codigo := 'F' || v_n;
  insert into public.registers (company_id, location_id, register_uuid, code, name)
  values (s.negocio_id, s.id, gen_random_uuid(), v_codigo, coalesce(nullif(trim(p->>'register_name'), ''), 'Caja ' || v_codigo))
  returning id into v_reg;
  insert into public.device_enrollments (company_id, location_id, purpose, kinds, code_hash, expires_at, created_by_device, created_by_user, register_id)
  values (s.negocio_id, s.id, 'ENROLL_DEVICE', array['MOBILE_POS'], public.wx_codigo_hash(v_code), now() + interval '24 hours',
          case when a->>'kind' = 'DEVICE' then (a->>'id')::uuid end, case when a->>'kind' = 'USER' then (a->>'id')::uuid end, v_reg);
  perform public.wx_audit(a->>'kind', a->>'id', s.negocio_id, 'MOBILE_CODE', 'OK', jsonb_build_object('location_id', s.id, 'register', v_codigo));
  return jsonb_build_object('ok', true, 'code', v_code, 'expires_at', now() + interval '24 hours',
    'register', (select jsonb_build_object('id', r.id, 'uuid', r.register_uuid, 'code', r.code, 'name', r.name) from public.registers r where r.id = v_reg));
end $$;

/* Dar de baja un equipo. Una tablet conserva su credencial SOLO para entregar
   lo pendiente: la nube acepta lo anterior a la baja y pone en cuarentena lo
   posterior. Nunca más recibe maestros. */
create or replace function public.dispositivo_revocar(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wx_actor_admin(p); d public.devices%rowtype;
begin
  if a is null or a->>'kind' <> 'USER' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  -- El equipo a dar de baja va en `target_device_id`: `device_id` identifica a QUIEN actúa.
  select * into d from public.devices where id = public.wx_uuid(p->>'target_device_id') and company_id = (a->>'company_id')::uuid for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  update public.devices set status = 'REVOKED', revoked_at = coalesce(revoked_at, now()),
         credential_hash = case when kind = 'MOBILE_POS' then credential_hash else null end
   where id = d.id;
  perform public.wx_audit('USER', a->>'id', d.company_id, 'DEVICE_REVOKED', 'OK', jsonb_build_object('device_id', d.id, 'kind', d.kind));
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================================
--  10. AUTENTICACIÓN DE EQUIPOS (tablet revocada: solo para entregar)
-- ============================================================================
create or replace function public.device_autenticar(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; v_hash text := public.wx_hash(p->>'token');
begin
  if length(coalesce(p->>'token', '')) < 20 then return jsonb_build_object('ok', false, 'code', 'NO_TOKEN'); end if;
  select * into d from public.devices
   where credential_hash = v_hash and (status = 'ACTIVE' or (status = 'REVOKED' and kind = 'MOBILE_POS'));
  if not found then return jsonb_build_object('ok', false, 'code', 'BAD_TOKEN'); end if;
  update public.devices set last_seen_at = now(),
         app_version = coalesce(nullif(p->>'app_version', ''), app_version)
   where id = d.id;
  return jsonb_build_object('ok', true, 'device_id', d.id, 'company_id', d.company_id, 'location_id', d.location_id,
                            'kind', d.kind, 'legacy', d.legacy_token, 'revoked', d.status = 'REVOKED', 'register_id', d.register_id);
end $$;

create or replace function public.pos_registrar_llave(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; v_k text := p->>'public_key';
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE' and kind = 'POS_PRIMARY';
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if v_k is null or v_k !~ '^[A-Za-z0-9_-]{43}$' then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  update public.devices set signing_public_key = v_k where id = d.id;
  perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'SIGNING_KEY', 'OK', '{}');
  return jsonb_build_object('ok', true, 'key_id', d.id);
end $$;

-- ============================================================================
--  11. PUBLICACIÓN DE LA SUCURSAL: catálogo y personal con PIN
-- ============================================================================
create or replace function public.pos_publicar(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; v_hash text; v_ver int; e jsonb; v_cambio boolean := false; v_n int := 0; v_prev public.employees%rowtype;
        v_uuids uuid[] := '{}';
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE' and kind = 'POS_PRIMARY';
  if not found or (select tipo from public.sucursales where id = d.location_id) <> 'BRANCH' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;

  if jsonb_typeof(p->'catalog') = 'object' then
    v_hash := md5((p->'catalog')::text);
    select version into v_ver from public.catalog_publications where location_id = d.location_id and content_hash = v_hash;
    if v_ver is null then
      select coalesce(max(version), 0) + 1 into v_ver from public.catalog_publications where location_id = d.location_id;
      insert into public.catalog_publications (location_id, company_id, version, content_hash, payload, published_by_device)
      values (d.location_id, d.company_id, v_ver, v_hash, p->'catalog', d.id);
    end if;
  end if;

  if jsonb_typeof(p->'staff') = 'array' then
    for e in select * from jsonb_array_elements(p->'staff') loop
      continue when public.wx_uuid(e->>'uuid') is null;
      v_uuids := v_uuids || public.wx_uuid(e->>'uuid');
      select * into v_prev from public.employees where company_id = d.company_id and pos_user_uuid = public.wx_uuid(e->>'uuid');
      if not found or v_prev.pin_hash is distinct from (e->>'pin_hash') or v_prev.display_name is distinct from (e->>'name') then v_cambio := true; end if;
      insert into public.employees (company_id, pos_user_uuid, display_name, home_location_id, branch_role, pin_hash, pin_sal, pin_algo, pin_set_at, published_at)
      values (d.company_id, public.wx_uuid(e->>'uuid'), e->>'name', d.location_id, e->>'branch_role', e->>'pin_hash', e->>'pin_sal',
              coalesce(e->>'pin_algo', 'scrypt:16384:8:1:32'), nullif(e->>'pin_set_at', '')::timestamptz, now())
      on conflict (company_id, pos_user_uuid) do update set display_name = excluded.display_name, branch_role = excluded.branch_role,
        pin_hash = excluded.pin_hash, pin_sal = excluded.pin_sal, pin_algo = excluded.pin_algo, pin_set_at = excluded.pin_set_at,
        published_at = now(), status = 'ACTIVE', last_seen_at = now();
      v_n := v_n + 1;
    end loop;
    -- Quien ya no tiene PIN (o se dio de baja) en la sucursal deja de poder entrar en los eventos.
    update public.employees set pin_hash = null, pin_sal = null
     where company_id = d.company_id and home_location_id = d.location_id and pin_hash is not null and not (pos_user_uuid = any (v_uuids));
    if found then v_cambio := true; end if;
    if v_cambio then
      update public.sucursales set security_revision = security_revision + 1 where negocio_id = d.company_id and tipo = 'EVENT';
    end if;
  end if;
  return jsonb_build_object('ok', true, 'catalog_version', v_ver, 'staff', v_n);
end $$;

-- ============================================================================
--  12. INGESTA DE HECHOS (Fase 2): tablets, transferencias, cuarentena, clones
-- ============================================================================
/* Un movimiento de inventario a la bitácora (idempotente por su UUID). */
create or replace function public.wx_ledger(p_company uuid, p_loc public.sucursales, p_mov uuid, p_prod uuid, p_type text, p_qty numeric,
  p_ref_type text, p_ref uuid, p_device uuid, p_event uuid, p_reason text, p_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare v_dueno uuid;
begin
  if p_mov is null or p_prod is null or p_qty is null then raise exception 'WX_REJECT: movimiento incompleto'; end if;
  if p_loc.tipo = 'EVENT' and p_type not in ('TRANSFER_IN','SALE','SALE_RETURN','CONSUMPTION','WASTE','ADJUSTMENT','RETURN_TRANSFER_OUT') then
    raise exception 'WX_REJECT: % no corresponde a un evento', p_type; end if;
  if p_loc.tipo = 'BRANCH' and p_type not in ('TRANSFER_OUT', 'RETURN_TRANSFER_IN') then
    raise exception 'WX_REJECT: % no corresponde a una sucursal', p_type; end if;
  if p_type = 'ADJUSTMENT' then if p_qty = 0 then raise exception 'WX_REJECT: ajuste en cero'; end if;
  elsif p_qty <= 0 then raise exception 'WX_REJECT: cantidad no válida'; end if;
  select company_id into v_dueno from public.inventory_ledger where movement_uuid = p_mov;
  if v_dueno is not null and v_dueno <> p_company then raise exception 'WX_REJECT: movimiento ajeno'; end if;
  insert into public.inventory_ledger (movement_uuid, company_id, location_id, product_uuid, type, quantity, ref_type, ref_uuid, device_id, event_uuid, reason, occurred_at)
  values (p_mov, p_company, p_loc.id, p_prod, p_type, p_qty, p_ref_type, p_ref, p_device, p_event, p_reason, p_at)
  on conflict (movement_uuid) do nothing;
end $$;

/* Hechos de la tablet en la forma que espera el proyector de la Fase 1, sin
   tocarlo: los turnos traen instantes (opened_at) y él usa hora local; el
   folio de la tablet es texto. */
create or replace function public.wx_normalizar_evento(ev jsonb, p_tz text)
returns jsonb language plpgsql immutable set search_path = public as $$
declare pl jsonb := ev->'payload';
begin
  if ev->>'aggregate_type' = 'SHIFT' and pl ? 'opened_at' and not (pl ? 'opened_local') then
    pl := pl || jsonb_build_object('opened_local', to_char((pl->>'opened_at')::timestamptz at time zone p_tz, 'YYYY-MM-DD"T"HH24:MI:SS'));
    if nullif(pl->>'closed_at', '') is not null then
      pl := pl || jsonb_build_object('closed_local', to_char((pl->>'closed_at')::timestamptz at time zone p_tz, 'YYYY-MM-DD"T"HH24:MI:SS'));
    end if;
  end if;
  -- El folio de la tablet es de texto ("F1-000123"); el de Windows es número.
  if ev->>'aggregate_type' = 'SALE' and nullif(pl->>'folio', '') is not null and (pl->>'folio') !~ '^\d+$' then
    pl := pl || jsonb_build_object('folio_text', pl->>'folio', 'folio', null);
  end if;
  return jsonb_set(ev, '{payload}', pl);
end $$;

/* Lo nuevo de la Fase 2 sobre un hecho ya validado. Rechaza con WX_REJECT. */
create or replace function public.wx_proyectar_f2(d public.devices, v_loc public.sucursales, ev jsonb, p_event uuid)
returns text language plpgsql security definer set search_path = public as $$
declare t text := ev->>'aggregate_type'; et text := ev->>'event_type'; pl jsonb := ev->'payload';
        agg uuid := public.wx_uuid(ev->>'aggregate_uuid'); v_at timestamptz := (ev->>'occurred_at')::timestamptz;
        m jsonb; l jsonb; v_tr public.stock_transfers%rowtype; v_otro uuid; v_tipo_otro text; v_line public.stock_transfer_lines%rowtype;
begin
  if t = 'SALE' then
    if pl ? 'lines' then
      update public.sales_facts set catalog_version = (pl->>'catalog_version')::int, folio_text = coalesce(pl->>'folio_text', pl->>'folio'),
             invoice_requested = coalesce((pl->>'invoice_requested')::boolean, false)
       where sale_uuid = agg and company_id = d.company_id;
      for l in select * from jsonb_array_elements(pl->'lines') loop
        insert into public.sale_line_facts (sale_uuid, line_no, company_id, location_id, product_uuid, product_name, quantity, unit_price, unit_cost, catalog_version)
        values (agg, (l->>'line_no')::int, d.company_id, d.location_id, public.wx_uuid(l->>'product_uuid'), l->>'product_name',
                (l->>'quantity')::numeric, (l->>'unit_price')::numeric, (l->>'unit_cost')::numeric, (pl->>'catalog_version')::int)
        on conflict (sale_uuid, line_no) do nothing;
      end loop;
    end if;
    for m in select * from jsonb_array_elements(coalesce(pl->'movements', '[]')) loop
      perform public.wx_ledger(d.company_id, v_loc, public.wx_uuid(m->>'uuid'), public.wx_uuid(m->>'product_uuid'), m->>'type', (m->>'quantity')::numeric,
                               'SALE', agg, d.id, p_event, null, v_at);
    end loop;

  elsif t = 'INVENTORY_MOVEMENT' then
    m := pl->'movement';
    if coalesce(m->>'type', '') not in ('WASTE', 'ADJUSTMENT') then raise exception 'WX_REJECT: movimiento manual no válido'; end if;
    perform public.wx_ledger(d.company_id, v_loc, public.wx_uuid(m->>'uuid'), public.wx_uuid(m->>'product_uuid'), m->>'type', (m->>'quantity')::numeric,
                             m->>'type', agg, d.id, p_event, m->>'reason', v_at);

  elsif t = 'TRANSFER' and v_loc.tipo = 'BRANCH' then
    if et = 'TRANSFER_SENT' or (et = 'TRANSFER_RECEIVED' and pl->>'kind' = 'OUT') then
      v_otro := public.wx_uuid(pl->>'event_location_uuid');
      select tipo into v_tipo_otro from public.sucursales where id = v_otro and negocio_id = d.company_id;
      if v_tipo_otro is distinct from 'EVENT' then raise exception 'WX_REJECT: el destino no es un evento de esta empresa'; end if;
      select * into v_tr from public.stock_transfers where transfer_uuid = agg;
      if found and (v_tr.company_id <> d.company_id or v_tr.from_location_id <> v_loc.id or v_tr.kind <> 'OUT') then
        raise exception 'WX_REJECT: transferencia ajena'; end if;
      insert into public.stock_transfers (transfer_uuid, company_id, kind, from_location_id, to_location_id, status, signature, sent_at, origin_device, branch_confirmed)
      values (agg, d.company_id, 'OUT', v_loc.id, v_otro, 'SENT', pl->>'signature', v_at, d.id, et = 'TRANSFER_RECEIVED')
      on conflict (transfer_uuid) do update set signature = coalesce(excluded.signature, stock_transfers.signature),
        branch_confirmed = stock_transfers.branch_confirmed or excluded.branch_confirmed, updated_at = now();
      for l in select * from jsonb_array_elements(coalesce(pl->'lines', '[]')) loop
        -- La sucursal es la autoridad de lo ENVIADO; si la tablet dijo otra cosa, queda como evidencia.
        insert into public.stock_transfer_lines (transfer_uuid, product_uuid, product_name, qty_sent)
        values (agg, public.wx_uuid(l->>'product_uuid'), l->>'product_name', (l->>'qty_sent')::numeric)
        on conflict (transfer_uuid, product_uuid) do update set
          claimed_sent = case when stock_transfer_lines.qty_sent <> excluded.qty_sent then stock_transfer_lines.qty_sent else stock_transfer_lines.claimed_sent end,
          qty_sent = excluded.qty_sent, product_name = coalesce(stock_transfer_lines.product_name, excluded.product_name);
        perform public.wx_ledger(d.company_id, v_loc, public.wx_uuid_det('TRANSFER_OUT|' || agg || '|' || (l->>'product_uuid')), public.wx_uuid(l->>'product_uuid'),
                                 'TRANSFER_OUT', (l->>'qty_sent')::numeric, 'TRANSFER', agg, d.id, p_event, null, v_at);
      end loop;
    elsif et = 'RETURN_RECEIVED' then
      v_otro := public.wx_uuid(pl->>'event_location_uuid');
      select * into v_tr from public.stock_transfers where transfer_uuid = agg;
      if found and (v_tr.company_id <> d.company_id or v_tr.to_location_id <> v_loc.id or v_tr.kind <> 'RETURN') then
        raise exception 'WX_REJECT: retorno ajeno'; end if;
      if not found then
        select tipo into v_tipo_otro from public.sucursales where id = v_otro and negocio_id = d.company_id;
        if v_tipo_otro is distinct from 'EVENT' then raise exception 'WX_REJECT: el origen no es un evento de esta empresa'; end if;
        insert into public.stock_transfers (transfer_uuid, company_id, kind, from_location_id, to_location_id, status, sent_at, origin_device)
        values (agg, d.company_id, 'RETURN', v_otro, v_loc.id, 'SENT', v_at, null);
      end if;
      update public.stock_transfers set status = 'RECEIVED', received_at = v_at, updated_at = now() where transfer_uuid = agg;
      for l in select * from jsonb_array_elements(coalesce(pl->'lines', '[]')) loop
        insert into public.stock_transfer_lines (transfer_uuid, product_uuid, product_name, qty_sent, qty_received)
        values (agg, public.wx_uuid(l->>'product_uuid'), l->>'product_name', (l->>'qty_sent')::numeric, (l->>'qty_received')::numeric)
        on conflict (transfer_uuid, product_uuid) do update set qty_received = excluded.qty_received;
        if (l->>'qty_received')::numeric > 0 then
          perform public.wx_ledger(d.company_id, v_loc, public.wx_uuid_det('RETURN_TRANSFER_IN|' || agg || '|' || (l->>'product_uuid')), public.wx_uuid(l->>'product_uuid'),
                                   'RETURN_TRANSFER_IN', (l->>'qty_received')::numeric, 'TRANSFER', agg, d.id, p_event, null, v_at);
        end if;
      end loop;
    end if;

  elsif t = 'TRANSFER' and v_loc.tipo = 'EVENT' then
    if et = 'TRANSFER_RECEIVED' then
      select * into v_tr from public.stock_transfers where transfer_uuid = agg;
      if found and (v_tr.company_id <> d.company_id or v_tr.to_location_id <> v_loc.id or v_tr.kind <> 'OUT') then
        raise exception 'WX_REJECT: esa transferencia no es para este evento'; end if;
      if not found then
        -- Recibida por QR antes de que la sucursal sincronizara su envío.
        v_otro := public.wx_uuid(pl->>'from_location_uuid');
        select tipo into v_tipo_otro from public.sucursales where id = v_otro and negocio_id = d.company_id;
        if v_tipo_otro is distinct from 'BRANCH' then raise exception 'WX_REJECT: el origen no es una sucursal de esta empresa'; end if;
        insert into public.stock_transfers (transfer_uuid, company_id, kind, from_location_id, to_location_id, status, sent_at)
        values (agg, d.company_id, 'OUT', v_otro, v_loc.id, 'SENT', v_at);
      end if;
      update public.stock_transfers set status = 'RECEIVED', received_at = v_at, updated_at = now() where transfer_uuid = agg;
      for l in select * from jsonb_array_elements(coalesce(pl->'lines', '[]')) loop
        select * into v_line from public.stock_transfer_lines where transfer_uuid = agg and product_uuid = public.wx_uuid(l->>'product_uuid');
        if found then
          update public.stock_transfer_lines set qty_received = (l->>'qty_received')::numeric,
                 claimed_sent = case when qty_sent <> (l->>'qty_sent')::numeric then (l->>'qty_sent')::numeric else claimed_sent end
           where transfer_uuid = agg and product_uuid = v_line.product_uuid;
          if v_line.qty_sent <> (l->>'qty_sent')::numeric then
            perform public.wx_pendiente('TRANSFER_MISMATCH', agg::text || ':' || v_line.product_uuid, d.company_id,
              jsonb_build_object('enviado_sucursal', v_line.qty_sent, 'dice_la_tablet', l->>'qty_sent', 'recibido', l->>'qty_received'));
          end if;
        else
          insert into public.stock_transfer_lines (transfer_uuid, product_uuid, product_name, qty_sent, qty_received)
          values (agg, public.wx_uuid(l->>'product_uuid'), l->>'product_name', (l->>'qty_sent')::numeric, (l->>'qty_received')::numeric);
        end if;
      end loop;
      for m in select * from jsonb_array_elements(coalesce(pl->'movements', '[]')) loop
        if m->>'type' <> 'TRANSFER_IN' then raise exception 'WX_REJECT: movimiento de recepción no válido'; end if;
        perform public.wx_ledger(d.company_id, v_loc, public.wx_uuid(m->>'uuid'), public.wx_uuid(m->>'product_uuid'), 'TRANSFER_IN', (m->>'quantity')::numeric,
                                 'TRANSFER', agg, d.id, p_event, null, v_at);
      end loop;
    elsif et = 'RETURN_SENT' then
      if v_loc.home_location_id is null then raise exception 'WX_REJECT: el evento no tiene sucursal base'; end if;
      insert into public.stock_transfers (transfer_uuid, company_id, kind, from_location_id, to_location_id, status, sent_at, origin_device)
      values (agg, d.company_id, 'RETURN', v_loc.id, v_loc.home_location_id, 'SENT', v_at, d.id)
      on conflict (transfer_uuid) do nothing;
      for l in select * from jsonb_array_elements(coalesce(pl->'lines', '[]')) loop
        insert into public.stock_transfer_lines (transfer_uuid, product_uuid, product_name, qty_sent)
        values (agg, public.wx_uuid(l->>'product_uuid'), l->>'product_name', (l->>'qty_sent')::numeric)
        on conflict (transfer_uuid, product_uuid) do nothing;
      end loop;
      for m in select * from jsonb_array_elements(coalesce(pl->'movements', '[]')) loop
        if m->>'type' <> 'RETURN_TRANSFER_OUT' then raise exception 'WX_REJECT: movimiento de retorno no válido'; end if;
        perform public.wx_ledger(d.company_id, v_loc, public.wx_uuid(m->>'uuid'), public.wx_uuid(m->>'product_uuid'), 'RETURN_TRANSFER_OUT', (m->>'quantity')::numeric,
                                 'TRANSFER', agg, d.id, p_event, null, v_at);
      end loop;
    else
      raise exception 'WX_REJECT: evento de transferencia desconocido';
    end if;
  end if;
  return 'APPLIED';
end $$;

/*
 * Recibe un lote de hechos (Fase 2).
 *   - empresa y ubicación salen del EQUIPO, nunca del sobre;
 *   - una sucursal con huella de servidor distinta (base restaurada en otro
 *     equipo) NO sincroniza: CLONE_SUSPECTED y queda para conciliar;
 *   - una tablet revocada entrega: lo anterior a la baja se aplica, lo
 *     posterior queda en CUARENTENA (no se pierde evidencia);
 *   - el orden de una tablet es su local_seq; la hora se corrige con el
 *     desfase medido de su reloj, solo para decidir la cuarentena.
 */
create or replace function public.sync_ingest(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d public.devices%rowtype; v_loc public.sucursales%rowtype; ev jsonb; v_ev jsonb; v_uuid uuid;
  v_prev public.sync_events%rowtype; v_res text; salida jsonb := '[]'; env jsonb := coalesce(p->'envelope', '{}');
  v_skew interval := interval '0'; v_occ timestamptz; v_tipos text[]; v_neg jsonb;
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and (status = 'ACTIVE' or (status = 'REVOKED' and kind = 'MOBILE_POS'));
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if d.kind not in ('POS_PRIMARY', 'MOBILE_POS') then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  select * into v_loc from public.sucursales where id = d.location_id;
  if (nullif(env->>'company_uuid', '') is not null and public.wx_uuid(env->>'company_uuid') is distinct from d.company_id)
     or (nullif(env->>'location_uuid', '') is not null and public.wx_uuid(env->>'location_uuid') is distinct from d.location_id)
     or (nullif(env->>'instance_uuid', '') is not null and v_loc.instance_uuid is not null and public.wx_uuid(env->>'instance_uuid') is distinct from v_loc.instance_uuid) then
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'SYNC_INGEST', 'DENIED', jsonb_build_object('code', 'ENVELOPE_MISMATCH', 'envelope', env));
    return jsonb_build_object('ok', false, 'code', 'ENVELOPE_MISMATCH');
  end if;
  if d.kind = 'POS_PRIMARY' and nullif(env->>'server_fingerprint', '') is not null then
    if v_loc.server_fingerprint is null then
      update public.sucursales set server_fingerprint = env->>'server_fingerprint' where id = v_loc.id;
    elsif v_loc.server_fingerprint <> env->>'server_fingerprint' then
      perform public.wx_pendiente('CLONE_SUSPECTED', v_loc.id::text || ':' || (env->>'server_fingerprint'), d.company_id,
        jsonb_build_object('location_id', v_loc.id, 'esperada', v_loc.server_fingerprint, 'recibida', env->>'server_fingerprint', 'device_id', d.id));
      perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'SYNC_INGEST', 'DENIED', jsonb_build_object('code', 'CLONE_SUSPECTED'));
      return jsonb_build_object('ok', false, 'code', 'CLONE_SUSPECTED');
    end if;
  end if;
  if d.kind = 'MOBILE_POS' and v_loc.tipo <> 'EVENT' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  v_tipos := case when d.kind = 'MOBILE_POS' then array['SALE', 'SHIFT', 'CASH_MOVEMENT', 'INVENTORY_MOVEMENT', 'TRANSFER']
                  else array['SALE', 'SHIFT', 'CASH_MOVEMENT', 'TRANSFER'] end;
  if nullif(env->>'device_now', '') is not null then
    v_skew := now() - (env->>'device_now')::timestamptz;
    update public.devices set clock_skew_seconds = extract(epoch from v_skew)::int where id = d.id;
  end if;
  if jsonb_typeof(p->'events') <> 'array' or jsonb_array_length(p->'events') > 500 then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;

  for ev in select * from jsonb_array_elements(p->'events') loop
    v_uuid := public.wx_uuid(ev->>'event_uuid');
    begin
      if v_uuid is null or public.wx_uuid(ev->>'aggregate_uuid') is null or jsonb_typeof(ev->'payload') <> 'object'
         or not (coalesce(ev->>'aggregate_type', '') = any (v_tipos)) then
        salida := salida || jsonb_build_object('event_uuid', ev->>'event_uuid', 'result', 'REJECTED', 'error', 'evento inválido');
        continue;
      end if;
      select * into v_prev from public.sync_events where event_uuid = v_uuid;
      if found then
        salida := salida || jsonb_build_object('event_uuid', v_uuid,
          'result', case when v_prev.company_id <> d.company_id then 'REJECTED' when v_prev.result = 'QUARANTINED' then 'QUARANTINED' else 'DUPLICATE' end);
        continue;
      end if;
      if d.status = 'REVOKED' then
        v_occ := (ev->>'occurred_at')::timestamptz + v_skew;
        if v_occ is null or v_occ > d.revoked_at then
          insert into public.sync_events (event_uuid, company_id, location_id, device_id, aggregate_type, aggregate_uuid, aggregate_version,
            event_type, occurred_at, payload_version, payload, result, local_seq)
          values (v_uuid, d.company_id, d.location_id, d.id, ev->>'aggregate_type', public.wx_uuid(ev->>'aggregate_uuid'),
            coalesce((ev->>'aggregate_version')::bigint, 0), left(ev->>'event_type', 40), (ev->>'occurred_at')::timestamptz,
            coalesce((ev->>'payload_version')::smallint, 1), ev->'payload', 'QUARANTINED', (ev->>'local_seq')::bigint);
          perform public.wx_pendiente('EVENT_QUARANTINED', v_uuid::text, d.company_id,
            jsonb_build_object('device_id', d.id, 'event_type', ev->>'event_type', 'occurred_corrected', v_occ, 'revoked_at', d.revoked_at));
          salida := salida || jsonb_build_object('event_uuid', v_uuid, 'result', 'QUARANTINED');
          continue;
        end if;
      end if;
      v_ev := public.wx_normalizar_evento(ev, coalesce(v_loc.timezone, 'America/Mexico_City'));
      v_res := case when ev->>'aggregate_type' in ('SALE', 'SHIFT', 'CASH_MOVEMENT') then public.wx_proyectar(d, v_loc.timezone, v_ev) else 'APPLIED' end;
      if v_res <> 'REJECTED' then perform public.wx_proyectar_f2(d, v_loc, v_ev, v_uuid); end if;
      insert into public.sync_events (event_uuid, company_id, location_id, device_id, aggregate_type, aggregate_uuid,
        aggregate_version, event_type, occurred_at, payload_version, payload, result, local_seq)
      values (v_uuid, d.company_id, d.location_id, d.id, ev->>'aggregate_type', public.wx_uuid(ev->>'aggregate_uuid'),
        coalesce((ev->>'aggregate_version')::bigint, 0), left(ev->>'event_type', 40), (ev->>'occurred_at')::timestamptz,
        coalesce((ev->>'payload_version')::smallint, 1), ev->'payload', v_res, (ev->>'local_seq')::bigint)
      on conflict (event_uuid) do nothing;
      if v_res = 'REJECTED' then
        perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'SYNC_EVENT', 'DENIED',
          jsonb_build_object('event_uuid', v_uuid, 'aggregate', ev->>'aggregate_type', 'code', 'FOREIGN_AGGREGATE'));
      end if;
      salida := salida || jsonb_build_object('event_uuid', v_uuid, 'result', case when v_res = 'REJECTED' then 'REJECTED' else 'APPLIED' end);
    exception when others then
      if sqlerrm like 'WX_REJECT:%' then
        perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'SYNC_EVENT', 'DENIED', jsonb_build_object('event_uuid', ev->>'event_uuid', 'motivo', sqlerrm));
        salida := salida || jsonb_build_object('event_uuid', ev->>'event_uuid', 'result', 'REJECTED', 'error', left(substr(sqlerrm, 12), 200));
      else
        salida := salida || jsonb_build_object('event_uuid', ev->>'event_uuid', 'result', 'ERROR', 'error', left(sqlerrm, 200));
      end if;
    end;
  end loop;

  update public.devices set last_sync_at = now(), last_seen_at = now(),
         last_seq = greatest(coalesce(last_seq, 0), coalesce((select max((e->>'local_seq')::bigint) from jsonb_array_elements(p->'events') e), 0))
   where id = d.id;

  -- Stock negativo en un evento: se avisa y se concilia; nunca se borra una venta.
  if v_loc.tipo = 'EVENT' then
    select jsonb_agg(jsonb_build_object('product_uuid', product_uuid, 'qty', qty)) into v_neg from public.location_stock where location_id = v_loc.id and qty < 0;
    if v_neg is not null then
      perform public.wx_pendiente('STOCK_NEGATIVE', v_loc.id::text || ':' || to_char(now(), 'YYYY-MM-DD'), d.company_id, jsonb_build_object('stock', v_neg));
    end if;
  end if;
  return jsonb_build_object('ok', true, 'results', salida);
end $$;

-- ============================================================================
--  13. TABLET: snapshot, inbox, latido
-- ============================================================================
create or replace function public.mobile_snapshot(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices%rowtype; s public.sucursales%rowtype; n public.negocios%rowtype; v_cat public.catalog_publications%rowtype; r public.registers%rowtype;
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id');
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if d.status <> 'ACTIVE' or d.kind <> 'MOBILE_POS' then return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED'); end if;
  select * into s from public.sucursales where id = d.location_id;
  select * into n from public.negocios where id = d.company_id;
  select * into r from public.registers where id = d.register_id;
  select * into v_cat from public.catalog_publications where location_id = s.home_location_id order by version desc limit 1;
  return jsonb_build_object('ok', true,
    'snapshot_version', extract(epoch from now())::bigint,
    'security_revision', s.security_revision,
    'device', jsonb_build_object('id', d.id, 'uuid', d.device_uuid, 'status', d.status),
    'company', jsonb_build_object('uuid', n.id, 'nombre', n.nombre),
    'location', jsonb_build_object('uuid', s.id, 'nombre', s.nombre, 'tipo', s.tipo, 'timezone', s.timezone, 'status', s.status,
                                   'event_status', s.event_status, 'home_location_uuid', s.home_location_id, 'starts_at', s.starts_at, 'ends_at', s.ends_at),
    'register', case when r.id is null then null else jsonb_build_object('uuid', r.register_uuid, 'code', r.code, 'name', r.name) end,
    'catalog', case when v_cat.id is null then null else v_cat.payload || jsonb_build_object('catalog_version', v_cat.version) end,
    'staff', coalesce((select jsonb_agg(jsonb_build_object('uuid', e.pos_user_uuid, 'name', e.display_name, 'role', ls.role,
                                 'pin_hash', e.pin_hash, 'pin_sal', e.pin_sal, 'pin_algo', e.pin_algo, 'active', ls.active and e.status = 'ACTIVE'))
                         from public.location_staff ls join public.employees e on e.id = ls.employee_id
                        where ls.location_id = s.id and e.pin_hash is not null), '[]'),
    'payment_methods', jsonb_build_array(
      jsonb_build_object('code', 'EFECTIVO', 'label', 'Efectivo', 'enabled', true),
      jsonb_build_object('code', 'TARJETA', 'label', 'Tarjeta (terminal)', 'enabled', true),
      jsonb_build_object('code', 'TRANSFERENCIA', 'label', 'Transferencia', 'enabled', true)),
    'trusted_keys', coalesce((select jsonb_agg(jsonb_build_object('key_id', x.id, 'public_key', x.signing_public_key, 'location_uuid', x.location_id, 'label', x.name))
                                from public.devices x where x.company_id = d.company_id and x.status = 'ACTIVE' and x.signing_public_key is not null), '[]'),
    'transfers', coalesce((select jsonb_agg(jsonb_build_object('transfer_uuid', t.transfer_uuid, 'from_location_uuid', t.from_location_id,
                                 'to_location_uuid', t.to_location_id, 'status', t.status,
                                 'lines', (select jsonb_agg(jsonb_build_object('product_uuid', l.product_uuid, 'product_name', l.product_name, 'qty_sent', l.qty_sent::text))
                                             from public.stock_transfer_lines l where l.transfer_uuid = t.transfer_uuid)))
                             from public.stock_transfers t where t.to_location_id = s.id and t.kind = 'OUT' and t.status = 'SENT'), '[]'),
    'releases', (select jsonb_build_object('latest_version', a.latest_version, 'min_supported_version', a.min_supported_version)
                   from public.app_releases a where a.app = 'pos-mobile' and a.channel = coalesce(p->>'channel', 'production')));
end $$;

/* Hechos de OTRAS tablets del mismo evento (sus movimientos), por cursor. */
create or replace function public.mobile_inbox(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices%rowtype; v_cur bigint := coalesce((p->>'cursor')::bigint, 0); v_ev jsonb; v_max bigint;
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id');
  if not found or d.status <> 'ACTIVE' or d.kind <> 'MOBILE_POS' then return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('event_uuid', e.event_uuid, 'origin_device', e.device_id, 'aggregate_type', e.aggregate_type, 'payload', e.payload) order by e.seq), '[]'),
         max(e.seq)
    into v_ev, v_max
    from (select * from public.sync_events
           where location_id = d.location_id and device_id is distinct from d.id and seq > v_cur and result = 'APPLIED'
             and aggregate_type in ('SALE', 'INVENTORY_MOVEMENT', 'TRANSFER')
           order by seq limit 200) e;
  return jsonb_build_object('ok', true, 'events', v_ev, 'cursor', coalesce(v_max, v_cur));
end $$;

create or replace function public.mobile_latido(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.devices set pending_events = nullif(p->>'pendientes', '')::int, app_version = coalesce(nullif(p->>'app_version', ''), app_version),
         last_seen_at = now()
   where id = public.wx_uuid(p->>'device_id');
  return jsonb_build_object('ok', found);
end $$;

/* La sucursal pregunta qué le toca: retornos por recibir y envíos ya recibidos por el evento. */
create or replace function public.pos_transfer_inbox(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices%rowtype;
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE' and kind = 'POS_PRIMARY';
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  return jsonb_build_object('ok', true,
    'returns', coalesce((select jsonb_agg(jsonb_build_object('transfer_uuid', t.transfer_uuid, 'event_location_uuid', t.from_location_id,
                               'event_name', s.nombre, 'sent_at', t.sent_at,
                               'lines', (select jsonb_agg(jsonb_build_object('product_uuid', l.product_uuid, 'product_name', l.product_name, 'qty_sent', l.qty_sent::text))
                                           from public.stock_transfer_lines l where l.transfer_uuid = t.transfer_uuid)))
                           from public.stock_transfers t join public.sucursales s on s.id = t.from_location_id
                          where t.to_location_id = d.location_id and t.kind = 'RETURN' and t.status = 'SENT'), '[]'),
    'received', coalesce((select jsonb_agg(jsonb_build_object('transfer_uuid', t.transfer_uuid, 'received_at', t.received_at,
                               'lines', (select jsonb_agg(jsonb_build_object('product_uuid', l.product_uuid, 'qty_received', l.qty_received::text))
                                           from public.stock_transfer_lines l where l.transfer_uuid = t.transfer_uuid)))
                           from public.stock_transfers t
                          where t.from_location_id = d.location_id and t.kind = 'OUT' and t.status = 'RECEIVED' and not t.branch_confirmed), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('location_id', s.id, 'nombre', s.nombre, 'event_status', s.event_status,
                               'starts_at', s.starts_at, 'ends_at', s.ends_at) order by s.starts_at nulls last)
                           from public.sucursales s
                          where s.negocio_id = d.company_id and s.tipo = 'EVENT' and s.home_location_id = d.location_id
                            and s.event_status in ('PLANNED', 'OPEN', 'CLOSED')), '[]'));
end $$;

-- ============================================================================
--  14. CLONES Y CONCILIACIÓN
-- ============================================================================
create or replace function public.ubicacion_resolver_clon(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wx_actor_admin(p); v_loc uuid := public.wx_uuid(p->>'location_id'); v_dec text := upper(coalesce(p->>'decision', ''));
begin
  if a is null or a->>'kind' <> 'USER' or v_dec not in ('REBIND', 'NEW_LOCATION') then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if not exists (select 1 from public.sucursales where id = v_loc and negocio_id = (a->>'company_id')::uuid) then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  -- REBIND: "moví el servidor": la siguiente sincronización fija la huella nueva.
  -- NEW_LOCATION: la copia debe darse de alta como sucursal nueva (con su código);
  -- la ubicación original conserva su huella y la copia sigue sin sincronizar.
  if v_dec = 'REBIND' then
    update public.sucursales set server_fingerprint = null where id = v_loc;
  end if;
  update public.reconciliation_items set status = 'RESOLVED', resolved_at = now(),
         detail = detail || jsonb_build_object('decision', v_dec, 'por', a->>'id')
   where kind = 'CLONE_SUSPECTED' and ref like v_loc::text || ':%' and status = 'OPEN';
  perform public.wx_audit('USER', a->>'id', (a->>'company_id')::uuid, 'CLONE_RESOLVED', v_dec, jsonb_build_object('location_id', v_loc));
  return jsonb_build_object('ok', true);
end $$;

/* Solo con evidencia INEQUÍVOCA. Lo demás queda para la conciliación manual. */
create or replace function public.conciliar_automatico()
returns jsonb language plpgsql security definer set search_path = public as $$
declare n1 int; n2 int; n3 int := 0; r record;
begin
  update public.reconciliation_items i set status = 'RESOLVED', resolved_at = now(), detail = i.detail || '{"auto":"licencia ya ligada"}'
   where i.kind = 'LICENSE_UNLINKED' and i.status = 'OPEN'
     and exists (select 1 from public.licenses l where l.id::text = i.ref and l.company_id is not null);
  get diagnostics n1 = row_count;
  update public.reconciliation_items i set status = 'RESOLVED', resolved_at = now(), detail = i.detail || '{"auto":"membresía ya existe"}'
   where i.kind = 'OWNER_APP_UNVERIFIED' and i.status = 'OPEN'
     and exists (select 1 from public.owner_apps oa join public.company_memberships m on m.company_id::text = oa.negocio_id and m.user_id = oa.user_id and m.status = 'ACTIVE'
                  where oa.id::text = i.ref);
  get diagnostics n2 = row_count;
  -- Duplicado del modelo viejo SIN ningún dato propio: se archiva (no se borra).
  for r in select i.id, i.ref from public.reconciliation_items i where i.kind = 'LOCATION_DUPLICATE' and i.status = 'OPEN' loop
    if not exists (select 1 from public.sync_events where location_id::text = r.ref)
       and not exists (select 1 from public.resumen_ventas where sucursal_id::text = r.ref)
       and not exists (select 1 from public.cortes_caja where sucursal_id::text = r.ref)
       and not exists (select 1 from public.devices where location_id::text = r.ref and status = 'ACTIVE') then
      update public.sucursales set status = 'ARCHIVED', updated_at = now() where id::text = r.ref;
      update public.reconciliation_items set status = 'RESOLVED', resolved_at = now(), detail = detail || '{"auto":"duplicado sin datos archivado"}' where id = r.id;
      n3 := n3 + 1;
    end if;
  end loop;
  return jsonb_build_object('licencias', n1, 'apps_dueno', n2, 'duplicados', n3,
                            'pendientes', (select coalesce(jsonb_object_agg(kind, n), '{}') from (select kind, count(*) n from public.reconciliation_items where status = 'OPEN' group by kind) x));
end $$;

/* Manual (soporte con service_role): ligar una licencia a una empresa con evidencia externa. */
create or replace function public.conciliar_licencia(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.licenses%rowtype; v_company uuid := public.wx_uuid(p->>'company_id');
begin
  select * into l from public.licenses where id = public.wx_uuid(p->>'license_id') for update;
  if not found or v_company is null or not exists (select 1 from public.negocios where id = v_company) then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  if l.company_id is not null and l.company_id <> v_company and not coalesce((p->>'reasignar')::boolean, false) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_LINKED', 'company_id', l.company_id);
  end if;
  if coalesce(trim(p->>'evidencia'), '') = '' then return jsonb_build_object('ok', false, 'code', 'EVIDENCE_REQUIRED'); end if;
  update public.licenses set company_id = v_company where id = l.id;
  update public.reconciliation_items set status = 'RESOLVED', resolved_at = now(), detail = detail || jsonb_build_object('manual', p->>'actor', 'evidencia', p->>'evidencia')
   where kind in ('LICENSE_UNLINKED', 'LICENSE_MULTI_COMPANY') and ref = l.id::text;
  perform public.wx_audit('SERVICE', p->>'actor', v_company, 'LICENSE_LINKED', 'OK', jsonb_build_object('license_id', l.id, 'evidencia', p->>'evidencia'));
  return jsonb_build_object('ok', true);
end $$;

/* Manual: una app del dueño que se ligó sin invitación. GRANT da membresía (rol elegido); DENY la desactiva. */
create or replace function public.conciliar_owner_app(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.reconciliation_items%rowtype; oa public.owner_apps%rowtype; v_dec text := upper(coalesce(p->>'decision', '')); v_role text := upper(coalesce(p->>'role', 'VIEWER'));
begin
  select * into i from public.reconciliation_items where id = (p->>'item_id')::bigint and kind = 'OWNER_APP_UNVERIFIED' for update;
  if not found or v_dec not in ('GRANT', 'DENY') or v_role not in ('OWNER', 'ADMIN', 'MANAGER', 'VIEWER') then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  select * into oa from public.owner_apps where id::text = i.ref;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if v_dec = 'GRANT' then
    insert into public.company_memberships (company_id, user_id, role, origin)
    values (oa.negocio_id::uuid, oa.user_id, v_role, 'RECONCILED') on conflict (company_id, user_id) do nothing;
  else
    update public.owner_apps set active = false where id = oa.id;
  end if;
  update public.reconciliation_items set status = 'RESOLVED', resolved_at = now(), detail = detail || jsonb_build_object('decision', v_dec, 'role', v_role, 'por', p->>'actor') where id = i.id;
  perform public.wx_audit('SERVICE', p->>'actor', oa.negocio_id::uuid, 'OWNER_APP_RECONCILED', v_dec, jsonb_build_object('user_id', oa.user_id));
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================================
--  15. APP DEL DUEÑO: eventos, personal, tablets, estado de equipos
--  (llamadas directas con el JWT; cada una valida OWNER/ADMIN por dentro)
-- ============================================================================
create or replace function public.owner_crear_evento(p_company uuid, p jsonb)
returns jsonb language sql security definer set search_path = public as $$
  select public.pos_create_location(coalesce(p, '{}') || jsonb_build_object('user_id', auth.uid(), 'company_id', p_company, 'tipo', 'EVENT'));
$$;
create or replace function public.owner_evento_estado(p_company uuid, p_location uuid, p_status text, p_forzar boolean default false, p_motivo text default null)
returns jsonb language sql security definer set search_path = public as $$
  select public.evento_cambiar_estado(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company, 'location_id', p_location,
                                                         'status', p_status, 'forzar', p_forzar, 'motivo', p_motivo));
$$;
create or replace function public.owner_asignar_personal(p_company uuid, p_location uuid, p_employee uuid, p_role text, p_active boolean default true)
returns jsonb language sql security definer set search_path = public as $$
  select public.evento_asignar_personal(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company, 'location_id', p_location,
                                                           'employee_id', p_employee, 'role', p_role, 'active', p_active));
$$;
create or replace function public.owner_codigo_tablet(p_company uuid, p_location uuid, p_register_name text default null)
returns jsonb language sql security definer set search_path = public as $$
  select public.evento_codigo_tablet(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company, 'location_id', p_location, 'register_name', p_register_name));
$$;
create or replace function public.owner_revocar_dispositivo(p_company uuid, p_device uuid)
returns jsonb language sql security definer set search_path = public as $$
  select public.dispositivo_revocar(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company, 'target_device_id', p_device));
$$;
create or replace function public.owner_resolver_clon(p_company uuid, p_location uuid, p_decision text)
returns jsonb language sql security definer set search_path = public as $$
  select public.ubicacion_resolver_clon(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company, 'location_id', p_location, 'decision', p_decision));
$$;

/* Personal de la empresa para asignar a eventos (sin hashes: solo si tiene PIN). */
create or replace function public.owner_empleados(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if public.wx_rol(p_company) is null then raise exception 'DENIED' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'nombre', e.display_name, 'rol_sucursal', e.branch_role,
                     'sucursal', s.nombre, 'tiene_pin', e.pin_hash is not null,
                     'eventos', (select coalesce(jsonb_agg(jsonb_build_object('location_id', ls.location_id, 'role', ls.role, 'active', ls.active)), '[]')
                                   from public.location_staff ls where ls.employee_id = e.id)) order by e.display_name)
                    from public.employees e left join public.sucursales s on s.id = e.home_location_id
                   where e.company_id = p_company and e.status = 'ACTIVE'), '[]');
end $$;

/* Estado de los equipos de la empresa: último contacto, versión, sincronización, pendientes. */
create or replace function public.estado_dispositivos(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if public.wx_rol(p_company) is null then raise exception 'DENIED' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'name', d.name, 'status', d.status,
                     'location_id', d.location_id, 'location', s.nombre, 'tipo', s.tipo, 'app_version', d.app_version,
                     'last_seen_at', d.last_seen_at, 'last_sync_at', d.last_sync_at, 'pending_events', d.pending_events,
                     'revoked_at', d.revoked_at, 'register', r.code, 'clock_skew_seconds', d.clock_skew_seconds,
                     'en_linea', d.last_seen_at > now() - interval '10 minutes') order by s.tipo, s.nombre, d.kind)
                    from public.devices d join public.sucursales s on s.id = d.location_id left join public.registers r on r.id = d.register_id
                   where d.company_id = p_company and (public.wx_puede_ubicacion(d.location_id))), '[]');
end $$;

-- ============================================================================
--  FUNCIONES DE LA FASE 1 QUE CAMBIAN (se reconstruyen desde su texto exacto
--  de 20261002120000 y solo se agrega lo de la Fase 2)
-- ============================================================================
/* pos_enroll: + tablets (MOBILE_POS) con caja asignada y derechos aplicados. */
create or replace function public.pos_enroll(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_instance uuid := public.wx_uuid(p->>'instance_uuid');
  v_device uuid := public.wx_uuid(p->>'device_uuid');
  v_kind text := coalesce(nullif(p->>'kind', ''), 'POS_SECONDARY');
  v_loc public.sucursales%rowtype;
  e public.device_enrollments%rowtype;
  v_permiso text;
  v_res jsonb;
begin
  if v_device is null or v_kind not in ('POS_PRIMARY', 'POS_SECONDARY', 'OPERATIONAL_SCREEN', 'LOCAL_HOST', 'MOBILE_POS') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;

  if nullif(p->>'install_secret', '') is not null then
    select * into v_loc from public.sucursales
     where install_secret_hash = public.wx_hash(p->>'install_secret') and status = 'ACTIVE';
    if not found then
      perform public.wx_audit('DEVICE', v_device::text, null, 'ENROLL', 'DENIED', jsonb_build_object('code', 'BAD_SECRET'));
      return jsonb_build_object('ok', false, 'code', 'DENIED');
    end if;
    if v_kind = 'MOBILE_POS' or v_instance is null or v_loc.instance_uuid is distinct from v_instance then
      perform public.wx_audit('DEVICE', v_device::text, v_loc.negocio_id, 'ENROLL', 'DENIED', jsonb_build_object('code', 'INSTANCE_MISMATCH'));
      return jsonb_build_object('ok', false, 'code', 'DENIED');
    end if;
    return public.wx_emitir_dispositivo(v_loc.id, v_kind, v_device, p);
  end if;

  select * into e from public.device_enrollments
   where code_hash = public.wx_codigo_hash(p->>'code') and revoked_at is null and expires_at > now() and uses < max_uses
   for update;
  if not found then
    perform public.wx_audit('DEVICE', v_device::text, null, 'ENROLL', 'DENIED', jsonb_build_object('code', 'BAD_CODE'));
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;
  if not (v_kind = any (e.kinds)) then
    return jsonb_build_object('ok', false, 'code', 'KIND_NOT_ALLOWED');
  end if;
  select * into v_loc from public.sucursales where id = e.location_id for update;

  if e.purpose = 'CLAIM_LOCATION' then
    if v_instance is null then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
    perform pg_advisory_xact_lock(hashtextextended('wx-instance:' || v_instance::text, 0));
    if v_loc.instance_uuid is null then
      if exists (select 1 from public.sucursales where instance_uuid = v_instance) then
        -- Esa base ya es otra ubicación: una base no puede ser dos sucursales.
        return jsonb_build_object('ok', false, 'code', 'INSTANCE_KNOWN');
      end if;
      update public.sucursales set instance_uuid = v_instance, status = 'ACTIVE', updated_at = now() where id = v_loc.id;
    elsif v_loc.instance_uuid <> v_instance then
      return jsonb_build_object('ok', false, 'code', 'DENIED');
    end if;
  elsif v_loc.instance_uuid is not null and v_instance is not null and v_loc.instance_uuid <> v_instance then
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;

  -- Fase 2: una tablet solo entra a un EVENT abierto o planeado, y si la
  -- empresa tiene el derecho y el cupo (perderlo nunca da de baja las que ya están).
  if v_kind = 'MOBILE_POS' then
    if v_loc.tipo <> 'EVENT' or v_loc.event_status not in ('PLANNED', 'OPEN') then
      return jsonb_build_object('ok', false, 'code', 'EVENT_NOT_OPEN');
    end if;
    v_permiso := public.wx_permite(v_loc.negocio_id, 'ENROLL_MOBILE');
    if v_permiso is not null then
      perform public.wx_audit('DEVICE', v_device::text, v_loc.negocio_id, 'ENROLL', 'DENIED', jsonb_build_object('code', v_permiso));
      return jsonb_build_object('ok', false, 'code', v_permiso);
    end if;
  end if;
  update public.device_enrollments set uses = uses + 1 where id = e.id;
  v_res := public.wx_emitir_dispositivo(v_loc.id, v_kind, v_device, p);
  if e.register_id is not null then
    update public.devices set register_id = e.register_id where id = (v_res->>'device_id')::uuid;
  end if;
  return v_res || jsonb_build_object('register_id', e.register_id);
end $$;

/* resumen_empresa: + última sincronización por ubicación y estado del evento. */
create or replace function public.resumen_empresa(p_company uuid, p_fecha date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb := '[]'; s record; v_dia date; v_total numeric := 0; v_tickets int := 0; v_ventas jsonb; v_abiertos jsonb; v_ultimo jsonb;
        v_sum numeric; v_n int; v_neto numeric;
begin
  if not public.wx_es_miembro(p_company) then
    raise exception 'DENIED' using errcode = '42501';
  end if;
  for s in
    select x.* from public.sucursales x
      join public.company_memberships m on m.company_id = x.negocio_id and m.user_id = (select auth.uid()) and m.status = 'ACTIVE'
     where x.negocio_id = p_company and x.status <> 'ARCHIVED'
       and (m.location_ids is null or x.id = any (m.location_ids))
     order by x.tipo, x.nombre
  loop
    v_dia := coalesce(p_fecha, (now() at time zone s.timezone)::date);
    select coalesce(sum(total), 0), count(*), coalesce(sum(total - refunded_total), 0) into v_sum, v_n, v_neto
      from public.sales_facts where location_id = s.id and business_date = v_dia;
    if v_n > 0 then
      v_ventas := jsonb_build_object('total', v_sum, 'neto', v_neto, 'tickets', v_n, 'fuente', 'hechos');
    else
      select jsonb_build_object('total', rv.total, 'neto', rv.total, 'tickets', rv.num_tickets, 'fuente', 'espejo'), rv.total, rv.num_tickets
        into v_ventas, v_sum, v_n
        from public.resumen_ventas rv where rv.sucursal_id = s.id and rv.fecha = v_dia;
      if v_ventas is null then v_ventas := jsonb_build_object('total', 0, 'neto', 0, 'tickets', 0, 'fuente', 'sin_datos'); v_sum := 0; v_n := 0; end if;
    end if;
    v_total := v_total + coalesce((v_ventas->>'neto')::numeric, 0);
    v_tickets := v_tickets + coalesce((v_ventas->>'tickets')::int, 0);

    select coalesce(jsonb_agg(jsonb_build_object('shift_uuid', f.shift_uuid, 'caja', rg.name, 'abierto_at', f.opened_at,
             'abierto_por', e.display_name, 'fondo', f.opening_cash) order by f.opened_at), '[]')
      into v_abiertos
      from public.shift_facts f
      left join public.registers rg on rg.location_id = f.location_id and rg.register_uuid = f.register_uuid
      left join public.employees e on e.company_id = f.company_id and e.pos_user_uuid = f.opened_by_uuid
     where f.location_id = s.id and f.status = 'OPEN';

    select jsonb_build_object('shift_uuid', f.shift_uuid, 'caja', rg.name, 'abierto_at', f.opened_at, 'cerrado_at', f.closed_at,
             'esperado', f.cash_expected, 'contado', f.cash_counted, 'diferencia', f.difference, 'a_ciegas', f.blind_count,
             'cerrado_por', e.display_name, 'fuente', 'hechos')
      into v_ultimo
      from public.shift_facts f
      left join public.registers rg on rg.location_id = f.location_id and rg.register_uuid = f.register_uuid
      left join public.employees e on e.company_id = f.company_id and e.pos_user_uuid = f.closed_by_uuid
     where f.location_id = s.id and f.status = 'CLOSED'
     order by f.closed_at desc nulls last limit 1;
    if v_ultimo is null then
      select jsonb_build_object('caja', c.caja, 'abierto_at', c.abierto_at, 'cerrado_at', c.cerrado_at, 'esperado', c.esperado,
               'contado', c.entregado, 'diferencia', c.diferencia, 'fuente', 'espejo')
        into v_ultimo
        from public.cortes_caja c where c.sucursal_id = s.id and c.cerrado_at is not null
       order by c.cerrado_at desc limit 1;
    end if;

    -- Fase 2: cuándo llegó lo último (no se finge tiempo real) y el estado del evento.
    r := r || jsonb_build_object('location_id', s.id, 'nombre', s.nombre, 'tipo', s.tipo, 'status', s.status, 'fecha', v_dia,
                                 'event_status', s.event_status, 'home_location_id', s.home_location_id,
                                 'ultima_sincronizacion', (select max(dv.last_sync_at) from public.devices dv where dv.location_id = s.id),
                                 'ventas', v_ventas, 'turnos_abiertos', v_abiertos, 'ultimo_corte', v_ultimo);
  end loop;
  return jsonb_build_object('company_id', p_company, 'ubicaciones', r,
                            'total', jsonb_build_object('neto', v_total, 'tickets', v_tickets));
end $$;

-- ============================================================================
--  16. RLS Y PRIVILEGIOS
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['location_staff', 'catalog_publications', 'inventory_ledger', 'stock_transfers', 'stock_transfer_lines',
                           'sale_line_facts', 'app_releases'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
  foreach t in array array['location_staff', 'inventory_ledger', 'stock_transfers', 'stock_transfer_lines', 'sale_line_facts'] loop
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to service_role;

drop policy if exists "miembro ve personal de eventos" on public.location_staff;
create policy "miembro ve personal de eventos" on public.location_staff for select to authenticated using (public.wx_puede_ubicacion(location_id));
drop policy if exists "miembro ve inventario" on public.inventory_ledger;
create policy "miembro ve inventario" on public.inventory_ledger for select to authenticated using (public.wx_puede_ubicacion(location_id));
drop policy if exists "miembro ve transferencias" on public.stock_transfers;
create policy "miembro ve transferencias" on public.stock_transfers for select to authenticated
  using (public.wx_puede_ubicacion(from_location_id) or public.wx_puede_ubicacion(to_location_id));
drop policy if exists "miembro ve lineas de transferencia" on public.stock_transfer_lines;
create policy "miembro ve lineas de transferencia" on public.stock_transfer_lines for select to authenticated
  using (exists (select 1 from public.stock_transfers t where t.transfer_uuid = stock_transfer_lines.transfer_uuid
                  and (public.wx_puede_ubicacion(t.from_location_id) or public.wx_puede_ubicacion(t.to_location_id))));
drop policy if exists "miembro ve lineas de venta" on public.sale_line_facts;
create policy "miembro ve lineas de venta" on public.sale_line_facts for select to authenticated using (public.wx_puede_ubicacion(location_id));

-- La vista de stock respeta la RLS de quien consulta.
alter view public.location_stock set (security_invoker = true);
-- El entorno Supabase concede privilegios por omisión a authenticated:
-- retirar también esos grants antes de abrir únicamente lectura.
revoke all on public.location_stock from anon, authenticated;
grant select on public.location_stock to authenticated, service_role;

-- Los hashes de PIN NUNCA son legibles desde la app: solo columnas no sensibles.
revoke select on public.employees from authenticated;
grant select (id, company_id, pos_user_uuid, display_name, home_location_id, status, first_seen_at, last_seen_at, branch_role) on public.employees to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'wx_uuid_det(text)', 'company_entitlements(uuid)', 'wx_permite(uuid, text)', 'pos_create_location(jsonb)',
    'evento_cambiar_estado(jsonb)', 'evento_asignar_personal(jsonb)', 'evento_codigo_tablet(jsonb)', 'dispositivo_revocar(jsonb)',
    'device_autenticar(jsonb)', 'pos_registrar_llave(jsonb)', 'pos_publicar(jsonb)',
    'wx_ledger(uuid, public.sucursales, uuid, uuid, text, numeric, text, uuid, uuid, uuid, text, timestamptz)',
    'wx_normalizar_evento(jsonb, text)', 'wx_proyectar_f2(public.devices, public.sucursales, jsonb, uuid)', 'sync_ingest(jsonb)',
    'mobile_snapshot(jsonb)', 'mobile_inbox(jsonb)', 'mobile_latido(jsonb)', 'pos_transfer_inbox(jsonb)',
    'ubicacion_resolver_clon(jsonb)', 'conciliar_automatico()', 'conciliar_licencia(jsonb)', 'conciliar_owner_app(jsonb)', 'pos_enroll(jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'owner_crear_evento(uuid, jsonb)', 'owner_evento_estado(uuid, uuid, text, boolean, text)', 'owner_asignar_personal(uuid, uuid, uuid, text, boolean)',
    'owner_codigo_tablet(uuid, uuid, text)', 'owner_revocar_dispositivo(uuid, uuid)', 'owner_resolver_clon(uuid, uuid, text)',
    'owner_empleados(uuid)', 'estado_dispositivos(uuid)', 'resumen_empresa(uuid, date)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
