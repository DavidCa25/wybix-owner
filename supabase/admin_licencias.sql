-- Enlace licencia ↔ negocio para el panel de administrador.
-- El POS estampa aquí su machine_id de licencia (el mismo que usa
-- license_activations y device_trials), para poder unir en el admin:
--   sucursales.license_machine_id = license_activations.machine_id
-- Correr en el SQL Editor de Supabase. Es idempotente.

alter table public.sucursales
  add column if not exists license_machine_id text;

create index if not exists ix_sucursales_license_machine
  on public.sucursales (license_machine_id);
