-- ============================================================================
--  DESCARGAS: instaladores de las apps (dueño, POS Mobile) bajo el dominio
--  de Wybix.
-- ----------------------------------------------------------------------------
--  El bucket es público para LEER: un APK no es un secreto y se descarga sin
--  sesión. Nadie lo escribe desde fuera: no hay políticas de insert/update/
--  delete, así que solo el backend (service_role) sube versiones.
--
--  wybixpos.com.mx/descargas/<archivo> lo sirve Vercel con un reenvío interno
--  (ver vercel.json de wybix-landing): quien descarga nunca ve Supabase ni
--  Expo.
--
--  Sin el esquema `storage` (Postgres de pruebas sin Supabase) no hace nada.
-- ============================================================================
do $$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('descargas', 'descargas', true, 209715200, array['application/vnd.android.package-archive', 'application/octet-stream'])
  on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
end $$;
