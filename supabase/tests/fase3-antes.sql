-- ============================================================================
--  ESTADO DE PRODUCCIÓN ANTES DE LA FASE 3 (lo que no está versionado).
--  Se aplica ANTES de las migraciones de la Fase 3 para probar que las
--  reemplazan bien.
--
--  1. El webhook `alerta-push` creado desde el panel, con el secreto ESCRITO
--     en la definición (así lo guarda Supabase: argumentos del trigger).
--  2. Vault y pg_net no existen en un Postgres de pruebas: se emulan con lo
--     mínimo que usa Wybix (vault.decrypted_secrets y net.http_post), y
--     net.http_post deja cada llamada en una tabla para poder revisarla.
-- ============================================================================
create schema if not exists vault;
create table if not exists vault.t_secretos (name text primary key, decrypted_secret text);
create or replace view vault.decrypted_secrets as select name, decrypted_secret from vault.t_secretos;

create schema if not exists net;
create table if not exists net.t_llamadas (n serial, url text, body jsonb, headers jsonb);
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
                                         headers jsonb default '{}', timeout_milliseconds int default 2000)
returns bigint language sql as $$ insert into net.t_llamadas (url, body, headers) values (url, body, headers) returning n::bigint $$;

create or replace function public.t_webhook_panel() returns trigger language plpgsql as $$ begin return new; end $$;
drop trigger if exists "alerta-push" on public.alertas;
create trigger "alerta-push" after insert on public.alertas for each row
  execute function public.t_webhook_panel('https://ejemplo.supabase.co/functions/v1/send-alert-push', 'POST',
                                          '{"Content-type":"application/json","x-webhook-secret":"secreto-viejo-escrito-en-el-trigger"}', '{}', '5000');
