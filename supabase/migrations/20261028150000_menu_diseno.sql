-- ============================================================================
--  MENÚ EN LÍNEA · plantilla (POS 0070)
-- ----------------------------------------------------------------------------
--  Las fotos GRANDES del menú: portada, logo, promos y una por producto
--  (las miniaturas de 192 px de 20261028130000 siguen para lo demás). La caja
--  las guarda en su base y las sube por versión:
--
--    menu_publicar       devuelve también `faltan_fotos` (claves del manifiesto
--                        `catalogo.fotos` que la nube no tiene en esa versión) y
--                        borra las que ya no están en el menú.
--    menu_foto           sube una (≤ 450 KB; jpeg, png o webp).
--    menu_foto_publica   la sirve a la página (por slug y clave).
--
--  Lo demás de la plantilla (descripción, etiquetas, promos, lo más pedido,
--  dirección, horario) viaja dentro de `catalogo`: no cambia ninguna tabla.
--  Solo service_role.
-- ============================================================================
begin;

create table if not exists public.menu_fotos (
  location_id uuid not null references public.sucursales(id) on delete cascade,
  clave text not null check (clave ~ '^(portada|logo|promo-[0-9]{1,9}|producto-[0-9]{1,9})$'),
  version int not null,
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  data bytea not null check (octet_length(data) <= 460800),
  subida_en timestamptz not null default now(),
  primary key (location_id, clave)
);
alter table public.menu_fotos enable row level security;
revoke all on public.menu_fotos from public, anon, authenticated;

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

  /* 0070 · La foto que ya no esta en el menu publicado se borra. */
  if jsonb_typeof(v_cat) = 'object' then
    delete from public.menu_fotos x
     where x.location_id = d.location_id
       and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_cat->'fotos') = 'array' then v_cat->'fotos' else '[]' end) f
                        where f->>'clave' = x.clave);
  end if;

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
                          where i.location_id = d.location_id and i.product_id = (x->>'id')::int and i.version = (x->>'imagen')::int)), '[]'),
    /* 0070 · Las fotos grandes que faltan (o cambiaron de version). */
    'faltan_fotos', coalesce((
      select jsonb_agg(f->>'clave')
        from jsonb_array_elements(case when jsonb_typeof(v_cat->'fotos') = 'array' then v_cat->'fotos' else '[]' end) f
       where (f->>'clave') ~ '^(portada|logo|promo-[0-9]{1,9}|producto-[0-9]{1,9})$'
         and not exists (select 1 from public.menu_fotos x
                          where x.location_id = d.location_id and x.clave = f->>'clave' and x.version = (f->>'v')::int)), '[]'));
end $$;

create or replace function public.menu_foto(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; v_data bytea; v_clave text := p->>'clave'; v_ver int := (p->>'version')::int;
begin
  d := public.wx_menu_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  if coalesce(v_clave, '') !~ '^(portada|logo|promo-[0-9]{1,9}|producto-[0-9]{1,9})$' or v_ver is null
     or coalesce(p->>'mime', '') not in ('image/jpeg', 'image/png', 'image/webp') or length(coalesce(p->>'data', '')) > 620000 then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  begin v_data := decode(p->>'data', 'base64');
  exception when others then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end;
  if octet_length(v_data) = 0 or octet_length(v_data) > 460800 then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  insert into public.menu_fotos (location_id, clave, version, mime, data)
  values (d.location_id, v_clave, v_ver, p->>'mime', v_data)
  on conflict (location_id, clave) do update set version = excluded.version, mime = excluded.mime, data = excluded.data, subida_en = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.menu_foto_publica(p jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_build_object('ok', true, 'mime', f.mime, 'version', f.version, 'data', replace(encode(f.data, 'base64'), E'\n', ''))
      from public.menu_publicaciones m
      join public.menu_fotos f on f.location_id = m.location_id and f.clave = p->>'clave'
     where m.slug = lower(p->>'slug') and m.activo), jsonb_build_object('ok', false, 'code', 'NOT_FOUND'))
$$;

revoke all on function public.menu_foto(jsonb), public.menu_foto_publica(jsonb), public.menu_publicar(jsonb) from public, anon, authenticated;
grant execute on function public.menu_foto(jsonb), public.menu_foto_publica(jsonb), public.menu_publicar(jsonb) to service_role;

commit;
