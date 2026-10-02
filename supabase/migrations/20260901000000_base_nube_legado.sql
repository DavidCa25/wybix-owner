-- ============================================================================
--  BASE DE LA NUBE: lo que existía en Supabase creado A MANO
-- ----------------------------------------------------------------------------
--  Hasta la Fase 1 estas tablas solo existían en el proyecto de producción:
--  se habían creado desde el editor SQL y ninguna migración las describía. Un
--  proyecto nuevo (staging, pruebas, recuperación) no podía reconstruirse.
--
--  Este archivo las VERSIONA tal como están en producción. Se sacaron del
--  catálogo real (2026-10-02, `supabase db query --linked`, solo lectura):
--  mismas columnas, tipos, valores por omisión, restricciones e índices.
--
--  Es IDEMPOTENTE y NO DESTRUCTIVO: todo es `if not exists`. Contra producción
--  no cambia nada; contra una base vacía la deja como producción antes de la
--  Fase 1. Por eso tiene una fecha ANTERIOR a las migraciones de licencias:
--  es lo que ellas suponían que ya existía.
--
--  QUÉ NO SE VERSIONA AQUÍ, A PROPÓSITO
--    · El disparador `alerta-push` sobre `alertas` (webhook a send-alert-push):
--      en producción lleva el secreto del webhook ESCRITO en su definición. Un
--      secreto no entra a git. Se recrea a mano o desde el panel; queda anotado
--      como riesgo en docs/fase1-nube.md (hay que rotarlo y moverlo a Vault).
--    · Políticas RLS: las reemplaza la migración de la Fase 1 (membresías).
--      Aquí solo se activa RLS, que sin políticas = nadie lee.
-- ============================================================================

-- Roles de Supabase (en un Postgres de pruebas no existen).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

-- ---------------------------------------------------------------- licencias
-- Forma ANTERIOR a licenciamiento v2 (que las evoluciona).
create table if not exists public.licenses (
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
create unique index if not exists ux_licenses_paypal_order on public.licenses (paypal_order_id) where paypal_order_id is not null;

create table if not exists public.license_activations (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.licenses(id) on delete cascade,
  machine_id text not null,
  machine_alias text,
  active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (license_id, machine_id)
);

create table if not exists public.device_trials (
  id uuid primary key default gen_random_uuid(),
  machine_id text not null unique,
  business_name text,
  email text,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);
create index if not exists idx_device_trials_machine on public.device_trials (machine_id);

-- ---------------------------------------------------- negocio y sucursales
create table if not exists public.negocios (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  owner_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.sucursales (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references public.negocios(id) on delete cascade,
  nombre text not null,
  device_key text not null unique,
  created_at timestamptz not null default now(),
  license_machine_id text
);
create index if not exists ix_sucursales_license_machine on public.sucursales (license_machine_id);

-- ------------------------------------------------------------------ espejos
create table if not exists public.resumen_ventas (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  fecha date not null,
  total numeric not null default 0,
  num_tickets int not null default 0,
  ticket_promedio numeric not null default 0,
  total_efectivo numeric not null default 0,
  total_tarjeta numeric not null default 0,
  total_credito numeric not null default 0,
  actualizado_at timestamptz not null default now(),
  utilidad numeric default 0,
  unique (sucursal_id, fecha)
);

create table if not exists public.tendencia_ventas (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  fecha date not null,
  total numeric not null default 0,
  actualizado_at timestamptz not null default now(),
  unique (sucursal_id, fecha)
);
create index if not exists ix_tendencia on public.tendencia_ventas (sucursal_id, fecha);

create table if not exists public.top_productos (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  fecha date not null,
  producto text not null,
  cantidad numeric not null,
  importe numeric not null,
  actualizado_at timestamptz not null default now()
);
create index if not exists ix_top_prod on public.top_productos (sucursal_id, fecha);

create table if not exists public.cortes_caja (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  closure_id_local int not null,
  caja text,
  abierto_at timestamptz,
  cerrado_at timestamptz,
  fondo_inicial numeric,
  esperado numeric,
  entregado numeric,
  diferencia numeric,
  actualizado_at timestamptz not null default now(),
  movimientos jsonb,
  unique (sucursal_id, closure_id_local)
);

create table if not exists public.alertas (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id) on delete cascade,
  tipo text not null,
  titulo text not null,
  mensaje text not null,
  leida boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists ix_alertas on public.alertas (sucursal_id, created_at desc);

create table if not exists public.seguridad_riesgo (
  sucursal_id uuid not null,
  user_id int not null,
  cajero text,
  anuladas int default 0,
  devoluciones int default 0,
  cajon_sin_venta int default 0,
  eliminados int default 0,
  descuentos int default 0,
  monto_riesgo numeric default 0,
  score int default 0,
  nivel text default 'bajo',
  actualizado_at timestamptz default now(),
  primary key (sucursal_id, user_id)
);

-- ------------------------------------------------------ app del dueño
create table if not exists public.owner_apps (
  id uuid primary key default gen_random_uuid(),
  negocio_id text not null,
  user_id uuid not null,
  device_id text,
  is_paid_extra boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (negocio_id, user_id)
);
create index if not exists ix_owner_apps_negocio on public.owner_apps (negocio_id) where active;

create table if not exists public.negocio_app_quota (
  negocio_id text primary key,
  total_apps int not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  token text not null,
  platform text,
  created_at timestamptz not null default now(),
  unique (owner_id, token)
);
create index if not exists ix_push_tokens_owner on public.push_tokens (owner_id);

-- RLS activado en todas: sin políticas, nadie fuera del backend lee.
do $$
declare t text;
begin
  foreach t in array array['licenses', 'license_activations', 'device_trials', 'negocios', 'sucursales',
                           'resumen_ventas', 'tendencia_ventas', 'top_productos', 'cortes_caja', 'alertas',
                           'seguridad_riesgo', 'owner_apps', 'negocio_app_quota', 'push_tokens'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
