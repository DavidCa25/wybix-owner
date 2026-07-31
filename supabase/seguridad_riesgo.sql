-- Blindaje: espejo del "riesgo por cajero" para la app del dueño.
-- Correr en el SQL Editor de Supabase (proyecto de la app).
-- El POS escribe con service key (salta RLS); el dueño solo LEE sus sucursales.

create table if not exists public.seguridad_riesgo (
  sucursal_id      uuid not null,
  user_id          int  not null,
  cajero           text,
  anuladas         int  default 0,
  devoluciones     int  default 0,
  cajon_sin_venta  int  default 0,
  eliminados       int  default 0,
  descuentos       int  default 0,
  monto_riesgo     numeric default 0,
  score            int  default 0,
  nivel            text default 'bajo',
  actualizado_at   timestamptz default now(),
  primary key (sucursal_id, user_id)
);

alter table public.seguridad_riesgo enable row level security;

-- El dueño ve solo el riesgo de SUS sucursales (reutiliza el RLS ya activo en 'sucursales').
drop policy if exists "owner reads seguridad_riesgo" on public.seguridad_riesgo;
create policy "owner reads seguridad_riesgo" on public.seguridad_riesgo
  for select using (sucursal_id in (select id from public.sucursales));
