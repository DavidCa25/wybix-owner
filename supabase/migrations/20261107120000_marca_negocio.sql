begin;
-- ============================================================================
--  MARCA DEL NEGOCIO para Wybix POS Mobile (logo y color).
--
--  La dueña la configura en Wybix Owner (dentro del evento) y es de la
--  EMPRESA: todas sus tablets la reciben con el snapshot. El logo viaja
--  embebido (data URI PNG/JPEG/WebP, acotado) porque la tablet trabaja sin
--  Internet; para no mandarlo en cada sincronización, la tablet envía el
--  hash de la marca que ya tiene y la nube solo incluye el logo si cambió.
--  El cálculo de contraste vive en @wybix/domain (marca.ts): la nube guarda
--  el color tal cual lo eligió la dueña.
-- ============================================================================

alter table public.negocios add column if not exists marca jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'negocios_marca_check') then
    alter table public.negocios add constraint negocios_marca_check check (
      marca is null or (
        jsonb_typeof(marca) = 'object'
        and (marca->>'color' is null or marca->>'color' ~ '^#[0-9A-F]{6}$')
        and (marca->>'logo' is null or (length(marca->>'logo') <= 300000
             and marca->>'logo' ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'))));
  end if;
end $$;

-- Leer: cualquier miembro activo de la empresa.
create or replace function public.owner_marca(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if public.wx_rol(p_company) is null then raise exception 'DENIED' using errcode = '42501'; end if;
  return jsonb_build_object('ok', true, 'marca', (select marca from public.negocios where id = p_company));
end $$;

-- Guardar: dueño o administrador, con segundo factor. Color y logo nulos = marca de Wybix.
create or replace function public.owner_marca_guardar(p_company uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_mfa jsonb := public.wx_mfa_bloqueo(auth.uid());
        a jsonb := public.wx_actor_admin(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company));
        v_color text := upper(nullif(btrim(coalesce(p->>'color', '')), ''));
        v_logo text := nullif(p->>'logo', '');
        v_marca jsonb;
begin
  if v_mfa is not null then return v_mfa; end if;
  if a is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if v_color is not null and v_color !~ '^#[0-9A-F]{6}$' then return jsonb_build_object('ok', false, 'code', 'BAD_COLOR'); end if;
  if v_logo is not null and (length(v_logo) > 300000 or v_logo !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$') then
    return jsonb_build_object('ok', false, 'code', 'BAD_LOGO');
  end if;
  v_marca := case when v_color is null and v_logo is null then null
                  else jsonb_build_object('color', v_color, 'logo', v_logo) end;
  update public.negocios set marca = v_marca, updated_at = now() where id = p_company;
  perform public.wx_audit('USER', auth.uid()::text, p_company, 'MARCA_GUARDADA', 'OK',
    jsonb_build_object('color', v_color, 'logo_caracteres', coalesce(length(v_logo), 0)));
  return jsonb_build_object('ok', true, 'marca', v_marca);
end $$;

-- Snapshot de la tablet: igual que 20261012150000 más 'brand'.
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
                                   'event_status', s.event_status, 'home_location_uuid', s.home_location_id, 'starts_at', s.starts_at, 'ends_at', s.ends_at),
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
revoke all on function public.owner_marca(uuid), public.owner_marca_guardar(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.owner_marca(uuid), public.owner_marca_guardar(uuid, jsonb) to authenticated;

commit;
