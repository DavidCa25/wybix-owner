-- ============================================================================
--  FASE 3 · ETAPA 0.5 · TRIGGER DE ALERTAS SIN SECRETO EN SU DEFINICIÓN
--
--  Antes: el webhook `alerta-push` sobre public.alertas se creó desde el panel
--  y lleva la cabecera x-webhook-secret ESCRITA en la definición del trigger
--  (la puede leer cualquiera con acceso al catálogo, y no se puede versionar).
--
--  Ahora: la URL y el secreto viven en Vault. El trigger los lee en cada
--  INSERT y llama con pg_net (asíncrono: no frena la inserción). Si falta
--  algo, NO envía (falla cerrado) y la alerta se guarda igual: una alerta
--  nunca se pierde por un problema del push.
--
--  Secretos en Vault (los crea el runbook docs/fase3-push-secretos.md):
--    wybix_alerta_push_url   https://<proyecto>.supabase.co/functions/v1/send-alert-push
--    wybix_webhook_secret    el mismo valor que WEBHOOK_SECRET de las funciones
--
--  Idempotente. En un Postgres sin Vault/pg_net (pruebas) se crea igual: el
--  cuerpo solo se resuelve al ejecutarse y cualquier error queda en un aviso.
-- ============================================================================

-- pg_net (las llamadas HTTP salen de la base). En Supabase existe; en un
-- Postgres de pruebas no, y entonces el trigger solo avisa y no envía.
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end $$;

create or replace function public.wx_alerta_push() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secreto text;
begin
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'wybix_alerta_push_url';
    select decrypted_secret into v_secreto from vault.decrypted_secrets where name = 'wybix_webhook_secret';
    if v_url is null or v_url !~ '^https://' or coalesce(length(v_secreto), 0) < 32 then
      raise warning 'alerta-push: falta configuración en Vault; la alerta % se guardó sin push', new.id;
      return new;
    end if;
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('type', 'INSERT', 'table', 'alertas', 'record', to_jsonb(new)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secreto),
      timeout_milliseconds := 5000);
  exception when others then
    -- Solo el código de error: el mensaje podría arrastrar la cabecera.
    raise warning 'alerta-push: no se pudo encolar el push de la alerta % (sqlstate %)', new.id, sqlstate;
  end;
  return new;
end $$;

revoke all on function public.wx_alerta_push() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.wx_alerta_push() from anon, authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.wx_alerta_push() to service_role; end if;
end $$;

-- El trigger del panel (con el secreto escrito) se reemplaza.
drop trigger if exists "alerta-push" on public.alertas;
drop trigger if exists wx_alerta_push on public.alertas;
create trigger wx_alerta_push after insert on public.alertas
  for each row execute function public.wx_alerta_push();
