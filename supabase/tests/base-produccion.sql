-- ============================================================================
--  RÉPLICA MÍNIMA DEL ESQUEMA DE LICENCIAS DE PRODUCCIÓN (antes de v2)
-- ----------------------------------------------------------------------------
--  Sacada del catálogo real (2026-09-26, `supabase db query --linked`): las
--  mismas columnas, restricciones y privilegios por omisión de Supabase. Sirve
--  para probar la migración sobre lo que de verdad hay, sin tocar producción.
-- ============================================================================
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create table public.licenses (
  id uuid primary key default gen_random_uuid(),
  license_key text not null unique,
  plan text not null check (plan = any (array['mono', 'multi'])),
  customer_name text not null,
  customer_phone text,
  customer_email text,
  max_registers integer not null default 1,
  status text not null default 'activa' check (status = any (array['activa', 'suspendida', 'cancelada'])),
  support_until date,
  sold_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now(),
  buyer_email text, buyer_name text, negocio text,
  cajas int default 1,
  paypal_order_id text
);
create unique index ux_licenses_paypal_order on public.licenses (paypal_order_id) where paypal_order_id is not null;

create table public.license_activations (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.licenses(id) on delete cascade,
  machine_id text not null,
  machine_alias text,
  active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (license_id, machine_id)
);

create table public.device_trials (
  id uuid primary key default gen_random_uuid(),
  machine_id text not null unique,
  business_name text,
  email text,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

alter table public.licenses enable row level security;
alter table public.license_activations enable row level security;
alter table public.device_trials enable row level security;

-- Datos con la forma de los reales: MonoCaja activa en una PC, MultiCaja con
-- el 0 de license-check y otra con el 9999 que emitía la web.
insert into public.licenses (id, license_key, plan, customer_name, max_registers, support_until) values
  ('00000000-0000-0000-0000-000000000001', 'WYBX-MONO-0001', 'mono',  'Tienda Uno', 1, '2027-07-10'),
  ('00000000-0000-0000-0000-000000000002', 'WYBX-MULT-0002', 'multi', 'Café Dos',   0, '2027-07-23'),
  ('00000000-0000-0000-0000-000000000003', 'WYBX-MULT-0003', 'multi', 'Taller Tres', 9999, '2027-09-11'),
  ('00000000-0000-0000-0000-000000000004', 'WYBX-MONO-0004', 'mono',  'Sin activar', 1, '2027-09-18');
insert into public.license_activations (license_id, machine_id, first_seen_at) values
  ('00000000-0000-0000-0000-000000000001', 'PC-UNO', '2026-07-10 10:00-06'),
  ('00000000-0000-0000-0000-000000000002', 'PC-CAFE-1', '2026-07-23 09:00-06'),
  ('00000000-0000-0000-0000-000000000002', 'PC-CAFE-2', '2026-08-01 09:00-06');
insert into public.device_trials (machine_id, started_at, expires_at) values ('PC-PRUEBA', now() - interval '3 days', now() + interval '27 days');
