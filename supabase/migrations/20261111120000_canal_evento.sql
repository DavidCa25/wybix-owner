begin;
-- ============================================================================
--  CANAL DE PRECIOS DEL EVENTO.
--
--  Los canales y sus precios los define la sucursal base en el panel
--  comercial del POS de escritorio y llegan a la tablet con el catálogo. Aquí
--  solo se elige, por evento, con qué canal EMPIEZA cada cuenta en la tablet
--  (p. ej. "Feria"); la cajera puede cambiarlo en una cuenta. Nulo = Mostrador.
--  Solo se acepta un canal ACTIVO del catálogo publicado de la sucursal base.
-- ============================================================================

alter table public.sucursales add column if not exists canal_precio text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sucursales_canal_precio_check') then
    alter table public.sucursales add constraint sucursales_canal_precio_check
      check (canal_precio is null or (length(canal_precio) between 1 and 40));
  end if;
end $$;

-- Canales del último catálogo publicado de la sucursal base del evento.
create or replace function public.wx_canales_evento(p_location uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object('id', c->>'id', 'name', c->>'name', 'active', coalesce((c->>'active')::boolean, false)))
      from jsonb_array_elements(coalesce((
        select cp.payload->'commercial'->'channels' from public.catalog_publications cp
         where cp.location_id = (select home_location_id from public.sucursales where id = p_location)
         order by cp.version desc limit 1), '[]')) c), '[]'::jsonb)
$$;

-- Leer: cualquier miembro activo de la empresa.
create or replace function public.owner_evento_canales(p_company uuid, p_location uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.sucursales%rowtype;
begin
  if public.wx_rol(p_company) is null then raise exception 'DENIED' using errcode = '42501'; end if;
  select * into s from public.sucursales where id = p_location and negocio_id = p_company and tipo = 'EVENT';
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  return jsonb_build_object('ok', true, 'canal', s.canal_precio, 'canales', public.wx_canales_evento(s.id));
end $$;

-- Guardar: dueño o administrador, con segundo factor. Nulo o vacío = Mostrador.
create or replace function public.owner_evento_canal(p_company uuid, p_location uuid, p_canal text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_mfa jsonb := public.wx_mfa_bloqueo(auth.uid());
        a jsonb := public.wx_actor_admin(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company));
        s public.sucursales%rowtype;
        v_canal text := nullif(btrim(coalesce(p_canal, '')), '');
begin
  if v_mfa is not null then return v_mfa; end if;
  if a is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  select * into s from public.sucursales where id = p_location and negocio_id = p_company and tipo = 'EVENT';
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if v_canal = 'LOCAL' then v_canal := null; end if;
  if v_canal is not null and not exists (
       select 1 from jsonb_array_elements(public.wx_canales_evento(s.id)) c where c->>'id' = v_canal and (c->>'active')::boolean) then
    return jsonb_build_object('ok', false, 'code', 'BAD_CHANNEL');
  end if;
  update public.sucursales set canal_precio = v_canal where id = s.id;
  perform public.wx_audit('USER', auth.uid()::text, p_company, 'EVENTO_CANAL', 'OK',
    jsonb_build_object('location_id', s.id, 'canal', v_canal));
  return jsonb_build_object('ok', true, 'canal', v_canal);
end $$;

-- Snapshot de la tablet: igual que 20261107120000 más location.default_channel.
create or replace function public.mobile_snapshot(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices%rowtype; s public.sucursales%rowtype; n public.negocios%rowtype; v_cat public.catalog_publications%rowtype; r public.registers%rowtype;
        v_hash text;
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
  v_hash := case when n.marca is null then null else md5(n.marca::text) end;
  return jsonb_build_object('ok', true,
    'snapshot_version', extract(epoch from now())::bigint,
    'security_revision', s.security_revision,
    'device', jsonb_build_object('id', d.id, 'uuid', d.device_uuid, 'status', d.status),
    'company', jsonb_build_object('uuid', n.id, 'nombre', n.nombre),
    'location', jsonb_build_object('uuid', s.id, 'nombre', s.nombre, 'tipo', s.tipo, 'timezone', s.timezone, 'status', s.status,
                                   'event_status', s.event_status, 'home_location_uuid', s.home_location_id, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
                                   'default_channel', s.canal_precio),
    'register', case when r.id is null then null else jsonb_build_object('uuid', r.register_uuid, 'code', r.code, 'name', r.name) end,
    'catalog', case when v_cat.id is null then null else v_cat.payload || jsonb_build_object('catalog_version', v_cat.version) end,
    'staff', coalesce((select jsonb_agg(jsonb_build_object('uuid', e.pos_user_uuid, 'name', e.display_name, 'role', ls.role,
                                 'pin_hash', e.pin_hash, 'pin_sal', e.pin_sal, 'pin_algo', e.pin_algo, 'active', ls.active and e.status = 'ACTIVE'))
                         from public.location_staff ls join public.employees e on e.id = ls.employee_id
                        where ls.location_id = s.id and e.pin_hash is not null), '[]'),
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
    -- null = sin marca (Wybix). El logo solo viaja si la tablet no tiene este hash.
    'brand', case when v_hash is null then null else jsonb_build_object(
               'hash', v_hash, 'color', n.marca->>'color',
               'logo_incluido', coalesce(p->>'brand_hash', '') <> v_hash,
               'logo', case when coalesce(p->>'brand_hash', '') <> v_hash then n.marca->'logo' else null end) end);
end $$;

revoke all on function public.mobile_snapshot(jsonb) from public, anon, authenticated;
grant execute on function public.mobile_snapshot(jsonb) to service_role;
revoke all on function public.wx_canales_evento(uuid), public.owner_evento_canales(uuid, uuid), public.owner_evento_canal(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.owner_evento_canales(uuid, uuid), public.owner_evento_canal(uuid, uuid, text) to authenticated;

commit;
