-- Esquema para link-owner (correr en el SQL Editor de Supabase del proyecto del app)

-- Cupo de apps por negocio: 1 incluida; sube total_apps cuando el cliente paga una extra.
create table if not exists public.negocio_app_quota (
  negocio_id  text primary key,
  total_apps  int not null default 1,
  updated_at  timestamptz not null default now()
);

-- Vinculo de app de dueño a negocio.
create table if not exists public.owner_apps (
  id             uuid primary key default gen_random_uuid(),
  negocio_id     text not null,
  user_id        uuid not null,
  device_id      text,
  is_paid_extra  boolean not null default false,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (negocio_id, user_id)
);

create index if not exists ix_owner_apps_negocio on public.owner_apps (negocio_id) where active;

-- RLS: la funcion usa service_role (la salta), pero dejamos la tabla protegida.
alter table public.owner_apps enable row level security;
alter table public.negocio_app_quota enable row level security;

-- Para HABILITAR una app extra a un negocio (cuando el cliente pague):
--   insert into public.negocio_app_quota (negocio_id, total_apps) values ('<negocioId>', 2)
--   on conflict (negocio_id) do update set total_apps = excluded.total_apps, updated_at = now();
