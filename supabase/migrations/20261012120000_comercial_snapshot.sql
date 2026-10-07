-- Extensión aditiva: conserva precios y reglas aplicados sin reinterpretar ventas anteriores.
alter table public.sales_facts add column if not exists commercial_snapshot jsonb;
alter table public.sale_line_facts add column if not exists commercial_snapshot jsonb;

create or replace function public.wx_proyectar_f2(d public.devices, v_loc public.sucursales, ev jsonb, p_event uuid)
returns text language plpgsql security definer set search_path = public as $$
declare t text := ev->>'aggregate_type'; et text := ev->>'event_type'; pl jsonb := ev->'payload';
        agg uuid := public.wx_uuid(ev->>'aggregate_uuid'); v_at timestamptz := (ev->>'occurred_at')::timestamptz;
        m jsonb; l jsonb; v_tr public.stock_transfers%rowtype; v_otro uuid; v_tipo_otro text; v_line public.stock_transfer_lines%rowtype;
begin
  if t = 'SALE' then
    if pl ? 'commercial' then
      update public.sales_facts set commercial_snapshot=pl->'commercial' where sale_uuid=agg and company_id=d.company_id;
    end if;
    if pl ? 'lines' then
      update public.sales_facts set catalog_version = (pl->>'catalog_version')::int, folio_text = coalesce(pl->>'folio_text', pl->>'folio'),
             invoice_requested = coalesce((pl->>'invoice_requested')::boolean, false)
       where sale_uuid = agg and company_id = d.company_id;
      for l in select * from jsonb_array_elements(pl->'lines') loop
        insert into public.sale_line_facts (sale_uuid, line_no, company_id, location_id, product_uuid, product_name, quantity, unit_price, unit_cost, catalog_version, commercial_snapshot)
        values (agg, (l->>'line_no')::int, d.company_id, d.location_id, public.wx_uuid(l->>'product_uuid'), l->>'product_name',
                (l->>'quantity')::numeric, (l->>'unit_price')::numeric, (l->>'unit_cost')::numeric, (pl->>'catalog_version')::int,l->'commercial')
        on conflict (sale_uuid, line_no) do nothing;
      end loop;
    end if;
    for m in select * from jsonb_array_elements(coalesce(pl->'movements', '[]')) loop
      perform public.wx_ledger(d.company_id, v_loc, public.wx_uuid(m->>'uuid'), public.wx_uuid(m->>'product_uuid'), m->>'type', (m->>'quantity')::numeric,
                               'SALE', agg, d.id, p_event, null, v_at);
    end loop;

  elsif t = 'INVENTORY_MOVEMENT' then
    m := pl->'movement';
    if coalesce(m->>'type', '') not in ('WASTE', 'ADJUSTMENT') then raise exception 'WX_REJECT: movimiento manual no válido'; end if;
    perform public.wx_ledger(d.company_id, v_loc, public.wx_uuid(m->>'uuid'), public.wx_uuid(m->>'product_uuid'), m->>'type', (m->>'quantity')::numeric,
                             m->>'type', agg, d.id, p_event, m->>'reason', v_at);

  elsif t = 'TRANSFER' and v_loc.tipo = 'BRANCH' then
    if et = 'TRANSFER_SENT' or (et = 'TRANSFER_RECEIVED' and pl->>'kind' = 'OUT') then
      v_otro := public.wx_uuid(pl->>'event_location_uuid');
      select tipo into v_tipo_otro from public.sucursales where id = v_otro and negocio_id = d.company_id;
      if v_tipo_otro is distinct from 'EVENT' then raise exception 'WX_REJECT: el destino no es un evento de esta empresa'; end if;
      select * into v_tr from public.stock_transfers where transfer_uuid = agg;
      if found and (v_tr.company_id <> d.company_id or v_tr.from_location_id <> v_loc.id or v_tr.kind <> 'OUT') then
        raise exception 'WX_REJECT: transferencia ajena'; end if;
      insert into public.stock_transfers (transfer_uuid, company_id, kind, from_location_id, to_location_id, status, signature, sent_at, origin_device, branch_confirmed)
      values (agg, d.company_id, 'OUT', v_loc.id, v_otro, 'SENT', pl->>'signature', v_at, d.id, et = 'TRANSFER_RECEIVED')
      on conflict (transfer_uuid) do update set signature = coalesce(excluded.signature, stock_transfers.signature),
        branch_confirmed = stock_transfers.branch_confirmed or excluded.branch_confirmed, updated_at = now();
      for l in select * from jsonb_array_elements(coalesce(pl->'lines', '[]')) loop
        -- La sucursal es la autoridad de lo ENVIADO; si la tablet dijo otra cosa, queda como evidencia.
        insert into public.stock_transfer_lines (transfer_uuid, product_uuid, product_name, qty_sent)
        values (agg, public.wx_uuid(l->>'product_uuid'), l->>'product_name', (l->>'qty_sent')::numeric)
        on conflict (transfer_uuid, product_uuid) do update set
          claimed_sent = case when stock_transfer_lines.qty_sent <> excluded.qty_sent then stock_transfer_lines.qty_sent else stock_transfer_lines.claimed_sent end,
          qty_sent = excluded.qty_sent, product_name = coalesce(stock_transfer_lines.product_name, excluded.product_name);
        perform public.wx_ledger(d.company_id, v_loc, public.wx_uuid_det('TRANSFER_OUT|' || agg || '|' || (l->>'product_uuid')), public.wx_uuid(l->>'product_uuid'),
                                 'TRANSFER_OUT', (l->>'qty_sent')::numeric, 'TRANSFER', agg, d.id, p_event, null, v_at);
      end loop;
    elsif et = 'RETURN_RECEIVED' then
      v_otro := public.wx_uuid(pl->>'event_location_uuid');
      select * into v_tr from public.stock_transfers where transfer_uuid = agg;
      if found and (v_tr.company_id <> d.company_id or v_tr.to_location_id <> v_loc.id or v_tr.kind <> 'RETURN') then
        raise exception 'WX_REJECT: retorno ajeno'; end if;
      if not found then
        select tipo into v_tipo_otro from public.sucursales where id = v_otro and negocio_id = d.company_id;
        if v_tipo_otro is distinct from 'EVENT' then raise exception 'WX_REJECT: el origen no es un evento de esta empresa'; end if;
        insert into public.stock_transfers (transfer_uuid, company_id, kind, from_location_id, to_location_id, status, sent_at, origin_device)
        values (agg, d.company_id, 'RETURN', v_otro, v_loc.id, 'SENT', v_at, null);
      end if;
      update public.stock_transfers set status = 'RECEIVED', received_at = v_at, updated_at = now() where transfer_uuid = agg;
      for l in select * from jsonb_array_elements(coalesce(pl->'lines', '[]')) loop
        insert into public.stock_transfer_lines (transfer_uuid, product_uuid, product_name, qty_sent, qty_received)
        values (agg, public.wx_uuid(l->>'product_uuid'), l->>'product_name', (l->>'qty_sent')::numeric, (l->>'qty_received')::numeric)
        on conflict (transfer_uuid, product_uuid) do update set qty_received = excluded.qty_received;
        if (l->>'qty_received')::numeric > 0 then
          perform public.wx_ledger(d.company_id, v_loc, public.wx_uuid_det('RETURN_TRANSFER_IN|' || agg || '|' || (l->>'product_uuid')), public.wx_uuid(l->>'product_uuid'),
                                   'RETURN_TRANSFER_IN', (l->>'qty_received')::numeric, 'TRANSFER', agg, d.id, p_event, null, v_at);
        end if;
      end loop;
    end if;

  elsif t = 'TRANSFER' and v_loc.tipo = 'EVENT' then
    if et = 'TRANSFER_RECEIVED' then
      select * into v_tr from public.stock_transfers where transfer_uuid = agg;
      if found and (v_tr.company_id <> d.company_id or v_tr.to_location_id <> v_loc.id or v_tr.kind <> 'OUT') then
        raise exception 'WX_REJECT: esa transferencia no es para este evento'; end if;
      if not found then
        -- Recibida por QR antes de que la sucursal sincronizara su envío.
        v_otro := public.wx_uuid(pl->>'from_location_uuid');
        select tipo into v_tipo_otro from public.sucursales where id = v_otro and negocio_id = d.company_id;
        if v_tipo_otro is distinct from 'BRANCH' then raise exception 'WX_REJECT: el origen no es una sucursal de esta empresa'; end if;
        insert into public.stock_transfers (transfer_uuid, company_id, kind, from_location_id, to_location_id, status, sent_at)
        values (agg, d.company_id, 'OUT', v_otro, v_loc.id, 'SENT', v_at);
      end if;
      update public.stock_transfers set status = 'RECEIVED', received_at = v_at, updated_at = now() where transfer_uuid = agg;
      for l in select * from jsonb_array_elements(coalesce(pl->'lines', '[]')) loop
        select * into v_line from public.stock_transfer_lines where transfer_uuid = agg and product_uuid = public.wx_uuid(l->>'product_uuid');
        if found then
          update public.stock_transfer_lines set qty_received = (l->>'qty_received')::numeric,
                 claimed_sent = case when qty_sent <> (l->>'qty_sent')::numeric then (l->>'qty_sent')::numeric else claimed_sent end
           where transfer_uuid = agg and product_uuid = v_line.product_uuid;
          if v_line.qty_sent <> (l->>'qty_sent')::numeric then
            perform public.wx_pendiente('TRANSFER_MISMATCH', agg::text || ':' || v_line.product_uuid, d.company_id,
              jsonb_build_object('enviado_sucursal', v_line.qty_sent, 'dice_la_tablet', l->>'qty_sent', 'recibido', l->>'qty_received'));
          end if;
        else
          insert into public.stock_transfer_lines (transfer_uuid, product_uuid, product_name, qty_sent, qty_received)
          values (agg, public.wx_uuid(l->>'product_uuid'), l->>'product_name', (l->>'qty_sent')::numeric, (l->>'qty_received')::numeric);
        end if;
      end loop;
      for m in select * from jsonb_array_elements(coalesce(pl->'movements', '[]')) loop
        if m->>'type' <> 'TRANSFER_IN' then raise exception 'WX_REJECT: movimiento de recepción no válido'; end if;
        perform public.wx_ledger(d.company_id, v_loc, public.wx_uuid(m->>'uuid'), public.wx_uuid(m->>'product_uuid'), 'TRANSFER_IN', (m->>'quantity')::numeric,
                                 'TRANSFER', agg, d.id, p_event, null, v_at);
      end loop;
    elsif et = 'RETURN_SENT' then
      if v_loc.home_location_id is null then raise exception 'WX_REJECT: el evento no tiene sucursal base'; end if;
      insert into public.stock_transfers (transfer_uuid, company_id, kind, from_location_id, to_location_id, status, sent_at, origin_device)
      values (agg, d.company_id, 'RETURN', v_loc.id, v_loc.home_location_id, 'SENT', v_at, d.id)
      on conflict (transfer_uuid) do nothing;
      for l in select * from jsonb_array_elements(coalesce(pl->'lines', '[]')) loop
        insert into public.stock_transfer_lines (transfer_uuid, product_uuid, product_name, qty_sent)
        values (agg, public.wx_uuid(l->>'product_uuid'), l->>'product_name', (l->>'qty_sent')::numeric)
        on conflict (transfer_uuid, product_uuid) do nothing;
      end loop;
      for m in select * from jsonb_array_elements(coalesce(pl->'movements', '[]')) loop
        if m->>'type' <> 'RETURN_TRANSFER_OUT' then raise exception 'WX_REJECT: movimiento de retorno no válido'; end if;
        perform public.wx_ledger(d.company_id, v_loc, public.wx_uuid(m->>'uuid'), public.wx_uuid(m->>'product_uuid'), 'RETURN_TRANSFER_OUT', (m->>'quantity')::numeric,
                                 'TRANSFER', agg, d.id, p_event, null, v_at);
      end loop;
    else
      raise exception 'WX_REJECT: evento de transferencia desconocido';
    end if;
  end if;
  return 'APPLIED';
end $$;
revoke all on function public.wx_proyectar_f2(public.devices,public.sucursales,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.wx_proyectar_f2(public.devices,public.sucursales,jsonb,uuid) to service_role;
