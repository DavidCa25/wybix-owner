-- ============================================================================
--  EMULACIÓN MÍNIMA DE SUPABASE AUTH PARA PRUEBAS (Postgres 17 desechable)
-- ----------------------------------------------------------------------------
--  auth.uid() lee el `sub` de request.jwt.claims, igual que en Supabase, así
--  las políticas RLS y las funciones se prueban con la identidad que tendría
--  un usuario real:  set local request.jwt.claims = '{"sub":"<uuid>"}';
--                    set local role authenticated;
-- ============================================================================
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
