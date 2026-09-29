-- ============================================================================
--  SINCRONIZACIÓN DEL POS SIN SERVICE ROLE
-- ----------------------------------------------------------------------------
--  El POS escribía en Supabase con el service role (capturado en cada caja).
--  Ahora pasa por la Edge Function `pos-sync` con un token por sucursal; aquí
--  solo se guarda el HASH (SHA-256) de ese token.
--
--  DESPUÉS DE DESPLEGAR `pos-sync` Y ACTUALIZAR LOS POS: rotar el JWT secret
--  del proyecto (Settings > API) para invalidar el service role que quedó en
--  las cajas instaladas. Hasta entonces esa llave sigue siendo válida.
-- ============================================================================
alter table public.sucursales add column if not exists sync_token_hash text;
create unique index if not exists ux_sucursales_sync_token on public.sucursales (sync_token_hash) where sync_token_hash is not null;
