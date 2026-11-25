begin;
-- ============================================================================
--  POS MOBILE RÁPIDO (auditoría 2026-11-24, docs/auditoria-pos-mobile-owner-20261124.md)
--
--  1. SNAPSHOT CONDICIONAL. La tablet manda la versión de catálogo y la
--     revisión de personal que ya tiene. Si no cambiaron, `catalog` y `staff`
--     viajan como null: antes bajaban completos en cada ciclo (cada minuto y
--     después de cada venta). La tablet nueva entiende null como «sin cambios»;
--     una tablet vieja no manda versiones, así que sigue recibiendo todo.
--     `catalog_version` y `security_revision` siempre van, para que la tablet
--     sepa que está al día.
--
--  2. MÉTRICAS DEL LATIDO. La tablet reporta cuánto tardó su último ciclo,
--     por fase, y cuántos bytes bajó. Owner lo muestra en «Tablets en vivo».
-- ============================================================================

alter table public.devices add column if not exists sync_stats jsonb;

create or replace function public.mobile_snapshot(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices%rowtype; s public.sucursales%rowtype; n public.negocios%rowtype; v_cat public.catalog_publications%rowtype; r public.registers%rowtype;
        v_hash text; v_tiene_cat bigint; v_tiene_rev bigint; v_manda_cat boolean; v_manda_staff boolean;
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id');
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if d.status <> 'ACTIVE' or d.kind <> 'MOBILE_POS' then return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED'); end if;
  select * into s from public.sucursales where id = d.location_id;
  select * into n from public.negocios where id = d.company_id;
  select * into r from public.registers where id = d.register_id;
  select * into v_cat from public.catalog_publications where location_id = s.home_location_id order by version desc limit 1;
  if v_cat.payload->'commercial' is not null and (
       exists(select 1 from jsonb_array_elements(coalesce(v_cat.payload->'commercial'->'promotions','[]')) x where (x->>'active')::boolean)
       or exists(select 1 from jsonb_array_elements(coalesce(v_cat.payload->'commercial'->'combos','[]')) x where (x->>'active')::boolean)
       or exists(select 1 from jsonb_array_elements(coalesce(v_cat.payload->'commercial'->'channels','[]')) x where x->>'id'<>'LOCAL' and (x->>'active')::boolean))
     and coalesce((p->>'commercial_schema')::int,0)<1 then
    return jsonb_build_object('ok',false,'code','UPDATE_REQUIRED','message','Actualiza Wybix POS Mobile para usar el catálogo de precios y ofertas.');
  end if;
  if coalesce((p->>'commercial_schema')::int,0)<2 and (
    exists(select 1 from jsonb_array_elements(coalesce(v_cat.payload->'commercial'->'promotions','[]')) x where (x->>'active')::boolean and x->>'kind'='VOLUME')
    or exists(select 1 from jsonb_array_elements(coalesce(v_cat.payload->'commercial'->'combos','[]')) x where (x->>'active')::boolean and (jsonb_array_length(coalesce(x->'weekdays','[]'))>0 or jsonb_array_length(coalesce(x->'windows','[]'))>0 or x->>'starts' is not null or x->>'ends' is not null))) then
    return jsonb_build_object('ok',false,'code','UPDATE_REQUIRED','message','Actualiza Wybix POS Mobile para usar mayoreo y horarios de combos.');
  end if;
  if coalesce((p->>'commercial_schema')::int,0)<3 and (
    exists(select 1 from jsonb_array_elements(coalesce(v_cat.payload->'commercial'->'promotions','[]')) x where (x->>'active')::boolean and x ? 'tiers')
    or exists(select 1 from jsonb_array_elements(coalesce(v_cat.payload->'commercial'->'combos','[]')) x where (x->>'active')::boolean and (x->>'auto')::boolean)) then
    return jsonb_build_object('ok',false,'code','UPDATE_REQUIRED','message','Actualiza Wybix POS Mobile para usar paquetes y combos automáticos.');
  end if;

  -- Lo que la tablet ya tiene. Sin dato (tablet vieja) se manda todo.
  v_tiene_cat := nullif(p->>'catalog_version', '')::bigint;
  v_tiene_rev := nullif(p->>'security_revision', '')::bigint;
  v_manda_cat := v_cat.id is not null and (v_tiene_cat is null or v_tiene_cat < v_cat.version);
  v_manda_staff := v_tiene_rev is null or v_tiene_rev < coalesce(s.security_revision, 0);

  v_hash := case when n.marca is null then null else md5(n.marca::text) end;
  return jsonb_build_object('ok', true,
    'snapshot_version', extract(epoch from now())::bigint,
    'security_revision', s.security_revision,
    'catalog_version', v_cat.version,
    'sin_cambios', not v_manda_cat and not v_manda_staff,
    'device', jsonb_build_object('id', d.id, 'uuid', d.device_uuid, 'status', d.status),
    'company', jsonb_build_object('uuid', n.id, 'nombre', n.nombre),
    'location', jsonb_build_object('uuid', s.id, 'nombre', s.nombre, 'tipo', s.tipo, 'timezone', s.timezone, 'status', s.status,
                                   'event_status', s.event_status, 'home_location_uuid', s.home_location_id, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
                                   'default_channel', s.canal_precio),
    'register', case when r.id is null then null else jsonb_build_object('uuid', r.register_uuid, 'code', r.code, 'name', r.name) end,
    'catalog', case when v_manda_cat then v_cat.payload || jsonb_build_object('catalog_version', v_cat.version) else null end,
    'staff', case when not v_manda_staff then null else
             coalesce((select jsonb_agg(jsonb_build_object('uuid', e.pos_user_uuid, 'name', e.display_name, 'role', ls.role,
                                 'pin_hash', e.pin_hash, 'pin_sal', e.pin_sal, 'pin_algo', e.pin_algo, 'active', ls.active and e.status = 'ACTIVE'))
                         from public.location_staff ls join public.employees e on e.id = ls.employee_id
                        where ls.location_id = s.id and e.pin_hash is not null), '[]') end,
    'payment_methods', jsonb_build_array(
      jsonb_build_object('code', 'EFECTIVO', 'label', 'Efectivo', 'enabled', true),
      jsonb_build_object('code', 'TARJETA', 'label', 'Tarjeta (terminal)', 'enabled', true),
      jsonb_build_object('code', 'TRANSFERENCIA', 'label', 'Transferencia', 'enabled', true)),
    'trusted_keys', coalesce((select jsonb_agg(jsonb_build_object('key_id', x.id, 'public_key', x.signing_public_key, 'location_uuid', x.location_id, 'label', x.name))
                                from public.devices x where x.company_id = d.company_id and x.status = 'ACTIVE' and x.signing_public_key is not null), '[]'),
    'transfers', coalesce((select jsonb_agg(jsonb_build_object('transfer_uuid', t.transfer_uuid, 'from_location_uuid', t.from_location_id,
                                 'to_location_uuid', t.to_location_id, 'status', t.status,
                                 'lines', (select jsonb_agg(jsonb_build_object('product_uuid', l.product_uuid, 'product_name', l.product_name, 'qty_sent', l.qty_sent::text))
                                             from public.stock_transfer_lines l where l.transfer_uuid = t.transfer_uuid)))
                             from public.stock_transfers t where t.to_location_id = s.id and t.kind = 'OUT' and t.status = 'SENT'), '[]'),
    'releases', (select jsonb_build_object('latest_version', a.latest_version, 'min_supported_version', a.min_supported_version)
                   from public.app_releases a where a.app = 'pos-mobile' and a.channel = coalesce(p->>'channel', 'production')),
    'brand', case when v_hash is null then null else jsonb_build_object(
               'hash', v_hash, 'color', n.marca->>'color',
               'logo_incluido', coalesce(p->>'brand_hash', '') <> v_hash,
               'logo', case when coalesce(p->>'brand_hash', '') <> v_hash then n.marca->'logo' else null end) end);
end $$;

revoke all on function public.mobile_snapshot(jsonb) from public, anon, authenticated;
grant execute on function public.mobile_snapshot(jsonb) to service_role;

-- Latido con métricas del último ciclo (solo números y textos cortos).
create or replace function public.mobile_latido(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_stats jsonb;
begin
  if jsonb_typeof(p->'stats') = 'object' then
    select jsonb_object_agg(k, v) into v_stats
      from jsonb_each(p->'stats') x(k, v)
     where k in ('total_ms', 'subir_ms', 'inbox_ms', 'snapshot_ms', 'bytes', 'catalogo', 'modo', 'enviados', 'error')
       and jsonb_typeof(v) in ('number', 'string', 'boolean') and length(v::text) <= 80;
  end if;
  update public.devices set pending_events = nullif(p->>'pendientes', '')::int, app_version = coalesce(nullif(p->>'app_version', ''), app_version),
         sync_stats = coalesce(v_stats || jsonb_build_object('at', now()), sync_stats),
         last_seen_at = now()
   where id = public.wx_uuid(p->>'device_id');
  return jsonb_build_object('ok', found);
end $$;

revoke all on function public.mobile_latido(jsonb) from public, anon, authenticated;
grant execute on function public.mobile_latido(jsonb) to service_role;

-- Owner · Tablets en vivo: lo de siempre más las métricas del último ciclo.
-- Mismo texto que 20261010120000_fase2_event_mobile.sql + 'sync_stats'.
create or replace function public.estado_dispositivos(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if public.wx_rol(p_company) is null then raise exception 'DENIED' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'name', d.name, 'status', d.status,
                     'location_id', d.location_id, 'location', s.nombre, 'tipo', s.tipo, 'app_version', d.app_version,
                     'last_seen_at', d.last_seen_at, 'last_sync_at', d.last_sync_at, 'pending_events', d.pending_events,
                     'revoked_at', d.revoked_at, 'register', r.code, 'clock_skew_seconds', d.clock_skew_seconds,
                     'sync_stats', d.sync_stats,
                     'en_linea', d.last_seen_at > now() - interval '10 minutes') order by s.tipo, s.nombre, d.kind)
                    from public.devices d join public.sucursales s on s.id = d.location_id left join public.registers r on r.id = d.register_id
                   where d.company_id = p_company and (public.wx_puede_ubicacion(d.location_id))), '[]');
end $$;

commit;
