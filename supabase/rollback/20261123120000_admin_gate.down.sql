-- Reversa de 20261123120000_admin_gate.sql. Antes de aplicarla, vuelve a
-- desplegar la versión anterior de la función `admin` (la que usa
-- admin_whoami + admin_rate_hit), o el panel deja de responder.
drop function if exists public.admin_gate(uuid, uuid, integer, integer);
