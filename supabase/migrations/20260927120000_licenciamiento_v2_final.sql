-- ============================================================================
--  LICENCIAMIENTO v2 · PARTE B: retirar el contrato anterior de max_registers
-- ----------------------------------------------------------------------------
--  Se aplica SOLO cuando ya están desplegadas y verificadas:
--    - las Edge Functions nuevas (license-check, trial-license, pos-sync), que
--      calculan las cajas desde la edición (license_registers_max);
--    - la web nueva, que emite licencias con license_create_from_order.
--  Hasta entonces la PARTE A deja `max_registers` como lo escribían y leían la
--  web y el license-check anteriores (MultiCaja = 0 o 9999).
--
--  Después de esto:
--    - MultiCaja = NULL (cajas ilimitadas); MonoCaja = 1. Sin 0 ni 9999.
--    - La web ANTERIOR ya no puede emitir (manda 9999 y se rechaza): por eso
--      esta parte va DESPUÉS de reemplazarla, no antes.
--    - El license-check ANTERIOR leería NULL como 1 caja: por eso va después
--      de desplegar el nuevo.
--
--  Comprobación previa (debe dar 0 filas antes de aplicar en producción):
--    select * from licenses where plan not in ('mono', 'multi');
--
--  Idempotente.
-- ============================================================================

-- Lo que se escribe desde ahora: el valor canónico.
create or replace function public.license_legacy_max_registers(p_plan text)
returns int language sql immutable set search_path = public as $$
  select public.license_registers_max(p_plan);
$$;
revoke all on function public.license_legacy_max_registers(text) from public, anon, authenticated;
grant execute on function public.license_legacy_max_registers(text) to service_role;

alter table public.licenses alter column max_registers drop not null;
alter table public.licenses alter column max_registers drop default;

update public.licenses
   set max_registers = public.license_registers_max(plan)
 where max_registers is distinct from public.license_registers_max(plan);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'licenses_max_registers_check') then
    alter table public.licenses add constraint licenses_max_registers_check
      check (max_registers is null or max_registers >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'licenses_edicion_cajas_check') then
    -- MonoCaja es exactamente 1 caja; MultiCaja no tiene límite.
    alter table public.licenses add constraint licenses_edicion_cajas_check
      check ((plan = 'mono' and max_registers = 1) or (plan = 'multi' and max_registers is null));
  end if;
end $$;

insert into public.license_events (license_id, type, data, actor)
select null, 'LEGACY_REGISTERS_CONTRACT_RETIRED', jsonb_build_object('at', now()), 'migracion'
 where not exists (select 1 from public.license_events where type = 'LEGACY_REGISTERS_CONTRACT_RETIRED');
