-- ============================================================================
--  MULTISUCURSAL: matriz, catálogo corporativo, excepciones y traspasos
-- ----------------------------------------------------------------------------
--  Modelo (como Toast/Square/Lightspeed, pero sin dejar de vender sin red):
--
--   · Empresa -> sucursales iguales; UNA es la MATRIZ (por omisión la primera
--     que se dio de alta). La matriz publica el catálogo corporativo:
--     productos, categorías, recetas, modificadores, política comercial y
--     usuarios de empresa. Versionado y por huella: si no cambió, no hay
--     versión nueva.
--   · Cada sucursal lo recibe cuando tiene red y lo aplica en su base local.
--     Su inventario, ventas, cortes y configuración de caja siguen siendo
--     suyos.
--   · EXCEPCIONES por sucursal (precio distinto, «no se vende aquí»): las
--     decide la matriz, viajan aparte y tienen su propia revisión.
--   · TRASPASOS entre sucursales: enviado -> recibido (o cancelado por quien
--     envía). El inventario se mueve en cada base local; la nube solo
--     acuerda el estado.
--   · Todo exige el complemento MULTIBRANCH en una licencia activa de la
--     empresa. Sin él, cada sucursal opera como hoy.
--
--  Solo service_role (pos-sync) llama las funciones de equipo; el dueño, las
--  owner_*. Idempotente: el arnés la aplica dos veces.
-- ============================================================================
begin;

-- ---------------------------------------------------------------- empresa
alter table public.negocios add column if not exists matriz_location_id uuid references public.sucursales(id) on delete set null;
/* precios_sucursal:   la sucursal puede cambiar el precio de un producto corporativo
   productos_locales:  la sucursal puede dar de alta productos propios          */
alter table public.negocios add column if not exists multi_reglas jsonb not null
  default '{"precios_sucursal": false, "productos_locales": true}';
alter table public.sucursales add column if not exists overrides_revision int not null default 0;

update public.license_catalog
   set description = 'Matriz con catálogo central, precios y disponibilidad por sucursal, traspasos entre sucursales y usuarios de empresa.',
       notes = null
 where code = 'ADDON_MULTIBRANCH';

/* ¿La empresa tiene MultiSucursal? Un complemento en cualquier licencia activa. */
create or replace function public.wx_multisucursal(p_company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.licenses x
                  where x.company_id = p_company and x.status = 'activa'
                    and 'MULTIBRANCH' = any (coalesce(x.addons, '{}')));
$$;

/* La matriz: la elegida, o la sucursal fija más antigua de la empresa. */
create or replace function public.wx_matriz(p_company uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select n.matriz_location_id from public.negocios n
       join public.sucursales s on s.id = n.matriz_location_id and s.tipo = 'BRANCH' and s.status in ('ACTIVE', 'PENDING')
      where n.id = p_company),
    (select s.id from public.sucursales s
      where s.negocio_id = p_company and s.tipo = 'BRANCH' and s.status in ('ACTIVE', 'PENDING')
      order by s.created_at, s.id limit 1));
$$;

-- ------------------------------------------------- catálogo corporativo
create table if not exists public.corporate_catalog_publications (
  id bigserial primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  version int not null,
  content_hash text not null,
  payload jsonb not null,
  published_at timestamptz not null default now(),
  published_by_device uuid,
  published_from_location uuid,
  unique (company_id, version),
  unique (company_id, content_hash)
);

-- --------------------------------------------------- excepciones
create table if not exists public.location_product_overrides (
  location_id uuid not null references public.sucursales(id) on delete cascade,
  company_id uuid not null references public.negocios(id) on delete cascade,
  product_uuid uuid not null,
  price numeric(12, 2) check (price is null or price >= 0),
  available boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by_device uuid,
  primary key (location_id, product_uuid)
);

-- ---------------------------------------------------------- traspasos
create table if not exists public.branch_transfers (
  id uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  from_location_id uuid not null references public.sucursales(id) on delete cascade,
  to_location_id uuid not null references public.sucursales(id) on delete cascade,
  status text not null check (status in ('SENT', 'RECEIVED', 'CANCELLED')),
  lines jsonb not null,
  received_lines jsonb,
  note text,
  sent_at timestamptz not null default now(),
  sent_by_device uuid,
  sent_by_name text,
  received_at timestamptz,
  received_by_device uuid,
  received_by_name text,
  cancelled_at timestamptz,
  check (from_location_id <> to_location_id)
);
create index if not exists ix_branch_transfers_to on public.branch_transfers (to_location_id, status);
create index if not exists ix_branch_transfers_from on public.branch_transfers (from_location_id, sent_at desc);

alter table public.corporate_catalog_publications enable row level security;
alter table public.location_product_overrides enable row level security;
alter table public.branch_transfers enable row level security;
revoke all on public.corporate_catalog_publications, public.location_product_overrides, public.branch_transfers from public, anon, authenticated;

-- ============================================================================
--  EQUIPO (pos-sync, service_role). El device_id sale de la credencial.
-- ============================================================================

/* La caja principal ACTIVA de una sucursal fija; si no, null. */
create or replace function public.wx_multi_equipo(p jsonb)
returns public.devices language plpgsql stable security definer set search_path = public as $$
declare d public.devices%rowtype;
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE' and kind = 'POS_PRIMARY';
  if not found then return null; end if;
  if not exists (select 1 from public.sucursales s where s.id = d.location_id and s.tipo = 'BRANCH' and s.status in ('ACTIVE', 'PENDING')) then return null; end if;
  return d;
end $$;

/* Lo que una caja necesita saber: si hay MultiSucursal, si es la matriz, las
   sucursales de la empresa y en qué versión va todo. Sin licencia también
   responde (multisucursal=false): la pantalla explica qué falta. */
create or replace function public.multi_estado(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices; v_matriz uuid;
begin
  d := public.wx_multi_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  v_matriz := public.wx_matriz(d.company_id);
  return jsonb_build_object('ok', true,
    'multisucursal', public.wx_multisucursal(d.company_id),
    'location_id', d.location_id,
    'es_matriz', v_matriz = d.location_id,
    'matriz', (select jsonb_build_object('id', s.id, 'nombre', s.nombre) from public.sucursales s where s.id = v_matriz),
    'sucursales', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'nombre', s.nombre, 'es_matriz', s.id = v_matriz) order by s.created_at, s.id)
                              from public.sucursales s where s.negocio_id = d.company_id and s.tipo = 'BRANCH' and s.status in ('ACTIVE', 'PENDING')), '[]'),
    'reglas', (select multi_reglas from public.negocios where id = d.company_id),
    'version', (select max(version) from public.corporate_catalog_publications where company_id = d.company_id),
    'overrides_revision', (select overrides_revision from public.sucursales where id = d.location_id));
end $$;

/* La matriz publica. Misma huella = misma versión (reintentos y arranques). */
create or replace function public.multi_publicar(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; v_hash text; v_ver int;
begin
  d := public.wx_multi_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if not public.wx_multisucursal(d.company_id) then return jsonb_build_object('ok', false, 'code', 'NO_ENTITLEMENT_MULTIBRANCH'); end if;
  if public.wx_matriz(d.company_id) is distinct from d.location_id then return jsonb_build_object('ok', false, 'code', 'NOT_MATRIZ'); end if;
  if coalesce(jsonb_typeof(p->'catalog'), '') <> 'object' or coalesce(jsonb_typeof(p->'catalog'->'products'), '') <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  v_hash := md5((p->'catalog')::text);
  perform pg_advisory_xact_lock(hashtextextended('multi-catalogo:' || d.company_id::text, 0));
  select version into v_ver from public.corporate_catalog_publications where company_id = d.company_id and content_hash = v_hash;
  if v_ver is null then
    select coalesce(max(version), 0) + 1 into v_ver from public.corporate_catalog_publications where company_id = d.company_id;
    insert into public.corporate_catalog_publications (company_id, version, content_hash, payload, published_by_device, published_from_location)
    values (d.company_id, v_ver, v_hash, p->'catalog', d.id, d.location_id);
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'MULTI_PUBLISH', 'OK', jsonb_build_object('version', v_ver));
  end if;
  return jsonb_build_object('ok', true, 'version', v_ver);
end $$;

/* Una sucursal pregunta si hay algo nuevo. Solo devuelve lo que cambió. */
create or replace function public.multi_recibir(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices; v_pub public.corporate_catalog_publications%rowtype; v_rev int;
        v_ya int := coalesce(nullif(p->>'version', '')::int, 0); v_ya_rev int := coalesce(nullif(p->>'overrides_revision', '')::int, -1);
begin
  d := public.wx_multi_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if not public.wx_multisucursal(d.company_id) then return jsonb_build_object('ok', false, 'code', 'NO_ENTITLEMENT_MULTIBRANCH'); end if;
  select * into v_pub from public.corporate_catalog_publications where company_id = d.company_id order by version desc limit 1;
  select overrides_revision into v_rev from public.sucursales where id = d.location_id;
  return jsonb_build_object('ok', true,
    'es_matriz', public.wx_matriz(d.company_id) = d.location_id,
    'location_id', d.location_id,
    'version', v_pub.version,
    'catalog', case when v_pub.version is not null and v_pub.version > v_ya then v_pub.payload end,
    'overrides_revision', v_rev,
    'overrides', case when v_rev <> v_ya_rev then coalesce((
        select jsonb_agg(jsonb_build_object('product_uuid', o.product_uuid, 'price', o.price, 'available', o.available))
          from public.location_product_overrides o where o.location_id = d.location_id), '[]') end,
    'reglas', (select multi_reglas from public.negocios where id = d.company_id));
end $$;

/* La matriz fija las excepciones de UNA sucursal (reemplaza las anteriores)
   y, si las manda, las reglas de la empresa. */
create or replace function public.multi_excepciones(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; v_loc uuid := public.wx_uuid(p->>'location_id'); e jsonb; v_n int := 0;
begin
  d := public.wx_multi_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if not public.wx_multisucursal(d.company_id) then return jsonb_build_object('ok', false, 'code', 'NO_ENTITLEMENT_MULTIBRANCH'); end if;
  if public.wx_matriz(d.company_id) is distinct from d.location_id then return jsonb_build_object('ok', false, 'code', 'NOT_MATRIZ'); end if;

  if jsonb_typeof(p->'reglas') = 'object' then
    update public.negocios set multi_reglas = jsonb_build_object(
        'precios_sucursal', coalesce((p->'reglas'->>'precios_sucursal')::boolean, false),
        'productos_locales', coalesce((p->'reglas'->>'productos_locales')::boolean, true))
     where id = d.company_id;
    -- Todas las sucursales vuelven a pedir: las reglas viajan con sus excepciones.
    update public.sucursales set overrides_revision = overrides_revision + 1 where negocio_id = d.company_id and tipo = 'BRANCH';
  end if;

  if v_loc is not null then
    if not exists (select 1 from public.sucursales where id = v_loc and negocio_id = d.company_id and tipo = 'BRANCH') then
      return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
    end if;
    if coalesce(jsonb_typeof(p->'items'), '') <> 'array' then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
    delete from public.location_product_overrides where location_id = v_loc;
    for e in select * from jsonb_array_elements(p->'items') loop
      continue when public.wx_uuid(e->>'product_uuid') is null;
      -- Sin precio especial y disponible = sin excepción: no se guarda.
      continue when nullif(e->>'price', '') is null and coalesce((e->>'available')::boolean, true);
      if nullif(e->>'price', '') is not null and (e->>'price')::numeric < 0 then return jsonb_build_object('ok', false, 'code', 'BAD_PRICE'); end if;
      insert into public.location_product_overrides (location_id, company_id, product_uuid, price, available, updated_by_device)
      values (v_loc, d.company_id, public.wx_uuid(e->>'product_uuid'), nullif(e->>'price', '')::numeric, coalesce((e->>'available')::boolean, true), d.id)
      on conflict (location_id, product_uuid) do update set price = excluded.price, available = excluded.available,
        updated_at = now(), updated_by_device = excluded.updated_by_device;
      v_n := v_n + 1;
    end loop;
    update public.sucursales set overrides_revision = overrides_revision + 1 where id = v_loc;
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'MULTI_OVERRIDES', 'OK', jsonb_build_object('location_id', v_loc, 'n', v_n));
  end if;
  return jsonb_build_object('ok', true, 'n', v_n);
end $$;

/* La matriz consulta las excepciones vigentes de una sucursal. */
create or replace function public.multi_excepciones_listar(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices; v_loc uuid := public.wx_uuid(p->>'location_id');
begin
  d := public.wx_multi_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if public.wx_matriz(d.company_id) is distinct from d.location_id then return jsonb_build_object('ok', false, 'code', 'NOT_MATRIZ'); end if;
  if not exists (select 1 from public.sucursales where id = v_loc and negocio_id = d.company_id) then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'items', coalesce((
    select jsonb_agg(jsonb_build_object('product_uuid', o.product_uuid, 'price', o.price, 'available', o.available))
      from public.location_product_overrides o where o.location_id = v_loc), '[]'));
end $$;

/* Envío de mercancía a otra sucursal. Idempotente por id: un reintento con
   lo mismo devuelve lo mismo; con otro contenido, CONFLICT. */
create or replace function public.multi_traspaso_enviar(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; v_id uuid := public.wx_uuid(p->>'id'); v_to uuid := public.wx_uuid(p->>'to_location_id');
        t public.branch_transfers%rowtype; e jsonb;
begin
  d := public.wx_multi_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if not public.wx_multisucursal(d.company_id) then return jsonb_build_object('ok', false, 'code', 'NO_ENTITLEMENT_MULTIBRANCH'); end if;
  -- Por separado: OR en SQL no corta, y jsonb_array_length revienta si no es arreglo.
  if v_id is null or v_to is null or coalesce(jsonb_typeof(p->'lines'), '') <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  if jsonb_array_length(p->'lines') = 0 then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  for e in select * from jsonb_array_elements(p->'lines') loop
    if public.wx_uuid(e->>'product_uuid') is null or coalesce((e->>'qty')::numeric, 0) <= 0 then
      return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
    end if;
  end loop;
  select * into t from public.branch_transfers where id = v_id;
  if found then
    if t.from_location_id <> d.location_id or t.to_location_id <> v_to or t.lines <> p->'lines' then
      return jsonb_build_object('ok', false, 'code', 'CONFLICT');
    end if;
    return jsonb_build_object('ok', true, 'id', t.id, 'status', t.status);
  end if;
  if v_to = d.location_id or not exists (select 1 from public.sucursales where id = v_to and negocio_id = d.company_id and tipo = 'BRANCH' and status in ('ACTIVE', 'PENDING')) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  insert into public.branch_transfers (id, company_id, from_location_id, to_location_id, status, lines, note, sent_by_device, sent_by_name)
  values (v_id, d.company_id, d.location_id, v_to, 'SENT', p->'lines', left(p->>'note', 255), d.id, left(p->>'sent_by_name', 120));
  perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'MULTI_TRANSFER_SEND', 'OK', jsonb_build_object('id', v_id, 'to', v_to));
  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'SENT');
end $$;

/* Lo que llega a esta sucursal y lo que mandó (últimos 30 días). */
create or replace function public.multi_traspaso_bandeja(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices;
begin
  d := public.wx_multi_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  return jsonb_build_object('ok', true,
    'entrantes', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'from_location_id', t.from_location_id, 'from_nombre', s.nombre,
                      'lines', t.lines, 'note', t.note, 'sent_at', t.sent_at, 'sent_by_name', t.sent_by_name) order by t.sent_at)
        from public.branch_transfers t join public.sucursales s on s.id = t.from_location_id
       where t.to_location_id = d.location_id and t.status = 'SENT'), '[]'),
    'enviados', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'to_location_id', t.to_location_id, 'to_nombre', s.nombre,
                      'status', t.status, 'received_lines', t.received_lines, 'received_at', t.received_at,
                      'received_by_name', t.received_by_name, 'cancelled_at', t.cancelled_at) order by t.sent_at desc)
        from public.branch_transfers t join public.sucursales s on s.id = t.to_location_id
       where t.from_location_id = d.location_id and t.sent_at > now() - interval '30 days'), '[]'));
end $$;

/* La sucursal destino confirma lo que llegó. Idempotente. */
create or replace function public.multi_traspaso_recibir(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; t public.branch_transfers%rowtype;
begin
  d := public.wx_multi_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  select * into t from public.branch_transfers where id = public.wx_uuid(p->>'id') for update;
  if not found or t.to_location_id <> d.location_id then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if t.status = 'RECEIVED' then return jsonb_build_object('ok', true, 'status', 'RECEIVED'); end if;
  if t.status = 'CANCELLED' then return jsonb_build_object('ok', false, 'code', 'CANCELLED'); end if;
  if coalesce(jsonb_typeof(p->'received_lines'), '') <> 'array' then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  update public.branch_transfers set status = 'RECEIVED', received_lines = p->'received_lines', received_at = now(),
         received_by_device = d.id, received_by_name = left(p->>'received_by_name', 120)
   where id = t.id;
  perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'MULTI_TRANSFER_RECEIVE', 'OK', jsonb_build_object('id', t.id));
  return jsonb_build_object('ok', true, 'status', 'RECEIVED');
end $$;

/* Quien envió puede cancelar mientras no se haya recibido. */
create or replace function public.multi_traspaso_cancelar(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; t public.branch_transfers%rowtype;
begin
  d := public.wx_multi_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  select * into t from public.branch_transfers where id = public.wx_uuid(p->>'id') for update;
  if not found or t.from_location_id <> d.location_id then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if t.status = 'CANCELLED' then return jsonb_build_object('ok', true, 'status', 'CANCELLED'); end if;
  if t.status = 'RECEIVED' then return jsonb_build_object('ok', false, 'code', 'ALREADY_RECEIVED'); end if;
  update public.branch_transfers set status = 'CANCELLED', cancelled_at = now() where id = t.id;
  return jsonb_build_object('ok', true, 'status', 'CANCELLED');
end $$;

-- ============================================================================
--  DUEÑO (app): ver la red de sucursales y cambiar la matriz.
-- ============================================================================
create or replace function public.owner_multi_estado(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_matriz uuid;
begin
  if public.wx_rol(p_company) is null then raise exception 'DENIED' using errcode = '42501'; end if;
  v_matriz := public.wx_matriz(p_company);
  return jsonb_build_object(
    'multisucursal', public.wx_multisucursal(p_company),
    'matriz_id', v_matriz,
    'reglas', (select multi_reglas from public.negocios where id = p_company),
    'version', (select max(version) from public.corporate_catalog_publications where company_id = p_company),
    'publicado_en', (select max(published_at) from public.corporate_catalog_publications where company_id = p_company),
    'sucursales', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'nombre', s.nombre, 'es_matriz', s.id = v_matriz) order by s.created_at, s.id)
                              from public.sucursales s where s.negocio_id = p_company and s.tipo = 'BRANCH' and s.status in ('ACTIVE', 'PENDING')), '[]'),
    'traspasos', coalesce((select jsonb_agg(x order by x->>'sent_at' desc) from (
        select jsonb_build_object('id', t.id, 'de', f.nombre, 'a', d.nombre, 'status', t.status, 'sent_at', t.sent_at,
                                  'lineas', jsonb_array_length(t.lines)) x
          from public.branch_transfers t join public.sucursales f on f.id = t.from_location_id join public.sucursales d on d.id = t.to_location_id
         where t.company_id = p_company order by t.sent_at desc limit 30) q), '[]'));
end $$;

create or replace function public.owner_multi_fijar_matriz(p_company uuid, p_location uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wx_actor_admin(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company));
begin
  if a is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if not exists (select 1 from public.sucursales where id = p_location and negocio_id = p_company and tipo = 'BRANCH' and status in ('ACTIVE', 'PENDING')) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  update public.negocios set matriz_location_id = p_location where id = p_company;
  perform public.wx_audit('USER', auth.uid()::text, p_company, 'MULTI_SET_MATRIZ', 'OK', jsonb_build_object('location_id', p_location));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wx_multisucursal(uuid), public.wx_matriz(uuid), public.wx_multi_equipo(jsonb),
  public.multi_estado(jsonb), public.multi_publicar(jsonb), public.multi_recibir(jsonb), public.multi_excepciones(jsonb),
  public.multi_excepciones_listar(jsonb), public.multi_traspaso_enviar(jsonb), public.multi_traspaso_bandeja(jsonb),
  public.multi_traspaso_recibir(jsonb), public.multi_traspaso_cancelar(jsonb),
  public.owner_multi_estado(uuid), public.owner_multi_fijar_matriz(uuid, uuid) from public, anon, authenticated;
grant execute on function public.multi_estado(jsonb), public.multi_publicar(jsonb), public.multi_recibir(jsonb), public.multi_excepciones(jsonb),
  public.multi_excepciones_listar(jsonb), public.multi_traspaso_enviar(jsonb), public.multi_traspaso_bandeja(jsonb),
  public.multi_traspaso_recibir(jsonb), public.multi_traspaso_cancelar(jsonb) to service_role;
grant execute on function public.owner_multi_estado(uuid), public.owner_multi_fijar_matriz(uuid, uuid) to authenticated;

commit;
