-- ============================================================================
--  MENÚ EN LÍNEA · pedidos para recoger (POS 0067)
-- ----------------------------------------------------------------------------
--  El cliente escanea un QR y abre wybixpos.com.mx/m/<slug> (wybix-landing).
--  Esa página habla SOLO con la función pública `menu-publico`, que llama a las
--  funciones de aquí. La caja principal de la sucursal habla por `pos-sync`:
--
--    menu_publicar   el menú (catálogo, precios, modificadores, disponibilidad,
--                    marca, dirección corta). Devuelve qué fotos faltan.
--    menu_imagen     una foto (≤ 64 KB, la misma miniatura de la caja).
--    menu_bandeja    latido + estados que cambiaron + confirmación de lo que
--                    ya guardó; devuelve los pedidos nuevos. UNA llamada.
--
--  Lo público (anónimo, a través de la función):
--    menu_publico        el menú de un slug y si hoy recibe pedidos.
--    menu_pedido_crear   un pedido. El precio y la disponibilidad se recalculan
--                        AQUÍ con el catálogo publicado: lo que mande el
--                        celular solo dice qué quiere, nunca cuánto cuesta.
--    menu_pedido_estado  el estado de UN pedido por su token (128 bits).
--
--  REGLAS
--    · Un pedido aquí es una solicitud. No cobra ni descuenta: la caja lo
--      acepta o lo rechaza (POS sp_pedido_en_linea_aceptar).
--    · Sin latido de la caja en 2 minutos no se reciben pedidos: una caja sin
--      internet no acumula pedidos que nadie va a ver. Un pedido que la caja
--      no bajó en 30 minutos ya no se le entrega y el cliente ve
--      SIN_RESPUESTA.
--    · Anti-abuso: por IP (hash, nunca la IP), por teléfono y por sucursal;
--      tamaño del pedido acotado; idempotencia por `idem` (doble toque).
--    · Nada de esto es legible con anon/authenticated: solo service_role.
-- ============================================================================
begin;

create table if not exists public.menu_publicaciones (
  location_id uuid primary key references public.sucursales(id) on delete cascade,
  company_id uuid not null references public.negocios(id) on delete cascade,
  slug text unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  activo boolean not null default false,
  recibe_pedidos boolean not null default true,
  minutos_estimados int not null default 15 check (minutos_estimados between 1 and 240),
  mensaje text,
  negocio text,
  marca jsonb,
  catalogo jsonb,
  latido_en timestamptz,
  publicado_en timestamptz not null default now()
);

create table if not exists public.menu_imagenes (
  location_id uuid not null references public.sucursales(id) on delete cascade,
  product_id int not null,
  version int not null,
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  data bytea not null check (octet_length(data) <= 65536),
  subida_en timestamptz not null default now(),
  primary key (location_id, product_id)
);

create table if not exists public.menu_pedidos (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.sucursales(id) on delete cascade,
  company_id uuid not null references public.negocios(id) on delete cascade,
  token text not null unique check (token ~ '^[0-9a-f]{32}$'),
  idem uuid,
  origen text check (origen in ('MOSTRADOR', 'MESA', 'REDES')),
  cliente_nombre text not null,
  cliente_telefono text not null,
  nota text,
  lineas jsonb not null,
  total numeric(12, 2) not null,
  ip_hash text,
  estado text not null default 'RECIBIDO'
    check (estado in ('RECIBIDO', 'ACEPTADO', 'PREPARANDO', 'LISTO', 'ENTREGADO', 'RECHAZADO', 'CANCELADO')),
  numero_dia int,
  motivo text,
  creado_en timestamptz not null default now(),
  bajado_en timestamptz,
  confirmado_en timestamptz,
  estado_en timestamptz
);
create unique index if not exists ux_menu_pedidos_idem on public.menu_pedidos (location_id, idem) where idem is not null;
create index if not exists ix_menu_pedidos_bandeja on public.menu_pedidos (location_id, creado_en) where confirmado_en is null;
create index if not exists ix_menu_pedidos_ip on public.menu_pedidos (ip_hash, creado_en);
create index if not exists ix_menu_pedidos_tel on public.menu_pedidos (location_id, cliente_telefono, creado_en);

alter table public.menu_publicaciones enable row level security;
alter table public.menu_imagenes enable row level security;
alter table public.menu_pedidos enable row level security;
revoke all on public.menu_publicaciones, public.menu_imagenes, public.menu_pedidos from public, anon, authenticated;

-- ---------------------------------------------------------------- la caja
create or replace function public.wx_menu_caja(p jsonb)
returns public.devices language sql stable security definer set search_path = public as $$
  select d.* from public.devices d
   where d.id = public.wx_uuid(p->>'device_id') and d.status = 'ACTIVE' and d.kind = 'POS_PRIMARY'
$$;

/* ¿La página puede pedir ahora? */
create or replace function public.wx_menu_abierto(m public.menu_publicaciones)
returns boolean language sql stable set search_path = public as $$
  select m.activo and m.recibe_pedidos and m.latido_en is not null and m.latido_en > now() - interval '2 minutes'
$$;

create or replace function public.menu_publicar(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; v_slug text := nullif(lower(trim(p->>'slug')), ''); v_cat jsonb := p->'catalogo'; v_otro uuid;
begin
  d := public.wx_menu_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  if v_slug is not null and v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  if coalesce((p->>'activo')::boolean, false) and (v_slug is null or coalesce(jsonb_typeof(v_cat), '') <> 'object') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  if v_cat is not null and jsonb_typeof(v_cat) = 'object'
     and (jsonb_array_length(coalesce(v_cat->'productos', '[]')) > 1500 or pg_column_size(v_cat) > 2000000) then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  select location_id into v_otro from public.menu_publicaciones where slug = v_slug and location_id <> d.location_id;
  if v_otro is not null then return jsonb_build_object('ok', false, 'code', 'SLUG_TAKEN'); end if;

  insert into public.menu_publicaciones as m (location_id, company_id, slug, activo, recibe_pedidos, minutos_estimados, mensaje, negocio, marca, catalogo, latido_en, publicado_en)
  values (d.location_id, d.company_id, v_slug, coalesce((p->>'activo')::boolean, false), coalesce((p->>'recibe_pedidos')::boolean, true),
          least(240, greatest(1, coalesce((p->>'minutos_estimados')::int, 15))), left(p->>'mensaje', 200), left(p->>'negocio', 120),
          case when jsonb_typeof(p->'marca') = 'object' then p->'marca' end,
          case when jsonb_typeof(v_cat) = 'object' then v_cat end, now(), now())
  on conflict (location_id) do update set
    slug = excluded.slug, activo = excluded.activo, recibe_pedidos = excluded.recibe_pedidos,
    minutos_estimados = excluded.minutos_estimados, mensaje = excluded.mensaje, negocio = excluded.negocio,
    marca = excluded.marca, catalogo = coalesce(excluded.catalogo, m.catalogo), latido_en = now(), publicado_en = now();

  return jsonb_build_object('ok', true, 'url', case when v_slug is not null then '/m/' || v_slug end,
    'faltan_imagenes', coalesce((
      select jsonb_agg((x->>'id')::int)
        from jsonb_array_elements(coalesce(v_cat->'productos', '[]')) x
       where x->>'imagen' is not null
         and not exists (select 1 from public.menu_imagenes i
                          where i.location_id = d.location_id and i.product_id = (x->>'id')::int and i.version = (x->>'imagen')::int)), '[]'));
end $$;

create or replace function public.menu_imagen(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; v_data bytea; v_id int := (p->>'product_id')::int; v_ver int := (p->>'version')::int;
begin
  d := public.wx_menu_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  if v_id is null or v_ver is null or coalesce(p->>'mime', '') not in ('image/jpeg', 'image/png', 'image/webp')
     or length(coalesce(p->>'data', '')) > 90000 then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  begin v_data := decode(p->>'data', 'base64');
  exception when others then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end;
  if octet_length(v_data) > 65536 or octet_length(v_data) = 0 then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  insert into public.menu_imagenes (location_id, product_id, version, mime, data)
  values (d.location_id, v_id, v_ver, p->>'mime', v_data)
  on conflict (location_id, product_id) do update set version = excluded.version, mime = excluded.mime, data = excluded.data, subida_en = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.menu_bandeja(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; e jsonb; v_aplicados jsonb := '[]'; v_id uuid; v_m public.menu_publicaciones; v_pedidos jsonb;
begin
  d := public.wx_menu_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  update public.menu_publicaciones set latido_en = now() where location_id = d.location_id returning * into v_m;

  for e in select * from jsonb_array_elements(case when jsonb_typeof(p->'estados') = 'array' then p->'estados' else '[]' end) limit 200 loop
    v_id := public.wx_uuid(e->>'id');
    if e->>'estado' in ('RECIBIDO', 'ACEPTADO', 'PREPARANDO', 'LISTO', 'ENTREGADO', 'RECHAZADO', 'CANCELADO') then
      update public.menu_pedidos
         set estado = e->>'estado', numero_dia = coalesce((e->>'numero_dia')::int, numero_dia),
             motivo = case when e->>'estado' = 'RECHAZADO' then left(e->>'motivo', 200) else motivo end,
             estado_en = now(), confirmado_en = coalesce(confirmado_en, now())
       where id = v_id and location_id = d.location_id;
      if found then v_aplicados := v_aplicados || to_jsonb(v_id::text); end if;
    end if;
  end loop;

  update public.menu_pedidos set confirmado_en = now()
   where location_id = d.location_id and confirmado_en is null
     and id in (select public.wx_uuid(x) from jsonb_array_elements_text(case when jsonb_typeof(p->'confirmar') = 'array' then p->'confirmar' else '[]' end) x);

  /* Lo que la caja aún no confirma se le reenvía (guardarlo dos veces no
     duplica: el POS es idempotente por uuid). Lo de más de 30 min, ya no. */
  with nuevos as (
    update public.menu_pedidos set bajado_en = coalesce(bajado_en, now())
     where id in (select id from public.menu_pedidos
                   where location_id = d.location_id and confirmado_en is null and estado = 'RECIBIDO'
                     and creado_en > now() - interval '30 minutes'
                   order by creado_en limit 50)
    returning *)
  select jsonb_agg(jsonb_build_object('id', n.id, 'origen', n.origen, 'cliente_nombre', n.cliente_nombre,
           'cliente_telefono', n.cliente_telefono, 'nota', n.nota, 'lineas', n.lineas, 'total', n.total, 'creado_en', n.creado_en)
         order by n.creado_en)
    into v_pedidos from nuevos n;

  return jsonb_build_object('ok', true, 'abierto', coalesce(public.wx_menu_abierto(v_m), false), 'estados_aplicados', v_aplicados,
    'pedidos', coalesce(v_pedidos, '[]'));
end $$;

-- ---------------------------------------------------------------- lo público
create or replace function public.menu_publico(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare m public.menu_publicaciones;
begin
  select * into m from public.menu_publicaciones where slug = lower(p->>'slug') and activo and catalogo is not null;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'negocio', m.negocio, 'marca', m.marca, 'catalogo', m.catalogo,
    'abierto', public.wx_menu_abierto(m), 'recibe_pedidos', m.recibe_pedidos, 'minutos_estimados', m.minutos_estimados,
    'mensaje', m.mensaje, 'version', extract(epoch from m.publicado_en)::bigint);
end $$;

create or replace function public.menu_imagen_publica(p jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_build_object('ok', true, 'mime', i.mime, 'version', i.version, 'data', replace(encode(i.data, 'base64'), E'\n', ''))
      from public.menu_publicaciones m
      join public.menu_imagenes i on i.location_id = m.location_id and i.product_id = (p->>'product_id')::int
     where m.slug = lower(p->>'slug') and m.activo), jsonb_build_object('ok', false, 'code', 'NOT_FOUND'))
$$;

/* El estado que ve el cliente. SIN_RESPUESTA: la caja nunca lo bajó. */
create or replace function public.wx_menu_estado_cliente(x public.menu_pedidos)
returns text language sql stable as $$
  select case when x.estado = 'RECIBIDO' and x.confirmado_en is null and x.creado_en < now() - interval '30 minutes'
              then 'SIN_RESPUESTA' else x.estado end
$$;

create or replace function public.menu_pedido_crear(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.menu_publicaciones; v_nombre text := btrim(regexp_replace(coalesce(p->>'cliente_nombre', ''), '\s+', ' ', 'g'));
  v_tel text := regexp_replace(coalesce(p->>'cliente_telefono', ''), '\D', '', 'g');
  v_idem uuid := public.wx_uuid(p->>'idem'); v_ip text := left(p->>'ip_hash', 64);
  l jsonb; prod jsonb; g jsonb; v_ops jsonb; v_lineas jsonb := '[]'; v_total numeric(12, 2) := 0; v_cant int; v_unit numeric(12, 2);
  v_sel int; v_op jsonb; v_opsal jsonb; v_ya public.menu_pedidos; v_token text; v_id uuid; v_n int := 0;
begin
  select * into m from public.menu_publicaciones where slug = lower(p->>'slug') and activo and catalogo is not null;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;

  /* Doble toque: el mismo idem devuelve el mismo pedido. */
  if v_idem is not null then
    select * into v_ya from public.menu_pedidos where location_id = m.location_id and idem = v_idem;
    if found then return jsonb_build_object('ok', true, 'token', v_ya.token, 'repetido', true); end if;
  end if;
  if not public.wx_menu_abierto(m) then return jsonb_build_object('ok', false, 'code', 'CLOSED'); end if;

  if length(v_nombre) < 2 or length(v_nombre) > 60 then return jsonb_build_object('ok', false, 'code', 'BAD_NAME'); end if;
  if length(v_tel) < 10 or length(v_tel) > 13 then return jsonb_build_object('ok', false, 'code', 'BAD_PHONE'); end if;
  if jsonb_typeof(p->'lineas') <> 'array' or jsonb_array_length(p->'lineas') = 0 or jsonb_array_length(p->'lineas') > 30 then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;

  /* El precio sale del catálogo publicado, nunca del celular. */
  for l in select * from jsonb_array_elements(p->'lineas') loop
    v_n := v_n + 1;
    prod := null;
    select x into prod from jsonb_array_elements(m.catalogo->'productos') x where (x->>'id')::int = (l->>'product_id')::int;
    if prod is null then return jsonb_build_object('ok', false, 'code', 'UNAVAILABLE', 'linea', v_n); end if;
    v_cant := case when (l->>'cantidad') ~ '^[0-9]{1,2}$' then (l->>'cantidad')::int else 0 end;
    if v_cant < 1 or v_cant > 20 then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'linea', v_n); end if;
    if prod->>'disponible' is not null and (prod->>'disponible')::int < v_cant then
      return jsonb_build_object('ok', false, 'code', 'UNAVAILABLE', 'linea', v_n);
    end if;
    v_ops := case when jsonb_typeof(l->'opciones') = 'array' then l->'opciones' else '[]' end;
    if jsonb_array_length(v_ops) > 20 then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'linea', v_n); end if;
    v_unit := (prod->>'precio')::numeric;
    v_opsal := '[]';
    /* Cada grupo del producto: entre su mínimo y su máximo, como en la caja. */
    for g in select x from jsonb_array_elements(m.catalogo->'grupos') x
              where (x->>'id')::int in (select (y #>> '{}')::int from jsonb_array_elements(coalesce(prod->'grupos', '[]')) y) loop
      select count(*) into v_sel from jsonb_array_elements(v_ops) o
       where (o #>> '{}') ~ '^[0-9]{1,9}$' and exists (select 1 from jsonb_array_elements(g->'opciones') go where (go->>'id')::int = (o #>> '{}')::int);
      if v_sel < greatest(coalesce((g->>'min')::int, 0), case when (g->>'requerido')::boolean then 1 else 0 end)
         or v_sel > greatest(coalesce((g->>'max')::int, 1), 1) then
        return jsonb_build_object('ok', false, 'code', 'BAD_OPTIONS', 'linea', v_n, 'grupo', g->>'nombre');
      end if;
    end loop;
    for v_op in
      select go || jsonb_build_object('grupo', g2->>'nombre')
        from jsonb_array_elements(v_ops) o
        join lateral (select x from jsonb_array_elements(m.catalogo->'grupos') x
                       where (x->>'id')::int in (select (y #>> '{}')::int from jsonb_array_elements(coalesce(prod->'grupos', '[]')) y)) gg(g2) on true
        join lateral jsonb_array_elements(g2->'opciones') go on (o #>> '{}') ~ '^[0-9]{1,9}$' and (go->>'id')::int = (o #>> '{}')::int
    loop
      if v_op->>'disponible' is not null and (v_op->>'disponible')::int < 1 then
        return jsonb_build_object('ok', false, 'code', 'UNAVAILABLE', 'linea', v_n);
      end if;
      v_unit := v_unit + coalesce((v_op->>'delta')::numeric, 0);
      v_opsal := v_opsal || jsonb_build_object('option_id', (v_op->>'id')::int, 'nombre', v_op->>'nombre', 'grupo', v_op->>'grupo',
                                               'quantity', 1, 'price_delta', coalesce((v_op->>'delta')::numeric, 0));
    end loop;
    /* Una opción que no es de este producto no se cuela. */
    if jsonb_array_length(v_opsal) <> jsonb_array_length(v_ops) then
      return jsonb_build_object('ok', false, 'code', 'BAD_OPTIONS', 'linea', v_n);
    end if;
    v_total := v_total + v_unit * v_cant;
    v_lineas := v_lineas || jsonb_build_object('uuid', gen_random_uuid(), 'product_id', (prod->>'id')::int, 'nombre', prod->>'nombre',
      'cantidad', v_cant, 'precio', (prod->>'precio')::numeric, 'nota', nullif(left(btrim(coalesce(l->>'nota', '')), 120), ''), 'opciones', v_opsal);
  end loop;

  /* Anti-abuso, ya con el pedido validado (lo mal formado no cuenta). La IP
     es floja a propósito (20 en 10 min): los clientes en el Wi-Fi del local o
     detrás de la misma red móvil comparten IP. Frenan el teléfono y la sucursal. La IP llega ya con hash (la función nunca guarda la IP). */
  if v_ip is not null and (select count(*) from public.menu_pedidos where ip_hash = v_ip and creado_en > now() - interval '10 minutes') >= 20 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMIT');
  end if;
  if (select count(*) from public.menu_pedidos where location_id = m.location_id and cliente_telefono = v_tel
        and estado = 'RECIBIDO' and creado_en > now() - interval '30 minutes') >= 2 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMIT');
  end if;
  if (select count(*) from public.menu_pedidos where location_id = m.location_id and estado = 'RECIBIDO'
        and creado_en > now() - interval '30 minutes') >= 40 then
    return jsonb_build_object('ok', false, 'code', 'BUSY');
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '');
  insert into public.menu_pedidos (location_id, company_id, token, idem, origen, cliente_nombre, cliente_telefono, nota, lineas, total, ip_hash)
  values (m.location_id, m.company_id, v_token, v_idem,
          case when upper(p->>'origen') in ('MOSTRADOR', 'MESA', 'REDES') then upper(p->>'origen') end,
          v_nombre, v_tel, nullif(left(btrim(coalesce(p->>'nota', '')), 200), ''), v_lineas, v_total, v_ip)
  on conflict (location_id, idem) where idem is not null do nothing
  returning id into v_id;
  if v_id is null then
    select token into v_token from public.menu_pedidos where location_id = m.location_id and idem = v_idem;
    return jsonb_build_object('ok', true, 'token', v_token, 'repetido', true);
  end if;
  return jsonb_build_object('ok', true, 'token', v_token, 'total', v_total);
end $$;

create or replace function public.menu_pedido_estado(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare x public.menu_pedidos; m public.menu_publicaciones;
begin
  if coalesce(p->>'token', '') !~ '^[0-9a-f]{32}$' then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  select * into x from public.menu_pedidos where token = p->>'token' and creado_en > now() - interval '2 days';
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  select * into m from public.menu_publicaciones where location_id = x.location_id;
  /* Solo lo de este pedido: su número, su estado, lo que pidió. Nunca el
     teléfono ni datos de otros pedidos. */
  return jsonb_build_object('ok', true, 'estado', public.wx_menu_estado_cliente(x), 'numero', x.numero_dia, 'motivo', x.motivo,
    'nombre', split_part(x.cliente_nombre, ' ', 1), 'total', x.total, 'creado_en', x.creado_en,
    'negocio', m.negocio, 'slug', m.slug, 'marca', m.marca, 'minutos_estimados', m.minutos_estimados,
    'lineas', (select jsonb_agg(jsonb_build_object('nombre', l->>'nombre', 'cantidad', (l->>'cantidad')::int,
                 'opciones', (select jsonb_agg(o->>'nombre') from jsonb_array_elements(l->'opciones') o)))
                 from jsonb_array_elements(x.lineas) l));
end $$;

revoke all on function public.wx_menu_caja(jsonb), public.wx_menu_abierto(public.menu_publicaciones),
  public.wx_menu_estado_cliente(public.menu_pedidos),
  public.menu_publicar(jsonb), public.menu_imagen(jsonb), public.menu_bandeja(jsonb),
  public.menu_publico(jsonb), public.menu_imagen_publica(jsonb), public.menu_pedido_crear(jsonb), public.menu_pedido_estado(jsonb)
  from public, anon, authenticated;
grant execute on function public.wx_menu_caja(jsonb), public.wx_menu_abierto(public.menu_publicaciones),
  public.wx_menu_estado_cliente(public.menu_pedidos),
  public.menu_publicar(jsonb), public.menu_imagen(jsonb), public.menu_bandeja(jsonb),
  public.menu_publico(jsonb), public.menu_imagen_publica(jsonb), public.menu_pedido_crear(jsonb), public.menu_pedido_estado(jsonb)
  to service_role;

commit;
