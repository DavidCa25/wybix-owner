-- ============================================================================
--  FASE 3 · Disparador del motor de notificaciones (cada minuto).
--
--  pg_cron llama a la función `notificaciones` con pg_net; la URL y el secreto
--  salen de Vault (los mismos nombres que el push heredado):
--    wybix_notif_url        https://<proyecto>.supabase.co/functions/v1/notificaciones
--    wybix_webhook_secret   igual a WEBHOOK_SECRET de las funciones
--  Sin configuración en Vault no llama a nadie (falla cerrado).
--
--  Donde no hay pg_cron (Postgres de pruebas) solo se crea la función; el
--  ciclo se prueba llamando a la función de borde directamente.
-- ============================================================================
-- pg_net (las llamadas HTTP salen de la base). En Supabase existe; en un
-- Postgres de pruebas no, y entonces el trigger solo avisa y no envía.
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end $$;

create or replace function public.wx_notif_disparar() returns void
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secreto text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'wybix_notif_url';
  select decrypted_secret into v_secreto from vault.decrypted_secrets where name = 'wybix_webhook_secret';
  if v_url is null or v_url !~ '^https?://' or coalesce(length(v_secreto), 0) < 32 then
    raise warning 'notificaciones: falta configuración en Vault; no se dispara el ciclo';
    return;
  end if;
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secreto),
    timeout_milliseconds := 25000);
exception when others then
  raise warning 'notificaciones: no se pudo disparar el ciclo (sqlstate %)', sqlstate;
end $$;
revoke all on function public.wx_notif_disparar() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.wx_notif_disparar() from anon, authenticated; end if;
end $$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if exists (select 1 from cron.job where jobname = 'wybix-notificaciones') then
      perform cron.unschedule('wybix-notificaciones');
    end if;
    perform cron.schedule('wybix-notificaciones', '* * * * *', 'select public.wx_notif_disparar()');
  else
    raise notice 'pg_cron no está disponible aquí: el ciclo de notificaciones no se programa';
  end if;
end $$;
