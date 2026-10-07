-- Fase 3 · conciliación del EVENT: conserva la evidencia y registra ajustes
-- en ESA ubicación. No inventa un retorno ni modifica la sucursal base.
create or replace function public.wx_stock_desglose(p_location uuid) returns jsonb
language sql stable security definer set search_path = public as $$
 select coalesce(jsonb_agg(jsonb_build_object('product_uuid',st.product_uuid,'qty',st.qty,'product_name',
   coalesce((select p->>'nombre' from public.catalog_publications c cross join lateral jsonb_array_elements(c.payload->'products') p
     where c.location_id=s.home_location_id and p->>'uuid'=st.product_uuid::text order by c.version desc limit 1),
     (select product_name from public.stock_transfer_lines where product_uuid=st.product_uuid and transfer_uuid in
       (select transfer_uuid from public.stock_transfers where company_id=s.negocio_id) and product_name is not null limit 1),st.product_uuid::text),
   'causes',(select coalesce(jsonb_agg(jsonb_build_object('type',t.type,'quantity',t.q)), '[]') from
       (select type,sum(quantity) q from public.inventory_ledger where location_id=st.location_id and product_uuid=st.product_uuid group by type) t)
 ) order by st.product_uuid),'[]') from public.location_stock st join public.sucursales s on s.id=st.location_id
 where st.location_id=p_location and st.qty<>0
$$;
revoke all on function public.wx_stock_desglose(uuid) from public;
revoke all on function public.wx_stock_desglose(uuid) from anon, authenticated;
grant execute on function public.wx_stock_desglose(uuid) to service_role;

create or replace function public.evento_cambiar_estado(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a jsonb := public.wx_actor_admin(p); s public.sucursales%rowtype; v_nuevo text := upper(coalesce(p->>'status', ''));
        v_resto jsonb; v_transito int; v_turnos int; r jsonb; ajustes jsonb := '[]'; v_mov uuid;
begin
  if a is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  select * into s from public.sucursales where id = public.wx_uuid(p->>'location_id') and negocio_id = (a->>'company_id')::uuid for update;
  if not found or s.tipo <> 'EVENT' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if not ((s.event_status = 'PLANNED' and v_nuevo = 'OPEN') or (s.event_status = 'OPEN' and v_nuevo = 'CLOSED')
          or (s.event_status = 'CLOSED' and v_nuevo in ('OPEN', 'RECONCILED'))) then
    return jsonb_build_object('ok', false, 'code', 'BAD_TRANSITION', 'from', s.event_status, 'to', v_nuevo);
  end if;
  if v_nuevo = 'RECONCILED' then
    select count(*) into v_turnos from public.shift_facts where location_id = s.id and status = 'OPEN';
    select count(*) into v_transito from public.stock_transfers where (from_location_id = s.id or to_location_id = s.id) and status = 'SENT';
    v_resto := public.wx_stock_desglose(s.id);
    if v_turnos > 0 then return jsonb_build_object('ok', false, 'code', 'SHIFTS_OPEN'); end if;
    if v_transito > 0 then return jsonb_build_object('ok', false, 'code', 'TRANSFERS_IN_TRANSIT'); end if;
    if jsonb_array_length(v_resto) > 0 and not coalesce((p->>'forzar')::boolean, false) then
      return jsonb_build_object('ok', false, 'code', 'STOCK_NOT_ZERO', 'stock', v_resto);
    end if;
    if jsonb_array_length(v_resto) > 0 then
      if char_length(btrim(coalesce(p->>'motivo',''))) < 5 or char_length(p->>'motivo') > 200 then
        return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
      end if;
      for r in select * from jsonb_array_elements(v_resto) loop
        v_mov := gen_random_uuid();
        insert into public.inventory_ledger(movement_uuid,company_id,location_id,product_uuid,type,quantity,ref_type,ref_uuid,reason,occurred_at)
        values(v_mov,s.negocio_id,s.id,(r->>'product_uuid')::uuid,'ADJUSTMENT',-(r->>'qty')::numeric,'RECONCILIATION',s.id,btrim(p->>'motivo'),now());
        ajustes := ajustes || jsonb_build_object('movement_uuid',v_mov,'product_uuid',r->>'product_uuid','quantity',-(r->>'qty')::numeric);
      end loop;
    end if;
    update public.sucursales set event_status = 'RECONCILED', reconciled_at = now(),
           reconciliation = jsonb_build_object('stock', v_resto, 'motivo', btrim(p->>'motivo'), 'por', a->>'id', 'home_location_id', s.home_location_id, 'adjustments', ajustes), updated_at = now()
     where id = s.id;
  else
    update public.sucursales set event_status = v_nuevo, updated_at = now() where id = s.id;
  end if;
  perform public.wx_audit(a->>'kind', a->>'id', s.negocio_id, 'EVENT_STATUS', 'OK', jsonb_build_object('location_id', s.id, 'from', s.event_status, 'to', v_nuevo));
  return jsonb_build_object('ok', true, 'event_status', v_nuevo);
end $$;
