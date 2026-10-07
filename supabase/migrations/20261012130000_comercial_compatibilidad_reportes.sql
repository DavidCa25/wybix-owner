-- Snapshot comercial exige un cliente que conozca el contrato; resumen por canal con membresía.
create or replace function public.mobile_snapshot(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices%rowtype; s public.sucursales%rowtype; n public.negocios%rowtype; v_cat public.catalog_publications%rowtype; r public.registers%rowtype;
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
                   from public.app_releases a where a.app = 'pos-mobile' and a.channel = coalesce(p->>'channel', 'production')));
end $$;
revoke all on function public.mobile_snapshot(jsonb) from public,anon,authenticated;
grant execute on function public.mobile_snapshot(jsonb) to service_role;

create or replace function public.commercial_sales_summary(p_location uuid,p_date date default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare day date;result jsonb;
begin
 if not public.wx_puede_ubicacion(p_location) then raise exception 'Sin acceso a esta ubicación' using errcode='42501';end if;
 select coalesce(p_date,(now() at time zone s.timezone)::date) into day from public.sucursales s where s.id=p_location;
 select coalesce(jsonb_agg(to_jsonb(t) order by t.channel),'[]') into result from (
  select coalesce(f.commercial_snapshot->>'channel','LOCAL') channel,
    max(coalesce(f.commercial_snapshot->>'channelName','Mostrador')) name,
    count(*) tickets,
    sum(coalesce((f.commercial_snapshot->>'gross')::numeric,f.total)) gross,
    sum(coalesce((f.commercial_snapshot->>'discount')::numeric,0)) discount,
    sum(f.total) total,sum(f.refunded_total) refunds,sum(f.total-f.refunded_total) net
  from public.sales_facts f where f.location_id=p_location and f.business_date=day group by coalesce(f.commercial_snapshot->>'channel','LOCAL')
 ) t;
 return jsonb_build_object('date',day,'channels',result);
end $$;
revoke all on function public.commercial_sales_summary(uuid,date) from public,anon;
grant execute on function public.commercial_sales_summary(uuid,date) to authenticated;
