-- Reversa de 20261028150000_menu_diseno.sql: quita las fotos grandes y deja
-- menu_publicar como en 20261028130000.
begin;
drop function if exists public.menu_foto(jsonb), public.menu_foto_publica(jsonb);
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
drop table if exists public.menu_fotos;
commit;
