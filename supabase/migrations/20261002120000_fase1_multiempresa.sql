-- ============================================================================
--  FASE 1 · MULTIEMPRESA, DISPOSITIVOS, HECHOS SINCRONIZADOS Y CFDI CON DUEÑO
-- ----------------------------------------------------------------------------
--  EL MODELO (nombres físicos conservados: renombrar tablas en producción sería
--  destructivo para los POS instalados y la app del dueño):
--
--    accounts             Cuenta COMERCIAL (quién paga). NUNCA da acceso a datos:
--                         ninguna política ni función la usa para autorizar.
--    negocios             = Company. LA FRONTERA DE SEGURIDAD.
--    company_memberships  User -> Company, con rol y (opcional) ubicaciones.
--    employees            Personas que operan en el POS (usuarios locales).
--    sucursales           = OperationalLocation. tipo BRANCH | EVENT
--                         (WAREHOUSE y MOBILE reservados, no se pueden crear).
--    registers            Cajas de una ubicación (identidad = uuid local).
--    devices              Cada computadora / pantalla / tableta, con SU
--                         credencial. El MachineGuid NO es identidad comercial:
--                         queda como huella informativa.
--    device_enrollments   Códigos de un solo uso para unir equipos o reclamar
--                         una ubicación nueva.
--    sync_events          Bitácora idempotente de hechos (event_uuid único).
--    sales_facts, shift_facts, cash_movement_facts   proyecciones de hechos.
--    notification_outbox  SHIFT_CLOSED -> correo/push/in-app (Fase 3 entrega).
--    fiscal_issuers, fiscal_invoices (+ reclamos)    CFDI con empresa dueña.
--    cloud_audit, reconciliation_items               rastro y pendientes.
--
--  AUTORIZACIÓN. Toda decisión vive AQUÍ, en funciones SECURITY DEFINER que se
--  prueban con SQL (supabase/tests/fase1.test.sql). Las Edge Functions solo
--  autentican (credencial del equipo o JWT del usuario) y llaman.
--
--  Regla de oro: identidad -> membresía/dispositivo -> empresa -> recurso.
--  Nunca petición -> id arbitrario.
--
--  IDEMPOTENTE: se puede aplicar dos veces. NO DESTRUCTIVA: solo agrega
--  columnas/tablas/funciones y REEMPLAZA políticas RLS (las anteriores quedan
--  respaldadas en `respaldo.fase1_politicas` antes de quitarlas). Reversa:
--  supabase/rollback/20261002120000_fase1_multiempresa.down.sql.
-- ============================================================================

create schema if not exists respaldo;

-- Respaldo de lo que esta migración REEMPLAZA. Se toma UNA vez, al crear la
-- tabla: aplicarla otra vez no respalda las políticas nuevas encima.
do $$ begin
  if to_regclass('respaldo.fase1_politicas') is null then
    create table respaldo.fase1_politicas as
      select now() as respaldado_en, schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
        from pg_policies
       where schemaname = 'public'
         and tablename in ('negocios', 'sucursales', 'resumen_ventas', 'tendencia_ventas', 'top_productos',
                           'cortes_caja', 'alertas', 'seguridad_riesgo');
  end if;
end $$;
create table if not exists respaldo.fase1_license_catalog_grants (code text primary key, grants jsonb, respaldado_en timestamptz default now());
revoke all on schema respaldo from public, anon, authenticated;
revoke all on all tables in schema respaldo from anon, authenticated;

insert into respaldo.fase1_license_catalog_grants (code, grants)
select code, grants from public.license_catalog where code in ('EDITION_MONO', 'EDITION_MULTI', 'ADDON_MULTIBRANCH')
on conflict (code) do nothing;

-- ============================================================================
--  UTILIDADES
-- ============================================================================
create or replace function public.wx_hash(p text)
returns text language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex');
$$;

/* Credencial de equipo: 244 bits aleatorios (dos UUID v4), base64url. */
create or replace function public.wx_token_nuevo(p_prefijo text)
returns text language sql volatile set search_path = public as $$
  select p_prefijo || translate(encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'base64'), E'+/=\n', '-_');
$$;

/* Código para capturar a mano: 12 símbolos de 32 (60 bits), XXXX-XXXX-XXXX.
   Se evitan los bytes 6 y 8 de cada UUID v4 (versión/variante, no aleatorios). */
create or replace function public.wx_codigo_nuevo()
returns text language plpgsql volatile set search_path = public as $$
declare
  b bytea := uuid_send(gen_random_uuid());
  a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  idx int[] := array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13];
  r text := '';
  i int;
begin
  for i in 1..12 loop
    r := r || substr(a, (get_byte(b, idx[i]) % 32) + 1, 1);
    if i in (4, 8) then r := r || '-'; end if;
  end loop;
  return r;
end $$;

create or replace function public.wx_codigo_hash(p text)
returns text language sql immutable set search_path = public as $$
  select public.wx_hash(upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')));
$$;

create or replace function public.wx_uuid(p text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return nullif(p, '')::uuid;
exception when others then return null;
end $$;

-- ============================================================================
--  CUENTA COMERCIAL (no da acceso a nada)
-- ============================================================================
create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  billing_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table public.accounts is
  'Agrupación COMERCIAL (facturación de Wybix). Jamás autoriza lectura ni escritura de datos: la frontera es negocios (Company).';

-- ============================================================================
--  COMPANY = negocios
-- ============================================================================
alter table public.negocios add column if not exists account_id uuid references public.accounts(id) on delete set null;
alter table public.negocios add column if not exists status text not null default 'ACTIVE';
alter table public.negocios add column if not exists updated_at timestamptz not null default now();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'negocios_status_check') then
    alter table public.negocios add constraint negocios_status_check check (status in ('ACTIVE', 'SUSPENDED', 'CLOSED'));
  end if;
end $$;

-- ============================================================================
--  OPERATIONAL LOCATION = sucursales
-- ============================================================================
alter table public.sucursales add column if not exists tipo text not null default 'BRANCH';
alter table public.sucursales add column if not exists status text not null default 'ACTIVE';
alter table public.sucursales add column if not exists instance_uuid uuid;
alter table public.sucursales add column if not exists install_secret_hash text;
alter table public.sucursales add column if not exists starts_at timestamptz;
alter table public.sucursales add column if not exists ends_at timestamptz;
alter table public.sucursales add column if not exists home_location_id uuid references public.sucursales(id) on delete set null;
alter table public.sucursales add column if not exists timezone text not null default 'America/Mexico_City';
alter table public.sucursales add column if not exists updated_at timestamptz not null default now();
-- Las ubicaciones nuevas ya no nacen de un equipo: device_key queda opcional
-- (los POS anteriores lo siguen mandando en provision/claim).
alter table public.sucursales alter column device_key drop not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sucursales_tipo_check') then
    alter table public.sucursales add constraint sucursales_tipo_check check (tipo in ('BRANCH', 'EVENT', 'WAREHOUSE', 'MOBILE'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sucursales_status_check') then
    alter table public.sucursales add constraint sucursales_status_check check (status in ('PENDING', 'ACTIVE', 'CLOSED', 'ARCHIVED'));
  end if;
end $$;
-- Una base de SQL Server (instance_uuid) = UNA ubicación. Es lo que impide
-- que dos PCs de la misma sucursal creen dos empresas.
create unique index if not exists ux_sucursales_instance on public.sucursales (instance_uuid) where instance_uuid is not null;
create unique index if not exists ux_sucursales_install_secret on public.sucursales (install_secret_hash) where install_secret_hash is not null;
create index if not exists ix_sucursales_negocio on public.sucursales (negocio_id);

-- ============================================================================
--  MEMBRESÍAS
-- ============================================================================
create table if not exists public.company_memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.negocios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('OWNER', 'ADMIN', 'MANAGER', 'VIEWER')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  location_ids uuid[],                      -- null = todas las ubicaciones de la empresa
  origin text not null default 'INVITE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id)
);
create index if not exists ix_memberships_user on public.company_memberships (user_id) where status = 'ACTIVE';

create table if not exists public.company_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.negocios(id) on delete cascade,
  role text not null check (role in ('OWNER', 'ADMIN', 'MANAGER', 'VIEWER')),
  location_ids uuid[],
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references auth.users(id) on delete set null,
  created_by_device uuid,
  created_by_user uuid,
  created_at timestamptz not null default now()
);

-- ============================================================================
--  EMPLEADOS Y CAJAS (aparecen con los hechos que manda el POS)
-- ============================================================================
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.negocios(id) on delete cascade,
  pos_user_uuid uuid not null,
  display_name text,
  home_location_id uuid references public.sucursales(id) on delete set null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (company_id, pos_user_uuid)
);

create table if not exists public.registers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid not null references public.sucursales(id) on delete cascade,
  register_uuid uuid not null,
  code text,
  name text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (location_id, register_uuid)
);

-- ============================================================================
--  DISPOSITIVOS
-- ============================================================================
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid not null references public.sucursales(id) on delete cascade,
  register_id uuid references public.registers(id) on delete set null,
  kind text not null check (kind in ('POS_PRIMARY', 'POS_SECONDARY', 'OPERATIONAL_SCREEN', 'LOCAL_HOST', 'MOBILE_POS')),
  device_uuid uuid,                         -- lo genera el propio equipo
  name text,
  machine_fingerprint text,                 -- hash del MachineGuid: informativo, NO identidad
  status text not null default 'ACTIVE' check (status in ('PENDING', 'ACTIVE', 'REVOKED')),
  credential_hash text,
  legacy_token boolean not null default false,
  app_version text,
  activated_at timestamptz,
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (location_id, device_uuid)
);
create unique index if not exists ux_devices_credential on public.devices (credential_hash) where credential_hash is not null;
create index if not exists ix_devices_company on public.devices (company_id);

create table if not exists public.device_enrollments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid not null references public.sucursales(id) on delete cascade,
  purpose text not null check (purpose in ('ENROLL_DEVICE', 'CLAIM_LOCATION')),
  kinds text[] not null,
  code_hash text not null unique,
  expires_at timestamptz not null,
  max_uses int not null default 1,
  uses int not null default 0,
  created_by_device uuid,
  created_by_user uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================================
--  HECHOS SINCRONIZADOS
-- ============================================================================
create table if not exists public.sync_events (
  event_uuid uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid not null references public.sucursales(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  aggregate_type text not null,
  aggregate_uuid uuid not null,
  aggregate_version bigint not null,
  event_type text not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  payload_version smallint not null default 1,
  payload jsonb not null,
  result text not null check (result in ('APPLIED', 'STALE', 'REJECTED'))
);
create index if not exists ix_sync_events_loc on public.sync_events (location_id, received_at desc);
create index if not exists ix_sync_events_agg on public.sync_events (aggregate_type, aggregate_uuid);

create table if not exists public.sales_facts (
  sale_uuid uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid not null references public.sucursales(id) on delete cascade,
  register_uuid uuid,
  folio bigint,
  business_date date not null,
  occurred_at timestamptz,
  total numeric(14, 2) not null default 0,
  paid_amount numeric(14, 2),
  balance numeric(14, 2),
  refunded_total numeric(14, 2) not null default 0,
  payment_method text,
  service_mode text,
  venta_esencial boolean,
  user_uuid uuid,
  version bigint not null,
  updated_at timestamptz not null default now()
);
create index if not exists ix_sales_facts_loc_date on public.sales_facts (location_id, business_date);

create table if not exists public.shift_facts (
  shift_uuid uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid not null references public.sucursales(id) on delete cascade,
  register_uuid uuid,
  closure_id_local int,
  status text not null check (status in ('OPEN', 'CLOSED')),
  business_date date,
  opened_at timestamptz,
  closed_at timestamptz,
  opening_cash numeric(14, 2),
  cash_expected numeric(14, 2),
  cash_counted numeric(14, 2),
  difference numeric(14, 2),
  blind_count boolean,
  opened_by_uuid uuid,
  closed_by_uuid uuid,
  authorized_by_uuid uuid,
  opened_device text,
  closed_device text,
  version bigint not null,
  updated_at timestamptz not null default now()
);
create index if not exists ix_shift_facts_loc on public.shift_facts (location_id, status, closed_at desc);

create table if not exists public.cash_movement_facts (
  movement_uuid uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid not null references public.sucursales(id) on delete cascade,
  shift_uuid uuid,
  register_uuid uuid,
  type text,
  amount numeric(14, 2),
  business_date date,
  occurred_at timestamptz,
  reference text,
  note text,
  user_uuid uuid,
  version bigint not null,
  updated_at timestamptz not null default now()
);
create index if not exists ix_cash_mov_facts_shift on public.cash_movement_facts (shift_uuid);

/* Avisos derivados de hechos. Cerrar un turno NUNCA depende de esto: el POS
   cierra local, el hecho llega cuando haya Internet y aquí solo queda el aviso
   pendiente. La entrega (push/correo con Resend) es Fase 3. */
create table if not exists public.notification_outbox (
  id bigserial primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid references public.sucursales(id) on delete cascade,
  kind text not null,
  ref_uuid uuid not null,
  payload jsonb not null default '{}',
  channels text[] not null default array['push', 'email', 'in_app'],
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (kind, ref_uuid)
);

-- ============================================================================
--  CFDI CON DUEÑO
-- ============================================================================
create table if not exists public.fiscal_issuers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.negocios(id) on delete cascade,
  fiscalapi_person_id text not null unique,
  rfc text not null,
  legal_name text,
  tax_regime text,
  zip_code text,
  -- ACTIVE                 registrado por el flujo nuevo (dueño cierto)
  -- PENDING_RECONCILIATION histórico reclamado por UNA empresa: puede timbrar
  --                        (no se rompe el CFDI legítimo) pero queda contado y
  --                        pendiente de confirmar por Wybix.
  -- CONFLICT               dos empresas lo reclaman: bloqueado para todas.
  -- REVOKED                retirado.
  status text not null check (status in ('ACTIVE', 'PENDING_RECONCILIATION', 'CONFLICT', 'REVOKED')),
  origin text not null check (origin in ('REGISTERED', 'HISTORICAL_CLAIM')),
  created_by_device uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_fiscal_issuers_company on public.fiscal_issuers (company_id);

create table if not exists public.fiscal_issuer_claims (
  id bigserial primary key,
  fiscalapi_person_id text not null,
  company_id uuid not null references public.negocios(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  rfc text,
  created_at timestamptz not null default now(),
  unique (fiscalapi_person_id, company_id)
);

create table if not exists public.fiscal_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid references public.sucursales(id) on delete set null,
  device_id uuid references public.devices(id) on delete set null,
  issuer_id uuid references public.fiscal_issuers(id) on delete set null,
  fiscalapi_invoice_id text not null unique,
  sat_uuid text,
  series text,
  folio text,
  total numeric(14, 2),
  status text not null default 'STAMPED' check (status in ('STAMPED', 'CANCEL_REQUESTED', 'CANCELLED')),
  ownership text not null default 'VERIFIED' check (ownership in ('VERIFIED', 'PENDING_RECONCILIATION', 'CONFLICT')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_fiscal_invoices_company on public.fiscal_invoices (company_id);

create table if not exists public.fiscal_invoice_claims (
  id bigserial primary key,
  fiscalapi_invoice_id text not null,
  company_id uuid not null references public.negocios(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (fiscalapi_invoice_id, company_id)
);

-- ============================================================================
--  RASTRO Y PENDIENTES
-- ============================================================================
create table if not exists public.cloud_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_kind text not null,                 -- DEVICE | USER | SERVICE
  actor_id text,
  company_id uuid,
  action text not null,
  result text not null,                     -- OK | DENIED | ...
  detail jsonb not null default '{}'
);
create index if not exists ix_cloud_audit_company on public.cloud_audit (company_id, at desc);

create table if not exists public.reconciliation_items (
  id bigserial primary key,
  kind text not null,
  ref text not null,
  company_id uuid,
  detail jsonb not null default '{}',
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (kind, ref)
);

create or replace function public.wx_audit(p_actor_kind text, p_actor_id text, p_company uuid, p_action text, p_result text, p_detail jsonb default '{}')
returns void language sql security definer set search_path = public as $$
  insert into public.cloud_audit (actor_kind, actor_id, company_id, action, result, detail)
  values (p_actor_kind, p_actor_id, p_company, p_action, p_result, coalesce(p_detail, '{}'));
$$;

create or replace function public.wx_pendiente(p_kind text, p_ref text, p_company uuid, p_detail jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.reconciliation_items (kind, ref, company_id, detail)
  values (p_kind, p_ref, p_company, coalesce(p_detail, '{}'))
  on conflict (kind, ref) do nothing;
$$;

-- ============================================================================
--  LICENCIAS -> EMPRESA -> DERECHOS -> ACTIVACIONES DE EQUIPO
-- ============================================================================
alter table public.licenses add column if not exists company_id uuid references public.negocios(id) on delete set null;
alter table public.licenses add column if not exists account_id uuid references public.accounts(id) on delete set null;
create index if not exists ix_licenses_company on public.licenses (company_id);
alter table public.license_activations add column if not exists device_id uuid references public.devices(id) on delete set null;
alter table public.license_activations add column if not exists location_id uuid references public.sucursales(id) on delete set null;
alter table public.license_activations add column if not exists kind text not null default 'POS';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'license_activations_kind_check') then
    alter table public.license_activations add constraint license_activations_kind_check check (kind in ('POS', 'OPERATIONAL_SCREEN', 'MOBILE_POS'));
  end if;
end $$;

/* Los derechos nuevos se PREPARAN en el catálogo (fuente de verdad) sin tocar
   precios ni el certificado firmado: license_runtime no cambia. Solo se
   agregan claves que falten; nunca se pisa una que ya exista. */
update public.license_catalog c
   set grants = jsonb_build_object('companies_max', 1, 'locations_max', 1, 'mobile_pos', false) || c.grants
 where c.code in ('EDITION_MONO', 'EDITION_MULTI')
   and not (c.grants ? 'locations_max');
update public.license_catalog c
   set grants = jsonb_build_object('locations_max', null) || c.grants
 where c.code = 'ADDON_MULTIBRANCH' and not (c.grants ? 'locations_max');

/* Derechos de una EMPRESA: la suma de sus licencias activas.
   null = sin límite. Fase 1: se CALCULAN y se informan; no se aplican todavía
   (aplicarlos sin que la web venda por empresa bloquearía a clientes reales). */
create or replace function public.company_entitlements(p_company uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with l as (
    select x.id, x.plan, x.addons,
           (select grants from public.license_catalog where code = case when x.plan = 'multi' then 'EDITION_MULTI' else 'EDITION_MONO' end) g
      from public.licenses x
     where x.company_id = p_company and x.status = 'activa'
  ), v as (
    select l.*,
           case when 'MULTIBRANCH' = any(coalesce(l.addons, '{}')) then null
                else coalesce((l.g->>'locations_max')::int, 1) end as loc_max,
           public.license_registers_max(l.plan) as reg_max,
           coalesce((l.g->>'companies_max')::int, 1) as comp_max,
           coalesce((l.g->>'mobile_pos')::boolean, false) as mobile
      from l
  )
  select jsonb_build_object(
    'licenses', (select count(*) from v),
    'enforced', false,
    'companies_max', case when not exists (select 1 from v) then null else (select max(comp_max) from v) end,
    'locations_max', case when not exists (select 1 from v) or exists (select 1 from v where loc_max is null) then null
                          else (select sum(loc_max) from v) end,
    'registers_max', case when not exists (select 1 from v) or exists (select 1 from v where reg_max is null) then null
                          else (select sum(reg_max) from v) end,
    'operational_screens_max', null,
    'mobile_pos', coalesce((select bool_or(mobile) from v), false),
    'locations_used', (select count(*) from public.sucursales s where s.negocio_id = p_company and s.tipo = 'BRANCH' and s.status in ('ACTIVE', 'PENDING'))
  );
$$;

-- ============================================================================
--  AUTORIZACIÓN POR MEMBRESÍA (para RLS y para la app del dueño)
-- ============================================================================
create or replace function public.wx_rol(p_company uuid)
returns text language sql stable security definer set search_path = public as $$
  select m.role from public.company_memberships m
   where m.company_id = p_company and m.user_id = (select auth.uid()) and m.status = 'ACTIVE';
$$;

create or replace function public.wx_es_miembro(p_company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.company_memberships m
                  where m.company_id = p_company and m.user_id = (select auth.uid()) and m.status = 'ACTIVE');
$$;

create or replace function public.wx_puede_ubicacion(p_location uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sucursales s
                   join public.company_memberships m on m.company_id = s.negocio_id
                  where s.id = p_location and m.user_id = (select auth.uid()) and m.status = 'ACTIVE'
                    and (m.location_ids is null or s.id = any (m.location_ids)));
$$;

-- ============================================================================
--  DISPOSITIVOS: autenticación y emisión de credenciales
-- ============================================================================

/* La credencial del equipo -> el equipo. Solo ACTIVOS. */
create or replace function public.device_autenticar(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; v_hash text := public.wx_hash(p->>'token');
begin
  if length(coalesce(p->>'token', '')) < 20 then return jsonb_build_object('ok', false, 'code', 'NO_TOKEN'); end if;
  select * into d from public.devices where credential_hash = v_hash and status = 'ACTIVE';
  if not found then return jsonb_build_object('ok', false, 'code', 'BAD_TOKEN'); end if;
  update public.devices set last_seen_at = now(),
         app_version = coalesce(nullif(p->>'app_version', ''), app_version)
   where id = d.id;
  return jsonb_build_object('ok', true, 'device_id', d.id, 'company_id', d.company_id, 'location_id', d.location_id,
                            'kind', d.kind, 'legacy', d.legacy_token);
end $$;

/* Interna: emite (o reemite) la credencial de un equipo en una ubicación. */
create or replace function public.wx_emitir_dispositivo(p_location uuid, p_kind text, p_device_uuid uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_token text := public.wx_token_nuevo('wxd_'); v_id uuid; v_secret text;
begin
  select negocio_id into v_company from public.sucursales where id = p_location;
  if p_kind = 'POS_PRIMARY' then
    -- Una ubicación tiene UNA principal: la anterior deja de valer.
    update public.devices set status = 'REVOKED', revoked_at = now(), credential_hash = null
     where location_id = p_location and kind = 'POS_PRIMARY' and status = 'ACTIVE'
       and (p_device_uuid is null or device_uuid is distinct from p_device_uuid);
  end if;
  insert into public.devices (company_id, location_id, kind, device_uuid, name, machine_fingerprint, status,
                              credential_hash, legacy_token, app_version, activated_at, last_seen_at)
  values (v_company, p_location, p_kind, p_device_uuid, left(p->>'name', 120), left(p->>'machine_fingerprint', 128), 'ACTIVE',
          public.wx_hash(v_token), false, left(p->>'app_version', 40), now(), now())
  on conflict (location_id, device_uuid) do update
     set kind = excluded.kind, name = coalesce(excluded.name, devices.name),
         machine_fingerprint = coalesce(excluded.machine_fingerprint, devices.machine_fingerprint),
         status = 'ACTIVE', revoked_at = null, credential_hash = excluded.credential_hash, legacy_token = false,
         app_version = coalesce(excluded.app_version, devices.app_version), activated_at = now(), last_seen_at = now()
  returning id into v_id;

  if p_kind = 'POS_PRIMARY' then
    -- La llave de instalación vive en la base local de la sucursal: quien
    -- comparte esa base (las secundarias) puede unirse a ESTA ubicación.
    v_secret := public.wx_token_nuevo('wxi_');
    update public.sucursales set install_secret_hash = public.wx_hash(v_secret), updated_at = now() where id = p_location;
  end if;

  perform public.wx_audit('DEVICE', v_id::text, v_company, 'DEVICE_ISSUED', 'OK', jsonb_build_object('kind', p_kind, 'location_id', p_location));
  return jsonb_build_object('ok', true, 'device_id', v_id, 'company_id', v_company, 'location_id', p_location,
                            'kind', p_kind, 'token', v_token, 'install_secret', v_secret);
end $$;

/*
 * BOOTSTRAP de una instalación PRINCIPAL.
 *   p = { instance_uuid, device_uuid, nombre_negocio, nombre_sucursal, legacy_token?,
 *         name?, machine_fingerprint?, app_version? }
 *
 *  1. Trae el token ANTERIOR (POS que ya sincronizaba): se queda con SU empresa
 *     y SU ubicación; se le asigna la instancia. Si esa instancia ya era de
 *     otra ubicación (duplicado del modelo viejo) se usa la que ya la tenía y
 *     el duplicado queda en `reconciliation_items`. No se fusiona solo.
 *  2. La instancia ya es de una ubicación: NO se crea nada. El equipo debe
 *     unirse con la llave de instalación (pos_enroll). Así dos PCs de la misma
 *     base no crean dos empresas.
 *  3. Instancia nueva: empresa + ubicación BRANCH + equipo principal.
 */
create or replace function public.pos_bootstrap(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_instance uuid := public.wx_uuid(p->>'instance_uuid');
  v_device uuid := public.wx_uuid(p->>'device_uuid');
  v_loc public.sucursales%rowtype;
  v_otra public.sucursales%rowtype;
  v_company uuid;
  v_legacy text := nullif(p->>'legacy_token', '');
begin
  if v_instance is null or v_device is null then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  perform pg_advisory_xact_lock(hashtextextended('wx-instance:' || v_instance::text, 0));

  if v_legacy is not null then
    select s.* into v_loc from public.sucursales s
     where s.id = (select d.location_id from public.devices d where d.credential_hash = public.wx_hash(v_legacy) and d.status = 'ACTIVE')
        or s.sync_token_hash = public.wx_hash(v_legacy)
     limit 1;
    if found then
      if v_loc.instance_uuid is null then
        select * into v_otra from public.sucursales where instance_uuid = v_instance;
        if found then
          perform public.wx_pendiente('LOCATION_DUPLICATE', v_loc.id::text, v_loc.negocio_id,
            jsonb_build_object('canonical_location', v_otra.id, 'canonical_company', v_otra.negocio_id, 'instance_uuid', v_instance));
          v_loc := v_otra;
        else
          update public.sucursales set instance_uuid = v_instance, updated_at = now() where id = v_loc.id;
        end if;
      elsif v_loc.instance_uuid <> v_instance then
        perform public.wx_audit('DEVICE', null, v_loc.negocio_id, 'BOOTSTRAP', 'DENIED', jsonb_build_object('code', 'INSTANCE_MISMATCH'));
        return jsonb_build_object('ok', false, 'code', 'INSTANCE_MISMATCH');
      end if;
      -- El token anterior deja de valer: desde aquí, credencial por equipo.
      update public.devices set status = 'REVOKED', revoked_at = now(), credential_hash = null
       where credential_hash = public.wx_hash(v_legacy);
      update public.sucursales set sync_token_hash = null where sync_token_hash = public.wx_hash(v_legacy);
      return public.wx_emitir_dispositivo(v_loc.id, 'POS_PRIMARY', v_device, p) || jsonb_build_object('created', false, 'upgraded', true);
    end if;
  end if;

  select * into v_loc from public.sucursales where instance_uuid = v_instance;
  if found then
    return jsonb_build_object('ok', false, 'code', 'INSTANCE_KNOWN', 'company_id', v_loc.negocio_id, 'location_id', v_loc.id);
  end if;

  insert into public.negocios (nombre) values (coalesce(nullif(left(trim(p->>'nombre_negocio'), 120), ''), 'Mi negocio'))
  returning id into v_company;
  insert into public.sucursales (negocio_id, nombre, tipo, status, instance_uuid)
  values (v_company, coalesce(nullif(left(trim(p->>'nombre_sucursal'), 120), ''), 'Matriz'), 'BRANCH', 'ACTIVE', v_instance)
  returning * into v_loc;
  return public.wx_emitir_dispositivo(v_loc.id, 'POS_PRIMARY', v_device, p) || jsonb_build_object('created', true);
end $$;

/*
 * UNIR un equipo.
 *   con llave de instalación: { install_secret, instance_uuid, device_uuid, kind }
 *       quien comparte la base de la sucursal (secundarias, Local Host, o la
 *       principal reinstalada). La instancia debe coincidir.
 *   con código:               { code, instance_uuid?, device_uuid, kind }
 *       CLAIM_LOCATION: la principal de una sucursal NUEVA (Norte) reclama la
 *       ubicación que el dueño creó; la ubicación queda ligada a su instancia.
 *       ENROLL_DEVICE: un equipo más en una ubicación existente.
 */
create or replace function public.pos_enroll(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_instance uuid := public.wx_uuid(p->>'instance_uuid');
  v_device uuid := public.wx_uuid(p->>'device_uuid');
  v_kind text := coalesce(nullif(p->>'kind', ''), 'POS_SECONDARY');
  v_loc public.sucursales%rowtype;
  e public.device_enrollments%rowtype;
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

  update public.device_enrollments set uses = uses + 1 where id = e.id;
  return public.wx_emitir_dispositivo(v_loc.id, v_kind, v_device, p);
end $$;

/* Quién soy: equipo, empresa, ubicación y derechos. */
create or replace function public.pos_whoami(p jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ok', true,
    'device', jsonb_build_object('id', d.id, 'kind', d.kind, 'name', d.name, 'status', d.status, 'last_sync_at', d.last_sync_at),
    'company', jsonb_build_object('id', n.id, 'nombre', n.nombre, 'status', n.status),
    'location', jsonb_build_object('id', s.id, 'nombre', s.nombre, 'tipo', s.tipo, 'status', s.status, 'instance_uuid', s.instance_uuid),
    'entitlements', public.company_entitlements(n.id))
    from public.devices d join public.sucursales s on s.id = d.location_id join public.negocios n on n.id = d.company_id
   where d.id = public.wx_uuid(p->>'device_id') and d.status = 'ACTIVE';
$$;

/* Interna: quién actúa. Un equipo principal o un usuario OWNER/ADMIN. */
create or replace function public.wx_actor_admin(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices%rowtype; v_user uuid := public.wx_uuid(p->>'user_id'); v_company uuid := public.wx_uuid(p->>'company_id'); v_rol text;
begin
  if p ? 'device_id' then
    select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE';
    if not found or d.kind <> 'POS_PRIMARY' then return null; end if;
    return jsonb_build_object('kind', 'DEVICE', 'id', d.id, 'company_id', d.company_id, 'location_id', d.location_id);
  end if;
  if v_user is null or v_company is null then return null; end if;
  select role into v_rol from public.company_memberships where company_id = v_company and user_id = v_user and status = 'ACTIVE';
  -- OJO: `null not in (...)` es null, no true. Sin membresía = sin permiso.
  if v_rol is null or v_rol not in ('OWNER', 'ADMIN') then return null; end if;
  return jsonb_build_object('kind', 'USER', 'id', v_user, 'company_id', v_company, 'role', v_rol);
end $$;

/*
 * NUEVA UBICACIÓN de la MISMA empresa (Norte de I Do Nut) + código para que
 * su POS principal la reclame.
 *   p = { device_id | (user_id + company_id), nombre, tipo, starts_at?, ends_at?, home_location_id? }
 */
create or replace function public.pos_create_location(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wx_actor_admin(p); v_tipo text := upper(coalesce(nullif(p->>'tipo', ''), 'BRANCH'));
        v_loc uuid; v_code text := public.wx_codigo_nuevo(); v_home uuid := public.wx_uuid(p->>'home_location_id'); v_company uuid;
begin
  if a is null then
    perform public.wx_audit('UNKNOWN', coalesce(p->>'device_id', p->>'user_id'), public.wx_uuid(p->>'company_id'), 'CREATE_LOCATION', 'DENIED', '{}');
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;
  v_company := (a->>'company_id')::uuid;
  if v_tipo in ('WAREHOUSE', 'MOBILE') then return jsonb_build_object('ok', false, 'code', 'RESERVED_TYPE'); end if;
  if v_tipo not in ('BRANCH', 'EVENT') then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  if coalesce(trim(p->>'nombre'), '') = '' then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  if v_home is not null and not exists (select 1 from public.sucursales where id = v_home and negocio_id = v_company) then
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;

  insert into public.sucursales (negocio_id, nombre, tipo, status, starts_at, ends_at, home_location_id)
  values (v_company, left(trim(p->>'nombre'), 120), v_tipo, 'PENDING',
          nullif(p->>'starts_at', '')::timestamptz, nullif(p->>'ends_at', '')::timestamptz, v_home)
  returning id into v_loc;
  insert into public.device_enrollments (company_id, location_id, purpose, kinds, code_hash, expires_at,
                                         created_by_device, created_by_user)
  values (v_company, v_loc, 'CLAIM_LOCATION', array['POS_PRIMARY'], public.wx_codigo_hash(v_code), now() + interval '72 hours',
          case when a->>'kind' = 'DEVICE' then (a->>'id')::uuid end, case when a->>'kind' = 'USER' then (a->>'id')::uuid end);
  perform public.wx_audit(a->>'kind', a->>'id', v_company, 'CREATE_LOCATION', 'OK', jsonb_build_object('location_id', v_loc, 'tipo', v_tipo));
  return jsonb_build_object('ok', true, 'location_id', v_loc, 'company_id', v_company, 'code', v_code,
                            'expires_at', now() + interval '72 hours', 'entitlements', public.company_entitlements(v_company));
end $$;

/* Código para unir un equipo más a una ubicación existente. */
create or replace function public.pos_create_enrollment(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wx_actor_admin(p); v_loc uuid; v_code text := public.wx_codigo_nuevo();
        v_kinds text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(p->'kinds') x), array['POS_SECONDARY', 'OPERATIONAL_SCREEN', 'LOCAL_HOST']);
begin
  if a is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  v_loc := coalesce(public.wx_uuid(p->>'location_id'), (a->>'location_id')::uuid);
  if not exists (select 1 from public.sucursales where id = v_loc and negocio_id = (a->>'company_id')::uuid) then
    perform public.wx_audit(a->>'kind', a->>'id', (a->>'company_id')::uuid, 'CREATE_ENROLLMENT', 'DENIED', jsonb_build_object('location_id', v_loc));
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;
  if exists (select 1 from unnest(v_kinds) k where k not in ('POS_SECONDARY', 'OPERATIONAL_SCREEN', 'LOCAL_HOST', 'MOBILE_POS')) then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  insert into public.device_enrollments (company_id, location_id, purpose, kinds, code_hash, expires_at, created_by_device, created_by_user)
  values ((a->>'company_id')::uuid, v_loc, 'ENROLL_DEVICE', v_kinds, public.wx_codigo_hash(v_code), now() + interval '24 hours',
          case when a->>'kind' = 'DEVICE' then (a->>'id')::uuid end, case when a->>'kind' = 'USER' then (a->>'id')::uuid end);
  return jsonb_build_object('ok', true, 'code', v_code, 'location_id', v_loc, 'expires_at', now() + interval '24 hours');
end $$;

/* La principal pide una llave de instalación nueva (rota la anterior). */
create or replace function public.pos_install_secret(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; v_secret text := public.wx_token_nuevo('wxi_');
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE' and kind = 'POS_PRIMARY';
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  update public.sucursales set install_secret_hash = public.wx_hash(v_secret), updated_at = now() where id = d.location_id;
  return jsonb_build_object('ok', true, 'install_secret', v_secret);
end $$;

/* Liga la licencia que activó ESTE equipo con su empresa. Nunca reasigna: si
   la licencia ya es de otra empresa queda como pendiente de conciliar. */
create or replace function public.pos_vincular_licencia(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; a public.license_activations%rowtype; l public.licenses%rowtype;
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE';
  if not found or d.kind <> 'POS_PRIMARY' or coalesce(p->>'machine_id', '') = '' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  -- Lo que ya hacía `stamp_license`: la ubicación recuerda su máquina licenciada.
  update public.sucursales set license_machine_id = left(p->>'machine_id', 128) where id = d.location_id;
  select * into a from public.license_activations where machine_id = p->>'machine_id' and active order by last_seen_at desc limit 1;
  if not found then return jsonb_build_object('ok', false, 'code', 'NO_ACTIVATION'); end if;
  select * into l from public.licenses where id = a.license_id for update;
  if l.company_id is not null and l.company_id <> d.company_id then
    perform public.wx_pendiente('LICENSE_COMPANY_CONFLICT', l.id::text || ':' || d.company_id::text, d.company_id,
      jsonb_build_object('license_id', l.id, 'linked_company', l.company_id, 'claiming_company', d.company_id));
    return jsonb_build_object('ok', false, 'code', 'CONFLICT');
  end if;
  update public.licenses set company_id = d.company_id where id = l.id and company_id is null;
  update public.license_activations set device_id = d.id, location_id = d.location_id where id = a.id;
  return jsonb_build_object('ok', true, 'license_id', l.id, 'company_id', d.company_id);
end $$;

/*
 * APROVISIONAMIENTO ANTERIOR (POS sin actualizar): lo mismo que hacía la Edge
 * Function `pos-sync` con `provision`/`claim`, ahora en SQL para probarlo.
 *   p = { action: provision|claim, device_key, sucursal_id?, nombre?, equipo? }
 * Sigue creando un negocio por equipo: es el contrato de los binarios viejos.
 * Los POS nuevos usan pos_bootstrap / pos_enroll.
 */
create or replace function public.pos_provision_legado(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_key text := trim(coalesce(p->>'device_key', '')); s public.sucursales%rowtype; v_neg uuid; v_token text := public.wx_token_nuevo('');
begin
  if length(v_key) < 8 or length(v_key) > 128 then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  select * into s from public.sucursales
   where device_key = v_key and (p->>'action' <> 'claim' or id = public.wx_uuid(p->>'sucursal_id'));
  if not found then
    if p->>'action' = 'claim' then return jsonb_build_object('ok', false, 'code', 'NO_MATCH'); end if;
    insert into public.negocios (nombre) values (coalesce(nullif(left(trim(p->>'nombre'), 120), ''), 'Mi negocio')) returning id into v_neg;
    insert into public.sucursales (negocio_id, nombre, device_key) values (v_neg, coalesce(nullif(left(p->>'equipo', 120), ''), 'Matriz'), v_key)
    returning * into s;
  end if;
  -- Un token nuevo cada vez: reinstalar invalida el anterior (el disparador
  -- lo refleja en `devices`).
  update public.sucursales set sync_token_hash = public.wx_hash(v_token) where id = s.id;
  return jsonb_build_object('ok', true, 'sucursalId', s.id, 'negocioId', s.negocio_id, 'token', v_token);
end $$;

-- Los POS anteriores siguen rotando su token con `provision`/`claim`
-- (sucursales.sync_token_hash). Este disparador lo refleja como equipo, para
-- que TODA autenticación pase por `devices`.
create or replace function public.wx_tr_token_legado()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.sync_token_hash is not null and new.sync_token_hash is distinct from old.sync_token_hash then
    update public.devices set status = 'REVOKED', revoked_at = now(), credential_hash = null
     where location_id = new.id and legacy_token and credential_hash is distinct from new.sync_token_hash;
    insert into public.devices (company_id, location_id, kind, name, status, credential_hash, legacy_token, activated_at)
    values (new.negocio_id, new.id, 'POS_PRIMARY', 'POS (versión anterior)', 'ACTIVE', new.sync_token_hash, true, now())
    on conflict (credential_hash) where credential_hash is not null do nothing;
  end if;
  return new;
end $$;
drop trigger if exists tr_sucursales_token_legado on public.sucursales;
create trigger tr_sucursales_token_legado after insert or update of sync_token_hash on public.sucursales
  for each row execute function public.wx_tr_token_legado();

-- ============================================================================
--  INGESTA IDEMPOTENTE DE HECHOS
-- ============================================================================

/* Proyección: un hecho -> su tabla. Devuelve APPLIED, STALE (versión vieja) o
   REJECTED (el agregado es de OTRA empresa: nunca se sobreescribe). */
create or replace function public.wx_proyectar(d public.devices, v_tz text, ev jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare
  t text := ev->>'aggregate_type';
  agg uuid := public.wx_uuid(ev->>'aggregate_uuid');
  ver bigint := (ev->>'aggregate_version')::bigint;
  pl jsonb := ev->'payload';
  dueno uuid;
  n int;
  reg uuid := public.wx_uuid(ev->'payload'->'register'->>'uuid');
begin
  -- Cajas y empleados que aparecen en el hecho (solo de ESTA empresa/ubicación).
  if reg is not null then
    insert into public.registers (company_id, location_id, register_uuid, code, name)
    values (d.company_id, d.location_id, reg, pl->'register'->>'code', pl->'register'->>'name')
    on conflict (location_id, register_uuid) do update set code = excluded.code, name = excluded.name, last_seen_at = now();
  end if;
  insert into public.employees (company_id, pos_user_uuid, display_name, home_location_id)
  select distinct on (public.wx_uuid(u->>'uuid')) d.company_id, public.wx_uuid(u->>'uuid'), u->>'name', d.location_id
    from (values (pl->'user'), (pl->'opened_by'), (pl->'closed_by'), (pl->'authorized_by')) x(u)
   where public.wx_uuid(u->>'uuid') is not null
  on conflict (company_id, pos_user_uuid) do update set display_name = excluded.display_name, last_seen_at = now();

  if t = 'SALE' then
    select company_id into dueno from public.sales_facts where sale_uuid = agg;
    if dueno is not null and dueno <> d.company_id then return 'REJECTED'; end if;
    insert into public.sales_facts as f (sale_uuid, company_id, location_id, register_uuid, folio, business_date, occurred_at,
      total, paid_amount, balance, refunded_total, payment_method, service_mode, venta_esencial, user_uuid, version)
    values (agg, d.company_id, d.location_id, reg, (pl->>'folio')::bigint, (pl->>'business_date')::date,
      coalesce((ev->>'occurred_at')::timestamptz, (pl->>'occurred_local')::timestamp at time zone v_tz),
      coalesce((pl->>'total')::numeric, 0), (pl->>'paid_amount')::numeric, (pl->>'balance')::numeric,
      coalesce((pl->>'refunded_total')::numeric, 0), pl->>'payment_method', pl->>'service_mode',
      (pl->>'venta_esencial')::boolean, public.wx_uuid(pl->'user'->>'uuid'), ver)
    on conflict (sale_uuid) do update set
      folio = excluded.folio, business_date = excluded.business_date, occurred_at = excluded.occurred_at,
      total = excluded.total, paid_amount = excluded.paid_amount, balance = excluded.balance,
      refunded_total = excluded.refunded_total, payment_method = excluded.payment_method,
      service_mode = excluded.service_mode, venta_esencial = excluded.venta_esencial,
      user_uuid = excluded.user_uuid, register_uuid = excluded.register_uuid, version = excluded.version, updated_at = now()
    where f.version < excluded.version and f.company_id = excluded.company_id;
    get diagnostics n = row_count;
    return case when n = 1 then 'APPLIED' else 'STALE' end;

  elsif t = 'SHIFT' then
    select company_id into dueno from public.shift_facts where shift_uuid = agg;
    if dueno is not null and dueno <> d.company_id then return 'REJECTED'; end if;
    insert into public.shift_facts as f (shift_uuid, company_id, location_id, register_uuid, closure_id_local, status, business_date,
      opened_at, closed_at, opening_cash, cash_expected, cash_counted, difference, blind_count,
      opened_by_uuid, closed_by_uuid, authorized_by_uuid, opened_device, closed_device, version)
    values (agg, d.company_id, d.location_id, reg, (pl->>'closure_id')::int, coalesce(pl->>'status', 'OPEN'), (pl->>'business_date')::date,
      (pl->>'opened_local')::timestamp at time zone v_tz, (pl->>'closed_local')::timestamp at time zone v_tz,
      (pl->>'opening_cash')::numeric, (pl->>'cash_expected')::numeric, (pl->>'cash_counted')::numeric, (pl->>'difference')::numeric,
      (pl->>'blind_count')::boolean, public.wx_uuid(pl->'opened_by'->>'uuid'), public.wx_uuid(pl->'closed_by'->>'uuid'),
      public.wx_uuid(pl->'authorized_by'->>'uuid'), pl->>'opened_device', pl->>'closed_device', ver)
    on conflict (shift_uuid) do update set
      status = excluded.status, business_date = excluded.business_date, opened_at = excluded.opened_at, closed_at = excluded.closed_at,
      opening_cash = excluded.opening_cash, cash_expected = excluded.cash_expected, cash_counted = excluded.cash_counted,
      difference = excluded.difference, blind_count = excluded.blind_count, opened_by_uuid = excluded.opened_by_uuid,
      closed_by_uuid = excluded.closed_by_uuid, authorized_by_uuid = excluded.authorized_by_uuid,
      opened_device = excluded.opened_device, closed_device = excluded.closed_device, register_uuid = excluded.register_uuid,
      version = excluded.version, updated_at = now()
    where f.version < excluded.version and f.company_id = excluded.company_id;
    get diagnostics n = row_count;
    if n = 1 and coalesce(pl->>'status', '') = 'CLOSED' then
      insert into public.notification_outbox (company_id, location_id, kind, ref_uuid, payload)
      values (d.company_id, d.location_id, 'SHIFT_CLOSED', agg, jsonb_build_object(
        'register', pl->'register'->>'name', 'closed_by', pl->'closed_by'->>'name', 'closed_local', pl->>'closed_local',
        'cash_expected', pl->'cash_expected', 'cash_counted', pl->'cash_counted', 'difference', pl->'difference',
        'blind_count', pl->'blind_count'))
      on conflict (kind, ref_uuid) do nothing;
    end if;
    return case when n = 1 then 'APPLIED' else 'STALE' end;

  elsif t = 'CASH_MOVEMENT' then
    select company_id into dueno from public.cash_movement_facts where movement_uuid = agg;
    if dueno is not null and dueno <> d.company_id then return 'REJECTED'; end if;
    insert into public.cash_movement_facts as f (movement_uuid, company_id, location_id, shift_uuid, register_uuid, type, amount,
      business_date, occurred_at, reference, note, user_uuid, version)
    values (agg, d.company_id, d.location_id, public.wx_uuid(pl->>'shift_uuid'), reg, pl->>'type', (pl->>'amount')::numeric,
      (pl->>'business_date')::date, coalesce((ev->>'occurred_at')::timestamptz, (pl->>'occurred_local')::timestamp at time zone v_tz),
      left(pl->>'reference', 200), left(pl->>'note', 400), public.wx_uuid(pl->'user'->>'uuid'), ver)
    on conflict (movement_uuid) do update set
      type = excluded.type, amount = excluded.amount, business_date = excluded.business_date, occurred_at = excluded.occurred_at,
      reference = excluded.reference, note = excluded.note, shift_uuid = excluded.shift_uuid, version = excluded.version, updated_at = now()
    where f.version < excluded.version and f.company_id = excluded.company_id;
    get diagnostics n = row_count;
    return case when n = 1 then 'APPLIED' else 'STALE' end;
  end if;
  return 'REJECTED';
end $$;

/*
 * Recibe un lote del outbox del POS.
 *   p = { device_id, envelope: { company_uuid?, location_uuid?, instance_uuid? }, events: [...] }
 * La empresa y la ubicación SALEN DEL EQUIPO AUTENTICADO, nunca del sobre: si
 * el sobre dice otra cosa, se rechaza el lote completo.
 * Respuesta por evento: APPLIED | DUPLICATE | REJECTED | ERROR (el POS
 * reintenta solo los ERROR).
 */
create or replace function public.sync_ingest(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d public.devices%rowtype;
  v_tz text;
  v_inst uuid;
  ev jsonb;
  v_uuid uuid;
  v_prev public.sync_events%rowtype;
  v_res text;
  salida jsonb := '[]';
  env jsonb := coalesce(p->'envelope', '{}');
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE';
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if d.kind <> 'POS_PRIMARY' then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  select timezone, instance_uuid into v_tz, v_inst from public.sucursales where id = d.location_id;
  if (nullif(env->>'company_uuid', '') is not null and public.wx_uuid(env->>'company_uuid') is distinct from d.company_id)
     or (nullif(env->>'location_uuid', '') is not null and public.wx_uuid(env->>'location_uuid') is distinct from d.location_id)
     or (nullif(env->>'instance_uuid', '') is not null and v_inst is not null and public.wx_uuid(env->>'instance_uuid') is distinct from v_inst) then
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'SYNC_INGEST', 'DENIED', jsonb_build_object('code', 'ENVELOPE_MISMATCH', 'envelope', env));
    return jsonb_build_object('ok', false, 'code', 'ENVELOPE_MISMATCH');
  end if;
  if jsonb_typeof(p->'events') <> 'array' or jsonb_array_length(p->'events') > 500 then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;

  for ev in select * from jsonb_array_elements(p->'events') loop
    v_uuid := public.wx_uuid(ev->>'event_uuid');
    begin
      if v_uuid is null or public.wx_uuid(ev->>'aggregate_uuid') is null or jsonb_typeof(ev->'payload') <> 'object'
         or coalesce(ev->>'aggregate_type', '') not in ('SALE', 'SHIFT', 'CASH_MOVEMENT') then
        salida := salida || jsonb_build_object('event_uuid', ev->>'event_uuid', 'result', 'REJECTED', 'error', 'evento inválido');
        continue;
      end if;
      select * into v_prev from public.sync_events where event_uuid = v_uuid;
      if found then
        -- El MISMO evento otra vez: un solo efecto. Si lo manda otra empresa
        -- no se le confirma nada de la ajena.
        salida := salida || jsonb_build_object('event_uuid', v_uuid,
          'result', case when v_prev.company_id = d.company_id then 'DUPLICATE' else 'REJECTED' end);
        continue;
      end if;
      v_res := public.wx_proyectar(d, v_tz, ev);
      insert into public.sync_events (event_uuid, company_id, location_id, device_id, aggregate_type, aggregate_uuid,
        aggregate_version, event_type, occurred_at, payload_version, payload, result)
      values (v_uuid, d.company_id, d.location_id, d.id, ev->>'aggregate_type', public.wx_uuid(ev->>'aggregate_uuid'),
        (ev->>'aggregate_version')::bigint, left(ev->>'event_type', 40), (ev->>'occurred_at')::timestamptz,
        coalesce((ev->>'payload_version')::smallint, 1), ev->'payload', v_res)
      on conflict (event_uuid) do nothing;
      if v_res = 'REJECTED' then
        perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'SYNC_EVENT', 'DENIED',
          jsonb_build_object('event_uuid', v_uuid, 'aggregate', ev->>'aggregate_type', 'code', 'FOREIGN_AGGREGATE'));
      end if;
      -- STALE también es éxito para el POS: la nube ya tiene algo más nuevo.
      salida := salida || jsonb_build_object('event_uuid', v_uuid, 'result', case when v_res = 'REJECTED' then 'REJECTED' else 'APPLIED' end);
    exception when others then
      salida := salida || jsonb_build_object('event_uuid', ev->>'event_uuid', 'result', 'ERROR', 'error', left(sqlerrm, 200));
    end;
  end loop;
  update public.devices set last_sync_at = now(), last_seen_at = now() where id = d.id;
  return jsonb_build_object('ok', true, 'results', salida);
end $$;

-- ============================================================================
--  APP DEL DUEÑO
-- ============================================================================

/* Mis empresas (para el selector). */
create or replace function public.mis_empresas()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'company_id', n.id, 'nombre', n.nombre, 'role', m.role,
           'locations', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'nombre', s.nombre, 'tipo', s.tipo, 'status', s.status)
                                                   order by s.tipo, s.nombre), '[]')
                           from public.sucursales s
                          where s.negocio_id = n.id and s.status <> 'ARCHIVED'
                            and (m.location_ids is null or s.id = any (m.location_ids))))
         order by n.nombre), '[]')
    from public.company_memberships m join public.negocios n on n.id = m.company_id
   where m.user_id = (select auth.uid()) and m.status = 'ACTIVE';
$$;

/*
 * Resumen de una empresa para el dueño: por ubicación, ventas de hoy y el
 * turno abierto / último corte; y el total de la empresa. Fuente: hechos; si
 * una ubicación todavía no manda hechos (POS anterior), el espejo.
 */
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

    r := r || jsonb_build_object('location_id', s.id, 'nombre', s.nombre, 'tipo', s.tipo, 'status', s.status, 'fecha', v_dia,
                                 'ventas', v_ventas, 'turnos_abiertos', v_abiertos, 'ultimo_corte', v_ultimo);
  end loop;
  return jsonb_build_object('company_id', p_company, 'ubicaciones', r,
                            'total', jsonb_build_object('neto', v_total, 'tickets', v_tickets));
end $$;

/*
 * INVITACIÓN a la empresa (QR que muestra el POS o que comparte el dueño).
 *   p = { device_id | (user_id + company_id), role?, location_ids? }
 * Desde el POS solo se puede invitar al PRIMER dueño (la empresa todavía sin
 * OWNER). Después, invita el dueño desde su app.
 */
create or replace function public.membresia_crear_invitacion(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wx_actor_admin(p); v_role text := upper(coalesce(nullif(p->>'role', ''), 'OWNER'));
        v_code text := public.wx_codigo_nuevo(); v_company uuid; v_locs uuid[];
begin
  if a is null or v_role not in ('OWNER', 'ADMIN', 'MANAGER', 'VIEWER') then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  v_company := (a->>'company_id')::uuid;
  if a->>'kind' = 'DEVICE' and exists (select 1 from public.company_memberships where company_id = v_company and role = 'OWNER' and status = 'ACTIVE') then
    perform public.wx_audit('DEVICE', a->>'id', v_company, 'CREATE_INVITE', 'DENIED', jsonb_build_object('code', 'OWNER_EXISTS'));
    return jsonb_build_object('ok', false, 'code', 'OWNER_EXISTS');
  end if;
  if a->>'kind' = 'DEVICE' then v_role := 'OWNER'; end if;
  if a->>'kind' = 'USER' and a->>'role' = 'ADMIN' and v_role = 'OWNER' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  select array_agg(x::uuid) into v_locs from jsonb_array_elements_text(p->'location_ids') x;
  if v_locs is not null and exists (select 1 from unnest(v_locs) l where not exists (select 1 from public.sucursales s where s.id = l and s.negocio_id = v_company)) then
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;
  insert into public.company_invites (company_id, role, location_ids, code_hash, expires_at, created_by_device, created_by_user)
  values (v_company, v_role, v_locs, public.wx_codigo_hash(v_code), now() + interval '30 minutes',
          case when a->>'kind' = 'DEVICE' then (a->>'id')::uuid end, case when a->>'kind' = 'USER' then (a->>'id')::uuid end);
  return jsonb_build_object('ok', true, 'code', v_code, 'company_id', v_company, 'role', v_role, 'expires_at', now() + interval '30 minutes');
end $$;

/* El usuario autenticado (link-owner valida su JWT) acepta la invitación. */
create or replace function public.membresia_aceptar_invitacion(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.company_invites%rowtype; v_user uuid := public.wx_uuid(p->>'user_id');
begin
  if v_user is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  select * into i from public.company_invites
   where code_hash = public.wx_codigo_hash(p->>'code') and used_at is null and expires_at > now() for update;
  if not found then
    perform public.wx_audit('USER', v_user::text, null, 'ACCEPT_INVITE', 'DENIED', '{}');
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;
  insert into public.company_memberships (company_id, user_id, role, location_ids, origin)
  values (i.company_id, v_user, i.role, i.location_ids, 'INVITE')
  on conflict (company_id, user_id) do update set role = excluded.role, location_ids = excluded.location_ids, status = 'ACTIVE', updated_at = now();
  update public.company_invites set used_at = now(), used_by = v_user where id = i.id;
  if i.role = 'OWNER' then update public.negocios set owner_id = coalesce(owner_id, v_user) where id = i.company_id; end if;
  perform public.wx_audit('USER', v_user::text, i.company_id, 'ACCEPT_INVITE', 'OK', jsonb_build_object('role', i.role));
  return jsonb_build_object('ok', true, 'company_id', i.company_id, 'role', i.role);
end $$;

/* Borrar la cuenta desde el POS: solo la principal y solo si la empresa tiene
   UNA ubicación. Con varias, una sucursal no puede borrar a las demás. */
create or replace function public.pos_borrar_cuenta(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; v_users uuid[];
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE';
  if not found or d.kind <> 'POS_PRIMARY' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if (select count(*) from public.sucursales where negocio_id = d.company_id and status <> 'ARCHIVED') > 1 then
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'DELETE_ACCOUNT', 'DENIED', jsonb_build_object('code', 'MULTI_LOCATION'));
    return jsonb_build_object('ok', false, 'code', 'MULTI_LOCATION');
  end if;
  -- Usuarios que se quedan sin ninguna otra empresa: el backend borra su cuenta.
  select array_agg(m.user_id) into v_users from public.company_memberships m
   where m.company_id = d.company_id
     and not exists (select 1 from public.company_memberships o where o.user_id = m.user_id and o.company_id <> d.company_id and o.status = 'ACTIVE');
  delete from public.owner_apps where negocio_id = d.company_id::text;
  delete from public.negocio_app_quota where negocio_id = d.company_id::text;
  delete from public.push_tokens where owner_id = any (coalesce(v_users, '{}'));
  delete from public.negocios where id = d.company_id;
  perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'DELETE_ACCOUNT', 'OK', '{}');
  return jsonb_build_object('ok', true, 'delete_users', to_jsonb(coalesce(v_users, '{}')));
end $$;

-- ============================================================================
--  CFDI: identidad -> empresa -> emisor -> factura
-- ============================================================================

/*
 * La ÚNICA puerta de las funciones fiscales.
 *   p = { device_id, action: STAMP|CANCEL|FILES|REGISTER, issuer_id?, invoice_id? }
 * El emisor y la factura se buscan DENTRO de la empresa del equipo. Lo que
 * mande la petición sobre RFC, razón social, régimen o persona se ignora: sale
 * de aquí.
 */
create or replace function public.fiscal_autorizar(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; v_action text := upper(coalesce(p->>'action', '')); i public.fiscal_issuers%rowtype;
        f public.fiscal_invoices%rowtype; v_n int;
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE';
  if not found or d.kind not in ('POS_PRIMARY', 'POS_SECONDARY') then
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;

  if v_action = 'REGISTER' then
    if d.kind <> 'POS_PRIMARY' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
    return jsonb_build_object('ok', true, 'company_id', d.company_id);
  end if;

  if v_action = 'STAMP' then
    if nullif(p->>'issuer_id', '') is not null then
      -- Se acepta el id del emisor en la nube o el id de persona de Fiscalapi
      -- (lo que guardan los POS actuales), SIEMPRE dentro de la empresa.
      select * into i from public.fiscal_issuers
       where (id = public.wx_uuid(p->>'issuer_id') or fiscalapi_person_id = p->>'issuer_id');
      if not found or i.company_id <> d.company_id then
        perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'FISCAL_STAMP', 'DENIED',
          jsonb_build_object('code', 'FOREIGN_ISSUER', 'issuer', p->>'issuer_id', 'issuer_company', i.company_id));
        return jsonb_build_object('ok', false, 'code', 'DENIED');
      end if;
    else
      select count(*) into v_n from public.fiscal_issuers where company_id = d.company_id and status in ('ACTIVE', 'PENDING_RECONCILIATION');
      if v_n <> 1 then return jsonb_build_object('ok', false, 'code', case when v_n = 0 then 'NO_ISSUER' else 'ISSUER_REQUIRED' end); end if;
      select * into i from public.fiscal_issuers where company_id = d.company_id and status in ('ACTIVE', 'PENDING_RECONCILIATION');
    end if;
    if i.status not in ('ACTIVE', 'PENDING_RECONCILIATION') then
      perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'FISCAL_STAMP', 'DENIED', jsonb_build_object('code', 'ISSUER_' || i.status));
      return jsonb_build_object('ok', false, 'code', 'ISSUER_' || i.status);
    end if;
    return jsonb_build_object('ok', true, 'company_id', d.company_id, 'location_id', d.location_id,
      'issuer', jsonb_build_object('id', i.id, 'person_id', i.fiscalapi_person_id, 'rfc', i.rfc, 'legal_name', i.legal_name,
                                   'tax_regime', i.tax_regime, 'zip_code', i.zip_code, 'status', i.status));
  end if;

  if v_action in ('CANCEL', 'FILES') then
    select * into f from public.fiscal_invoices
     where fiscalapi_invoice_id = p->>'invoice_id' or id = public.wx_uuid(p->>'invoice_id');
    if not found or f.company_id <> d.company_id or f.ownership = 'CONFLICT' then
      perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'FISCAL_' || v_action, 'DENIED',
        jsonb_build_object('code', case when not found then 'UNKNOWN_INVOICE' when f.ownership = 'CONFLICT' then 'CONFLICT' else 'FOREIGN_INVOICE' end,
                           'invoice', p->>'invoice_id'));
      return jsonb_build_object('ok', false, 'code', 'DENIED');
    end if;
    return jsonb_build_object('ok', true, 'company_id', d.company_id,
      'invoice', jsonb_build_object('id', f.id, 'fiscalapi_invoice_id', f.fiscalapi_invoice_id, 'status', f.status, 'ownership', f.ownership));
  end if;
  return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
end $$;

/* Tras crear/actualizar la persona en Fiscalapi: el emisor queda de ESTA empresa. */
create or replace function public.fiscal_registrar_emisor(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; i public.fiscal_issuers%rowtype; v_rfc text := upper(trim(coalesce(p->>'rfc', '')));
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE' and kind = 'POS_PRIMARY';
  if not found or coalesce(p->>'person_id', '') = '' or v_rfc = '' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  select * into i from public.fiscal_issuers where fiscalapi_person_id = p->>'person_id';
  if found and i.company_id <> d.company_id then
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'FISCAL_REGISTER', 'DENIED', jsonb_build_object('code', 'FOREIGN_PERSON'));
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;
  insert into public.fiscal_issuers (company_id, fiscalapi_person_id, rfc, legal_name, tax_regime, zip_code, status, origin, created_by_device)
  values (d.company_id, p->>'person_id', v_rfc, p->>'legal_name', p->>'tax_regime', p->>'zip_code', 'ACTIVE', 'REGISTERED', d.id)
  on conflict (fiscalapi_person_id) do update set rfc = excluded.rfc, legal_name = excluded.legal_name, tax_regime = excluded.tax_regime,
    zip_code = excluded.zip_code, status = 'ACTIVE', updated_at = now()
  where fiscal_issuers.company_id = excluded.company_id
  returning * into i;
  perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'FISCAL_REGISTER', 'OK', jsonb_build_object('issuer_id', i.id, 'rfc', v_rfc));
  return jsonb_build_object('ok', true, 'issuer_id', i.id, 'person_id', i.fiscalapi_person_id);
end $$;

/* Persona de Fiscalapi que ya usa ESTA empresa para el mismo RFC (para no
   crear otra al volver a subir el CSD). Nunca la de otra empresa. */
create or replace function public.fiscal_persona_de_empresa(p jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ok', true, 'person_id', (
    select i.fiscalapi_person_id from public.fiscal_issuers i join public.devices d on d.company_id = i.company_id
     where d.id = public.wx_uuid(p->>'device_id') and d.status = 'ACTIVE'
       and i.rfc = upper(trim(coalesce(p->>'rfc', ''))) and i.status in ('ACTIVE', 'PENDING_RECONCILIATION')
     order by i.updated_at desc limit 1));
$$;

create or replace function public.fiscal_registrar_factura(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; i public.fiscal_issuers%rowtype; v_id uuid;
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE';
  select * into i from public.fiscal_issuers where id = public.wx_uuid(p->>'issuer_id');
  if d.id is null or i.id is null or i.company_id <> d.company_id or coalesce(p->>'invoice_id', '') = '' then
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;
  insert into public.fiscal_invoices (company_id, location_id, device_id, issuer_id, fiscalapi_invoice_id, sat_uuid, series, folio, total, ownership)
  values (d.company_id, d.location_id, d.id, i.id, p->>'invoice_id', p->>'sat_uuid', p->>'series', p->>'folio', (p->>'total')::numeric,
          case when i.status = 'ACTIVE' then 'VERIFIED' else 'PENDING_RECONCILIATION' end)
  on conflict (fiscalapi_invoice_id) do nothing
  returning id into v_id;
  return jsonb_build_object('ok', v_id is not null, 'id', v_id);
end $$;

create or replace function public.fiscal_marcar_cancelacion(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb := public.fiscal_autorizar(jsonb_build_object('device_id', p->>'device_id', 'action', 'CANCEL', 'invoice_id', p->>'invoice_id'));
begin
  if not (a->>'ok')::boolean then return a; end if;
  update public.fiscal_invoices set status = case when coalesce((p->>'cancelled')::boolean, true) then 'CANCELLED' else 'CANCEL_REQUESTED' end,
         updated_at = now()
   where id = (a->'invoice'->>'id')::uuid;
  return jsonb_build_object('ok', true);
end $$;

/*
 * TRANSICIÓN: emisores y facturas ANTERIORES a la Fase 1, cuando las
 * funciones fiscales aceptaban cualquier id. El POS reclama lo que tiene en su
 * base local. No se inventa dueño:
 *   - emisor reclamado por UNA empresa  -> PENDING_RECONCILIATION (sigue timbrando,
 *     se cuenta y Wybix lo confirma);
 *   - reclamado por DOS o más           -> CONFLICT (bloqueado para todas);
 *   - factura de un emisor de la empresa -> ownership según el emisor;
 *   - factura que reclaman dos empresas  -> CONFLICT.
 */
create or replace function public.fiscal_reclamar_historico(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; i public.fiscal_issuers%rowtype; f public.fiscal_invoices%rowtype; inv jsonb;
        v_person text := nullif(p->>'person_id', ''); v_rfc text := upper(trim(coalesce(p->>'rfc', '')));
        n_ok int := 0; n_pend int := 0; n_conf int := 0;
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE' and kind = 'POS_PRIMARY';
  if not found or v_person is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;

  insert into public.fiscal_issuer_claims (fiscalapi_person_id, company_id, device_id, rfc)
  values (v_person, d.company_id, d.id, v_rfc) on conflict (fiscalapi_person_id, company_id) do nothing;

  select * into i from public.fiscal_issuers where fiscalapi_person_id = v_person for update;
  if not found then
    insert into public.fiscal_issuers (company_id, fiscalapi_person_id, rfc, legal_name, tax_regime, zip_code, status, origin, created_by_device)
    values (d.company_id, v_person, v_rfc, p->>'legal_name', p->>'tax_regime', p->>'zip_code', 'PENDING_RECONCILIATION', 'HISTORICAL_CLAIM', d.id)
    returning * into i;
    perform public.wx_pendiente('FISCAL_ISSUER', v_person, d.company_id, jsonb_build_object('rfc', v_rfc, 'issuer_id', i.id));
  elsif i.company_id <> d.company_id then
    update public.fiscal_issuers set status = 'CONFLICT', updated_at = now() where id = i.id and status <> 'REVOKED';
    perform public.wx_pendiente('FISCAL_ISSUER_CONFLICT', v_person, null,
      jsonb_build_object('companies', (select jsonb_agg(company_id) from public.fiscal_issuer_claims where fiscalapi_person_id = v_person)));
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'FISCAL_CLAIM', 'CONFLICT', jsonb_build_object('person', v_person));
    select * into i from public.fiscal_issuers where id = i.id;
  end if;

  for inv in select * from jsonb_array_elements(coalesce(p->'invoices', '[]')) loop
    continue when coalesce(inv->>'invoice_id', '') = '';
    insert into public.fiscal_invoice_claims (fiscalapi_invoice_id, company_id, device_id)
    values (inv->>'invoice_id', d.company_id, d.id) on conflict do nothing;
    select * into f from public.fiscal_invoices where fiscalapi_invoice_id = inv->>'invoice_id' for update;
    if not found then
      insert into public.fiscal_invoices (company_id, location_id, device_id, issuer_id, fiscalapi_invoice_id, sat_uuid, series, folio, total, status, ownership)
      values (d.company_id, d.location_id, d.id, case when i.company_id = d.company_id then i.id end, inv->>'invoice_id', inv->>'sat_uuid',
              inv->>'series', inv->>'folio', (inv->>'total')::numeric,
              case when coalesce((inv->>'cancelled')::boolean, false) then 'CANCELLED' else 'STAMPED' end,
              case when i.company_id = d.company_id and i.status = 'ACTIVE' then 'VERIFIED'
                   when i.status = 'CONFLICT' then 'CONFLICT' else 'PENDING_RECONCILIATION' end)
      returning * into f;
    elsif f.company_id <> d.company_id then
      update public.fiscal_invoices set ownership = 'CONFLICT', updated_at = now() where id = f.id;
      perform public.wx_pendiente('FISCAL_INVOICE_CONFLICT', f.fiscalapi_invoice_id, null, '{}');
      f.ownership := 'CONFLICT';
    end if;
    if f.ownership = 'VERIFIED' then n_ok := n_ok + 1; elsif f.ownership = 'CONFLICT' then n_conf := n_conf + 1; else n_pend := n_pend + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'issuer_id', i.id, 'issuer_status', i.status,
                            'invoices', jsonb_build_object('verified', n_ok, 'pending_reconciliation', n_pend, 'conflict', n_conf));
end $$;

/* TRANSICIÓN (solo con FISCAL_PERMITIR_LEGADO=1 en el backend): un POS
   anterior, sin credencial de equipo, puede seguir usando un emisor o una
   factura SOLO si nadie los tiene registrados ni reclamados en la nube. En
   cuanto la empresa dueña se actualiza, quedan fuera de su alcance. */
create or replace function public.fiscal_legado_libre(p jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('libre',
    (nullif(p->>'person_id', '') is null or (not exists (select 1 from public.fiscal_issuers where fiscalapi_person_id = p->>'person_id')
                                         and not exists (select 1 from public.fiscal_issuer_claims where fiscalapi_person_id = p->>'person_id')))
    and (nullif(p->>'invoice_id', '') is null or (not exists (select 1 from public.fiscal_invoices where fiscalapi_invoice_id = p->>'invoice_id')
                                              and not exists (select 1 from public.fiscal_invoice_claims where fiscalapi_invoice_id = p->>'invoice_id')))
    and (nullif(p->>'person_id', '') is not null or nullif(p->>'invoice_id', '') is not null));
$$;

/* Conciliación por Wybix (panel/admin con service_role). */
create or replace function public.fiscal_conciliar_emisor(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i public.fiscal_issuers%rowtype; v_company uuid := public.wx_uuid(p->>'company_id'); v_dec text := upper(coalesce(p->>'decision', ''));
begin
  select * into i from public.fiscal_issuers where id = public.wx_uuid(p->>'issuer_id') for update;
  if not found or v_dec not in ('ASSIGN', 'REVOKE') then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  if v_dec = 'REVOKE' then
    update public.fiscal_issuers set status = 'REVOKED', updated_at = now() where id = i.id;
  else
    if v_company is null or not exists (select 1 from public.negocios where id = v_company) then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
    update public.fiscal_issuers set company_id = v_company, status = 'ACTIVE', updated_at = now() where id = i.id;
    update public.fiscal_invoices set ownership = case when company_id = v_company then 'VERIFIED' else 'CONFLICT' end, updated_at = now()
     where issuer_id = i.id or (issuer_id is null and fiscalapi_invoice_id in (select fiscalapi_invoice_id from public.fiscal_invoice_claims where company_id = v_company));
  end if;
  update public.reconciliation_items set status = 'RESOLVED', resolved_at = now()
   where kind in ('FISCAL_ISSUER', 'FISCAL_ISSUER_CONFLICT') and ref = i.fiscalapi_person_id;
  perform public.wx_audit('SERVICE', p->>'actor', v_company, 'FISCAL_RECONCILE', v_dec, jsonb_build_object('issuer_id', i.id));
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================================
--  MIGRACIÓN DE DATOS EXISTENTES (idempotente; no borra ni reasigna nada)
-- ============================================================================

-- 1) Dueño actual -> membresía OWNER.
insert into public.company_memberships (company_id, user_id, role, origin)
select n.id, n.owner_id, 'OWNER', 'MIGRATED_OWNER_ID'
  from public.negocios n
 where n.owner_id is not null
on conflict (company_id, user_id) do nothing;

-- 2) owner_apps: se vinculaban con solo conocer el id del negocio (venía en un
--    QR sin secreto). NO se convierten en acceso; quedan para revisión.
insert into public.reconciliation_items (kind, ref, company_id, detail)
select 'OWNER_APP_UNVERIFIED', oa.id::text, public.wx_uuid(oa.negocio_id), jsonb_build_object('user_id', oa.user_id)
  from public.owner_apps oa
 where oa.active
   and not exists (select 1 from public.company_memberships m where m.company_id = public.wx_uuid(oa.negocio_id) and m.user_id = oa.user_id)
on conflict (kind, ref) do nothing;

-- 3) Tokens de sucursal -> equipos (la credencial sigue valiendo igual).
insert into public.devices (company_id, location_id, kind, name, status, credential_hash, legacy_token, activated_at)
select s.negocio_id, s.id, 'POS_PRIMARY', 'POS (versión anterior)', 'ACTIVE', s.sync_token_hash, true, s.created_at
  from public.sucursales s
 where s.sync_token_hash is not null
on conflict (credential_hash) where credential_hash is not null do nothing;

-- 4) Licencia -> empresa SOLO cuando la evidencia es única (las activaciones
--    de la licencia apuntan a sucursales de UNA sola empresa).
with evid as (
  select a.license_id, array_agg(distinct s.negocio_id) as empresas
    from public.license_activations a
    join public.sucursales s on s.license_machine_id = a.machine_id
   group by a.license_id
)
update public.licenses l set company_id = e.empresas[1]
  from evid e
 where e.license_id = l.id and l.company_id is null and array_length(e.empresas, 1) = 1;

insert into public.reconciliation_items (kind, ref, company_id, detail)
select case when ev.n > 1 then 'LICENSE_MULTI_COMPANY' else 'LICENSE_UNLINKED' end, l.id::text, null,
       jsonb_build_object('license_key_tail', right(l.license_key, 4), 'companies', coalesce(ev.n, 0))
  from public.licenses l
  left join (select a.license_id, count(distinct s.negocio_id) n
               from public.license_activations a join public.sucursales s on s.license_machine_id = a.machine_id
              group by a.license_id) ev on ev.license_id = l.id
 where l.company_id is null
   and exists (select 1 from public.license_activations a where a.license_id = l.id)
on conflict (kind, ref) do nothing;

update public.license_activations a set location_id = s.id
  from public.sucursales s
 where s.license_machine_id = a.machine_id and a.location_id is null
   and (select count(*) from public.sucursales x where x.license_machine_id = a.machine_id) = 1;

-- Resumen de lo que queda por conciliar (para el reporte de la migración).
create or replace view public.fase1_conciliacion as
  select kind, status, count(*) as total from public.reconciliation_items group by kind, status;

-- ============================================================================
--  RLS: identidad -> membresía -> empresa
-- ============================================================================
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
end $$;

create policy "miembro ve su empresa" on public.negocios for select to authenticated using (public.wx_es_miembro(id));
create policy "miembro ve sus ubicaciones" on public.sucursales for select to authenticated using (public.wx_puede_ubicacion(id));
create policy "miembro ve resumen" on public.resumen_ventas for select to authenticated using (public.wx_puede_ubicacion(sucursal_id));
create policy "miembro ve tendencia" on public.tendencia_ventas for select to authenticated using (public.wx_puede_ubicacion(sucursal_id));
create policy "miembro ve top" on public.top_productos for select to authenticated using (public.wx_puede_ubicacion(sucursal_id));
create policy "miembro ve cortes" on public.cortes_caja for select to authenticated using (public.wx_puede_ubicacion(sucursal_id));
create policy "miembro ve alertas" on public.alertas for select to authenticated using (public.wx_puede_ubicacion(sucursal_id));
create policy "miembro marca alertas" on public.alertas for update to authenticated
  using (public.wx_puede_ubicacion(sucursal_id)) with check (public.wx_puede_ubicacion(sucursal_id));
create policy "miembro ve riesgo" on public.seguridad_riesgo for select to authenticated using (public.wx_puede_ubicacion(sucursal_id));

do $$
declare t text;
begin
  -- Tablas nuevas: RLS siempre activado.
  foreach t in array array['accounts', 'company_memberships', 'company_invites', 'employees', 'registers', 'devices',
                           'device_enrollments', 'sync_events', 'sales_facts', 'shift_facts', 'cash_movement_facts',
                           'notification_outbox', 'fiscal_issuers', 'fiscal_issuer_claims', 'fiscal_invoices',
                           'fiscal_invoice_claims', 'cloud_audit', 'reconciliation_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
  -- Nadie escribe directo desde la app: solo lectura, filtrada por RLS.
  foreach t in array array['negocios', 'sucursales', 'resumen_ventas', 'tendencia_ventas', 'top_productos',
                           'cortes_caja', 'alertas', 'seguridad_riesgo', 'owner_apps', 'negocio_app_quota'] loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
  foreach t in array array['negocios', 'sucursales', 'resumen_ventas', 'tendencia_ventas', 'top_productos',
                           'cortes_caja', 'alertas', 'seguridad_riesgo', 'company_memberships', 'employees', 'registers',
                           'sales_facts', 'shift_facts', 'cash_movement_facts'] loop
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;
grant update (leida) on public.alertas to authenticated;

drop policy if exists "miembro ve su membresia" on public.company_memberships;
create policy "miembro ve su membresia" on public.company_memberships for select to authenticated
  using (user_id = (select auth.uid()) or public.wx_rol(company_id) in ('OWNER', 'ADMIN'));
drop policy if exists "miembro ve empleados" on public.employees;
create policy "miembro ve empleados" on public.employees for select to authenticated using (public.wx_es_miembro(company_id));
drop policy if exists "miembro ve cajas" on public.registers;
create policy "miembro ve cajas" on public.registers for select to authenticated using (public.wx_puede_ubicacion(location_id));
drop policy if exists "miembro ve ventas" on public.sales_facts;
create policy "miembro ve ventas" on public.sales_facts for select to authenticated using (public.wx_puede_ubicacion(location_id));
drop policy if exists "miembro ve turnos" on public.shift_facts;
create policy "miembro ve turnos" on public.shift_facts for select to authenticated using (public.wx_puede_ubicacion(location_id));
drop policy if exists "miembro ve movimientos" on public.cash_movement_facts;
create policy "miembro ve movimientos" on public.cash_movement_facts for select to authenticated using (public.wx_puede_ubicacion(location_id));

revoke all on public.fase1_conciliacion from anon, authenticated;
grant select on public.fase1_conciliacion to service_role;

-- Funciones: por omisión PUBLIC puede ejecutar. Se cierra todo y se abre lo justo.
do $$
declare f text;
begin
  foreach f in array array[
    'wx_hash(text)', 'wx_token_nuevo(text)', 'wx_codigo_nuevo()', 'wx_codigo_hash(text)', 'wx_uuid(text)',
    'wx_audit(text, text, uuid, text, text, jsonb)', 'wx_pendiente(text, text, uuid, jsonb)',
    'company_entitlements(uuid)', 'device_autenticar(jsonb)', 'wx_emitir_dispositivo(uuid, text, uuid, jsonb)',
    'pos_bootstrap(jsonb)', 'pos_enroll(jsonb)', 'pos_whoami(jsonb)', 'wx_actor_admin(jsonb)', 'pos_create_location(jsonb)',
    'pos_create_enrollment(jsonb)', 'pos_install_secret(jsonb)', 'pos_vincular_licencia(jsonb)', 'wx_tr_token_legado()',
    'wx_proyectar(public.devices, text, jsonb)', 'sync_ingest(jsonb)', 'membresia_crear_invitacion(jsonb)',
    'membresia_aceptar_invitacion(jsonb)', 'pos_borrar_cuenta(jsonb)', 'fiscal_autorizar(jsonb)',
    'fiscal_registrar_emisor(jsonb)', 'fiscal_persona_de_empresa(jsonb)', 'fiscal_registrar_factura(jsonb)',
    'fiscal_marcar_cancelacion(jsonb)', 'fiscal_reclamar_historico(jsonb)', 'fiscal_conciliar_emisor(jsonb)',
    'fiscal_legado_libre(jsonb)', 'pos_provision_legado(jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  -- Lo que usa RLS y la app del dueño (cada una valida auth.uid() por dentro).
  foreach f in array array['wx_rol(uuid)', 'wx_es_miembro(uuid)', 'wx_puede_ubicacion(uuid)', 'mis_empresas()', 'resumen_empresa(uuid, date)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
