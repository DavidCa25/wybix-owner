-- Reversa de 20261124120000_pos_mobile_rapido.sql.
-- ANTES de esta reversa vuelve a aplicar las definiciones anteriores de
-- mobile_snapshot (20261112120000_paquetes_combos_auto.sql) y de
-- mobile_latido (20261010120000_fase2_event_mobile.sql): la nueva
-- mobile_latido escribe sync_stats. Las tablets nuevas siguen funcionando;
-- solo vuelven a bajar el catálogo completo en cada ciclo.
alter table public.devices drop column if exists sync_stats;
