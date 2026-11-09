-- ============================================================================
--  GRUPOS DE EMPRESAS (POS 0080 · MultiEmpresa, Fases 2 y 3)
-- ----------------------------------------------------------------------------
--  Un dueño con varias empresas (I Do Nut y Birrialtlan) las junta en un
--  GRUPO. La caja principal de una empresa del grupo puede:
--
--    · consultar a las demás con lo que sus cajas ya suben (hechos de venta,
--      turnos, movimientos de efectivo y catálogo publicado);
--    · pedirles cambios (alta de producto, cambio de precio) que quedan en una
--      BANDEJA hasta que la caja principal de destino los aplica y responde.
--
--  Nada se escribe en la base de otra empresa desde aquí: la nube solo
--  transporta el pedido. La empresa de destino lo aplica con sus reglas y lo
--  deja en su bitácora (dbo.empresas_comandos en el POS).
--
--  ENLACE: la caja principal de Birrialtlan genera un código (30 min, un uso);
--  la de I Do Nut lo escribe. Mismo modelo que unir una sucursal.
--
--  Solo cajas principales (POS_PRIMARY activas) y solo por pos-sync con su
--  credencial. Nadie más ve estas tablas ni ejecuta estas funciones.
--
--  Idempotente: se puede aplicar dos veces.
-- ============================================================================

create table if not exists public.company_groups (
  id uuid primary key default gen_random_uuid(),
  created_by_company uuid references public.negocios(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Una empresa pertenece a lo más a UN grupo.
create table if not exists public.company_group_members (
  company_id uuid primary key references public.negocios(id) on delete cascade,
  group_id uuid not null references public.company_groups(id) on delete cascade,
  joined_by_device uuid,
  joined_at timestamptz not null default now()
);
create index if not exists ix_company_group_members_group on public.company_group_members (group_id);

create table if not exists public.company_group_codes (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.company_groups(id) on delete cascade,
  company_id uuid not null references public.negocios(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_company uuid references public.negocios(id) on delete set null,
  created_by_device uuid,
  created_at timestamptz not null default now()
);

/*
 * La bandeja. Entrega "al menos una vez": un pedido ENTREGADO que no recibe
 * respuesta en 10 minutos se vuelve a entregar. El POS lo aplica una sola vez
 * (dbo.empresas_comandos.comando_id es único) y responde lo mismo.
 */
create table if not exists public.company_group_commands (
  id uuid primary key default gen_random_uuid(),
  client_key uuid not null unique,          -- la caja que pide reintenta con la misma clave
  group_id uuid not null references public.company_groups(id) on delete cascade,
  from_company uuid not null references public.negocios(id) on delete cascade,
  to_company uuid not null references public.negocios(id) on delete cascade,
  kind text not null check (kind in ('PRODUCTO_ALTA', 'PRODUCTO_PRECIO')),
  payload jsonb not null,
  requested_by text,
  status text not null default 'PENDIENTE' check (status in ('PENDIENTE', 'ENTREGADO', 'APLICADO', 'RECHAZADO')),
  detail text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  resolved_at timestamptz,
  check (from_company <> to_company)
);
create index if not exists ix_company_group_commands_to on public.company_group_commands (to_company, status);
create index if not exists ix_company_group_commands_from on public.company_group_commands (from_company, created_at desc);

revoke all on public.company_groups, public.company_group_members, public.company_group_codes, public.company_group_commands
  from public, anon, authenticated;

-- ============================================================================
--  INTERNAS
-- ============================================================================

/* La caja principal activa que llama (la credencial ya la validó pos-sync). */
create or replace function public.wx_grupo_caja(p jsonb)
returns public.devices language sql stable security definer set search_path = public as $$
  select d.* from public.devices d
   where d.id = public.wx_uuid(p->>'device_id') and d.status = 'ACTIVE' and d.kind = 'POS_PRIMARY';
$$;

create or replace function public.wx_grupo_de(p_company uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select group_id from public.company_group_members where company_id = p_company;
$$;

/* ¿Las dos empresas están en el mismo grupo (y son distintas)? */
create or replace function public.wx_mismo_grupo(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_a is distinct from p_b and exists (
    select 1 from public.company_group_members a join public.company_group_members b on b.group_id = a.group_id
     where a.company_id = p_a and b.company_id = p_b);
$$;

-- ============================================================================
--  ENLACE
-- ============================================================================

/* La caja principal genera un código para que otra empresa se una a su grupo. */
create or replace function public.grupo_codigo(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; v_grupo uuid; v_code text := public.wx_codigo_nuevo(); v_hasta timestamptz := now() + interval '30 minutes';
begin
  d := public.wx_grupo_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  v_grupo := public.wx_grupo_de(d.company_id);
  if v_grupo is null then
    insert into public.company_groups (created_by_company) values (d.company_id) returning id into v_grupo;
    insert into public.company_group_members (company_id, group_id, joined_by_device) values (d.company_id, v_grupo, d.id);
  end if;
  insert into public.company_group_codes (group_id, company_id, code_hash, expires_at, created_by_device)
  values (v_grupo, d.company_id, public.wx_codigo_hash(v_code), v_hasta, d.id);
  perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'GROUP_CODE', 'OK', jsonb_build_object('group_id', v_grupo));
  return jsonb_build_object('ok', true, 'code', v_code, 'expires_at', v_hasta);
end $$;

/*
 * La caja principal de otra empresa escribe el código y su empresa entra al
 * grupo. Una empresa que ya está en OTRO grupo con más empresas no se mueve
 * sola: primero sale de ese (grupo_salir). Si estaba sola en su grupo, se
 * cambia (un grupo de uno es un grupo que nadie usa).
 */
create or replace function public.grupo_unir(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; c public.company_group_codes%rowtype; v_mio uuid;
begin
  d := public.wx_grupo_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  select * into c from public.company_group_codes
   where code_hash = public.wx_codigo_hash(p->>'code') and used_at is null and expires_at > now()
   for update;
  if not found then
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'GROUP_JOIN', 'BAD_CODE', '{}');
    return jsonb_build_object('ok', false, 'code', 'BAD_CODE');
  end if;
  if c.company_id = d.company_id then return jsonb_build_object('ok', false, 'code', 'SAME_COMPANY'); end if;

  v_mio := public.wx_grupo_de(d.company_id);
  if v_mio = c.group_id then
    update public.company_group_codes set used_at = now(), used_by_company = d.company_id where id = c.id;
    return jsonb_build_object('ok', true, 'group_id', c.group_id, 'ya_estaba', true);
  end if;
  if v_mio is not null then
    if (select count(*) from public.company_group_members where group_id = v_mio) > 1 then
      return jsonb_build_object('ok', false, 'code', 'IN_OTHER_GROUP');
    end if;
    delete from public.company_group_members where company_id = d.company_id;
    delete from public.company_groups where id = v_mio;
  end if;

  insert into public.company_group_members (company_id, group_id, joined_by_device) values (d.company_id, c.group_id, d.id);
  update public.company_group_codes set used_at = now(), used_by_company = d.company_id where id = c.id;
  perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'GROUP_JOIN', 'OK', jsonb_build_object('group_id', c.group_id));
  return jsonb_build_object('ok', true, 'group_id', c.group_id, 'ya_estaba', false);
end $$;

/* La empresa sale de su grupo. Sus pedidos pendientes hacia o desde ella se cancelan. */
create or replace function public.grupo_salir(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; v_grupo uuid;
begin
  d := public.wx_grupo_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  v_grupo := public.wx_grupo_de(d.company_id);
  if v_grupo is null then return jsonb_build_object('ok', true, 'estaba', false); end if;
  update public.company_group_commands set status = 'RECHAZADO', detail = 'La empresa salió del grupo.', resolved_at = now()
   where group_id = v_grupo and status in ('PENDIENTE', 'ENTREGADO') and (from_company = d.company_id or to_company = d.company_id);
  delete from public.company_group_members where company_id = d.company_id;
  delete from public.company_groups g where g.id = v_grupo and not exists (select 1 from public.company_group_members m where m.group_id = g.id);
  perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'GROUP_LEAVE', 'OK', jsonb_build_object('group_id', v_grupo));
  return jsonb_build_object('ok', true, 'estaba', true);
end $$;

-- ============================================================================
--  CONSULTA (Fase 2)
-- ============================================================================

/* Las OTRAS empresas del grupo, con sus ubicaciones y cuándo sincronizó su caja principal. */
create or replace function public.grupo_listar(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices; v_grupo uuid;
begin
  d := public.wx_grupo_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  v_grupo := public.wx_grupo_de(d.company_id);
  if v_grupo is null then return jsonb_build_object('ok', true, 'grupo', null, 'empresas', '[]'::jsonb); end if;
  return jsonb_build_object('ok', true, 'grupo', v_grupo, 'empresas', coalesce((
    select jsonb_agg(jsonb_build_object(
             'company_id', n.id, 'nombre', n.nombre,
             'ubicaciones', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'nombre', s.nombre, 'instance_uuid', s.instance_uuid) order by s.nombre), '[]')
                               from public.sucursales s where s.negocio_id = n.id and s.tipo = 'BRANCH' and s.status <> 'ARCHIVED'),
             'ultima_sync', (select max(x.last_sync_at) from public.devices x
                              where x.company_id = n.id and x.kind = 'POS_PRIMARY' and x.status = 'ACTIVE'))
           order by n.nombre)
      from public.company_group_members m join public.negocios n on n.id = m.company_id
     where m.group_id = v_grupo and m.company_id <> d.company_id), '[]'::jsonb));
end $$;

/*
 * Lo de otra empresa del grupo en un periodo, con sus hechos: ventas netas,
 * tickets, turnos abiertos y el efectivo que deberían tener sus cajones. La
 * utilidad no viaja (los hechos no llevan costo): la ve el dueño dentro de
 * esa empresa.
 */
create or replace function public.grupo_resumen(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices; v_otra uuid := public.wx_uuid(p->>'company_id');
        v_desde date := coalesce(nullif(p->>'desde', '')::date, current_date);
        v_hasta date := coalesce(nullif(p->>'hasta', '')::date, nullif(p->>'desde', '')::date, current_date);
        v_ventas numeric; v_tickets int; v_turnos int; v_efectivo numeric; v_ultima timestamptz; v_sync timestamptz;
begin
  d := public.wx_grupo_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  if not public.wx_mismo_grupo(d.company_id, v_otra) then return jsonb_build_object('ok', false, 'code', 'NOT_IN_GROUP'); end if;
  if v_hasta < v_desde then v_hasta := v_desde; end if;

  select coalesce(sum(total - refunded_total), 0), count(*) into v_ventas, v_tickets
    from public.sales_facts where company_id = v_otra and business_date between v_desde and v_hasta;
  select max(occurred_at) into v_ultima from public.sales_facts where company_id = v_otra;
  select count(*), coalesce(sum(f.opening_cash), 0)
         + coalesce((select sum(m.amount) from public.cash_movement_facts m
                      where m.shift_uuid in (select shift_uuid from public.shift_facts where company_id = v_otra and status = 'OPEN')
                        and coalesce(m.type, '') <> 'OPENING'), 0)
    into v_turnos, v_efectivo
    from public.shift_facts f where f.company_id = v_otra and f.status = 'OPEN';
  select max(last_sync_at) into v_sync from public.devices where company_id = v_otra and kind = 'POS_PRIMARY' and status = 'ACTIVE';

  return jsonb_build_object('ok', true, 'company_id', v_otra, 'desde', v_desde, 'hasta', v_hasta,
    'ventas', v_ventas, 'tickets', v_tickets, 'turnos_abiertos', v_turnos, 'efectivo_en_caja', v_efectivo,
    'ultima_venta', v_ultima, 'ultima_sync', v_sync);
end $$;

/* El catálogo que publicó la caja principal de otra empresa del grupo (lo vendible). */
create or replace function public.grupo_catalogo(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices; v_otra uuid := public.wx_uuid(p->>'company_id'); c public.catalog_publications%rowtype;
begin
  d := public.wx_grupo_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  if not public.wx_mismo_grupo(d.company_id, v_otra) then return jsonb_build_object('ok', false, 'code', 'NOT_IN_GROUP'); end if;
  select cp.* into c from public.catalog_publications cp
    join public.sucursales s on s.id = cp.location_id and s.tipo = 'BRANCH'
   where cp.company_id = v_otra order by cp.published_at desc limit 1;
  if not found then return jsonb_build_object('ok', true, 'version', null, 'productos', '[]'::jsonb); end if;
  return jsonb_build_object('ok', true, 'version', c.version, 'publicado', c.published_at,
    'productos', coalesce((
      select jsonb_agg(jsonb_build_object('uuid', x->>'uuid', 'nombre', x->>'nombre', 'precio', (x->>'price')::numeric,
                                          'categoria_uuid', x->>'category_uuid', 'vendible', (x->>'sellable')::boolean)
                       order by x->>'nombre')
        from jsonb_array_elements(coalesce(c.payload->'products', '[]'::jsonb)) x
       where coalesce((x->>'active')::boolean, true)), '[]'::jsonb),
    'categorias', coalesce(c.payload->'categories', '[]'::jsonb));
end $$;

-- ============================================================================
--  CAMBIOS POR BANDEJA (Fase 3)
-- ============================================================================

/*
 * Pedir un cambio a otra empresa del grupo. Solo lo que se puede deshacer a
 * mano y no mueve dinero: alta de producto y cambio de precio. La validación
 * de fondo la hace la empresa de destino; aquí solo la forma.
 */
create or replace function public.grupo_comando(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; v_otra uuid := public.wx_uuid(p->>'company_id'); v_kind text := upper(coalesce(p->>'kind', ''));
        v_payload jsonb := p->'payload'; v_key uuid := public.wx_uuid(p->>'client_key'); v_id uuid; v_status text;
begin
  d := public.wx_grupo_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  if v_key is null or jsonb_typeof(v_payload) <> 'object' or length(v_payload::text) > 4000 then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  if v_kind = 'PRODUCTO_PRECIO' then
    if public.wx_uuid(v_payload->>'product_uuid') is null or (v_payload->>'precio') is null
       or (v_payload->>'precio')::numeric < 0 then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  elsif v_kind = 'PRODUCTO_ALTA' then
    if length(trim(coalesce(v_payload->>'nombre', ''))) < 2 or (v_payload->>'precio') is null
       or (v_payload->>'precio')::numeric < 0 then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  else
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  if not public.wx_mismo_grupo(d.company_id, v_otra) then return jsonb_build_object('ok', false, 'code', 'NOT_IN_GROUP'); end if;

  select id, status into v_id, v_status from public.company_group_commands where client_key = v_key;
  if v_id is not null then return jsonb_build_object('ok', true, 'id', v_id, 'status', v_status, 'repetido', true); end if;

  insert into public.company_group_commands (client_key, group_id, from_company, to_company, kind, payload, requested_by)
  values (v_key, public.wx_grupo_de(d.company_id), d.company_id, v_otra, v_kind, v_payload, left(p->>'requested_by', 50))
  returning id into v_id;
  perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'GROUP_COMMAND', 'OK', jsonb_build_object('id', v_id, 'to', v_otra, 'kind', v_kind));
  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'PENDIENTE', 'repetido', false);
end $$;

/* Lo que esta empresa pidió a las demás, con su estado (los 50 más recientes). */
create or replace function public.grupo_comandos(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices;
begin
  d := public.wx_grupo_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  return jsonb_build_object('ok', true, 'comandos', coalesce((
    select jsonb_agg(x order by x->>'creado' desc) from (
      select jsonb_build_object('id', c.id, 'empresa', n.nombre, 'company_id', c.to_company, 'kind', c.kind, 'payload', c.payload,
                                'status', c.status, 'detail', c.detail, 'requested_by', c.requested_by,
                                'creado', c.created_at, 'resuelto', c.resolved_at) as x
        from public.company_group_commands c join public.negocios n on n.id = c.to_company
       where c.from_company = d.company_id
       order by c.created_at desc limit 50) t), '[]'::jsonb));
end $$;

/*
 * La caja principal de destino recoge sus pedidos: los PENDIENTES y los
 * ENTREGADOS hace más de 10 minutos sin respuesta (la caja se apagó a medias).
 */
create or replace function public.grupo_bandeja(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; v jsonb;
begin
  d := public.wx_grupo_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  with tomados as (
    update public.company_group_commands c set status = 'ENTREGADO', delivered_at = now()
     where c.to_company = d.company_id
       and (c.status = 'PENDIENTE' or (c.status = 'ENTREGADO' and c.delivered_at < now() - interval '10 minutes'))
       and public.wx_mismo_grupo(c.from_company, c.to_company)
    returning c.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'payload', t.payload, 'requested_by', t.requested_by,
                                               'empresa', n.nombre, 'creado', t.created_at) order by t.created_at), '[]'::jsonb)
    into v
    from tomados t join public.negocios n on n.id = t.from_company;
  return jsonb_build_object('ok', true, 'comandos', v);
end $$;

/* La empresa de destino responde si lo aplicó o por qué no. Solo ella. */
create or replace function public.grupo_comando_resultado(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; v_id uuid := public.wx_uuid(p->>'id'); v_ok boolean := coalesce((p->>'ok')::boolean, false);
begin
  d := public.wx_grupo_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  update public.company_group_commands
     set status = case when v_ok then 'APLICADO' else 'RECHAZADO' end, detail = left(p->>'detail', 400), resolved_at = now()
   where id = v_id and to_company = d.company_id and status in ('PENDIENTE', 'ENTREGADO');
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.wx_grupo_caja(jsonb), public.wx_grupo_de(uuid), public.wx_mismo_grupo(uuid, uuid),
  public.grupo_codigo(jsonb), public.grupo_unir(jsonb), public.grupo_salir(jsonb), public.grupo_listar(jsonb),
  public.grupo_resumen(jsonb), public.grupo_catalogo(jsonb), public.grupo_comando(jsonb), public.grupo_comandos(jsonb),
  public.grupo_bandeja(jsonb), public.grupo_comando_resultado(jsonb)
  from public, anon, authenticated;
grant execute on function public.wx_grupo_caja(jsonb), public.wx_grupo_de(uuid), public.wx_mismo_grupo(uuid, uuid),
  public.grupo_codigo(jsonb), public.grupo_unir(jsonb), public.grupo_salir(jsonb), public.grupo_listar(jsonb),
  public.grupo_resumen(jsonb), public.grupo_catalogo(jsonb), public.grupo_comando(jsonb), public.grupo_comandos(jsonb),
  public.grupo_bandeja(jsonb), public.grupo_comando_resultado(jsonb)
  to service_role;
