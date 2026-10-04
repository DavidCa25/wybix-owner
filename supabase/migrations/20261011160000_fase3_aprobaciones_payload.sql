-- Fase 3: comprobar la autorización ANTES de proyectar. El subbloque de
-- sync_ingest revierte todos los hechos del evento cuando WX_REJECT falla.
create or replace function public.wx_aprob_exigir_evento(d public.devices, ev jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare a public.approval_requests%rowtype; pl jsonb := ev->'payload'; q jsonb; correcto boolean := false;
begin
  if coalesce(pl->'authorized_by'->>'remote', '') <> 'true' then return; end if;
  select * into a from public.approval_requests where id = public.wx_uuid(pl->'authorized_by'->>'uuid') for update;
  if not found or a.device_id <> d.id or a.company_id <> d.company_id or a.location_id <> d.location_id
     or a.status <> 'CONSUMED' or a.consumed_at > a.expires_at then
    raise exception 'WX_REJECT: autorización remota inválida';
  end if;
  if exists(select 1 from public.sync_events e where e.payload->'authorized_by'->>'uuid' = a.id::text and e.result = 'APPLIED') then
    raise exception 'WX_REJECT: autorización remota ya utilizada';
  end if;
  q := a.payload;
  if ev->>'event_type' = 'INVENTORY_MOVEMENT_RECORDED' then
    correcto := a.action = case pl->'movement'->>'type' when 'WASTE' then 'MERMA' when 'ADJUSTMENT' then 'AJUSTE' end
      and q->>'product_uuid' = pl->'movement'->>'product_uuid'
      and round((q->>'cantidad')::numeric, 2) = (pl->'movement'->>'quantity')::numeric
      and btrim(q->>'razon') = pl->'movement'->>'reason'
      and a.requested_by->>'uuid' = pl->'employee'->>'uuid';
  elsif ev->>'event_type' = 'CASH_MOVEMENT_RECORDED' then
    correcto := a.action = case pl->>'type' when 'CASH_OUT' then 'RETIRO' when 'EXPENSE' then 'EGRESO' end
      and q->>'tipo' = a.action and round((q->>'monto')::numeric, 2) = (pl->>'amount')::numeric
      and q->>'razon' = pl->>'note' and a.requested_by->>'uuid' = pl->'user'->>'uuid';
  elsif ev->>'event_type' = 'SHIFT_CLOSED' then
    correcto := a.action = 'CERRAR_TURNO_AJENO' and q->>'turno' = pl->>'shift_uuid'
      and round((q->>'contado')::numeric, 2) = (pl->>'cash_counted')::numeric
      and a.requested_by->>'uuid' = pl->'closed_by'->>'uuid';
  elsif ev->>'event_type' = 'TRANSFER_RECEIVED' then
    correcto := a.action = 'RECIBIR_TRANSFERENCIA' and q->>'transfer' = pl->>'transfer_uuid'
      and a.requested_by->>'uuid' = pl->'received_by'->>'uuid'
      and (select jsonb_agg(jsonb_build_object('product_uuid', x->>'product_uuid', 'cantidad', round((x->>'cantidad')::numeric,2)) order by x->>'product_uuid') from jsonb_array_elements(q->'recibido') x)
        = (select jsonb_agg(jsonb_build_object('product_uuid', x->>'product_uuid', 'cantidad', (x->>'qty_received')::numeric) order by x->>'product_uuid') from jsonb_array_elements(pl->'lines') x);
  elsif ev->>'event_type' = 'RETURN_SENT' then
    correcto := a.action = 'RETORNO' and a.requested_by->>'uuid' = pl->'sent_by'->>'uuid'
      and (select jsonb_agg(jsonb_build_object('product_uuid', x->>'product_uuid', 'cantidad', round((x->>'cantidad')::numeric,2)) order by x->>'product_uuid') from jsonb_array_elements(q->'lineas') x)
        = (select jsonb_agg(jsonb_build_object('product_uuid', x->>'product_uuid', 'cantidad', (x->>'qty_sent')::numeric) order by x->>'product_uuid') from jsonb_array_elements(pl->'lines') x);
  end if;
  if not coalesce(correcto, false) then raise exception 'WX_REJECT: operación distinta a la aprobada'; end if;
end $$;
revoke all on function public.wx_aprob_exigir_evento(public.devices, jsonb) from public;

create or replace function public.sync_ingest(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d public.devices%rowtype; v_loc public.sucursales%rowtype; ev jsonb; v_ev jsonb; v_uuid uuid;
  v_prev public.sync_events%rowtype; v_res text; salida jsonb := '[]'; env jsonb := coalesce(p->'envelope', '{}');
  v_skew interval := interval '0'; v_occ timestamptz; v_tipos text[]; v_neg jsonb;
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and (status = 'ACTIVE' or (status = 'REVOKED' and kind = 'MOBILE_POS'));
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if d.kind not in ('POS_PRIMARY', 'MOBILE_POS') then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  select * into v_loc from public.sucursales where id = d.location_id;
  if (nullif(env->>'company_uuid', '') is not null and public.wx_uuid(env->>'company_uuid') is distinct from d.company_id)
     or (nullif(env->>'location_uuid', '') is not null and public.wx_uuid(env->>'location_uuid') is distinct from d.location_id)
     or (nullif(env->>'instance_uuid', '') is not null and v_loc.instance_uuid is not null and public.wx_uuid(env->>'instance_uuid') is distinct from v_loc.instance_uuid) then
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'SYNC_INGEST', 'DENIED', jsonb_build_object('code', 'ENVELOPE_MISMATCH', 'envelope', env));
    return jsonb_build_object('ok', false, 'code', 'ENVELOPE_MISMATCH');
  end if;
  if d.kind = 'POS_PRIMARY' and nullif(env->>'server_fingerprint', '') is not null then
    if v_loc.server_fingerprint is null then
      update public.sucursales set server_fingerprint = env->>'server_fingerprint' where id = v_loc.id;
    elsif v_loc.server_fingerprint <> env->>'server_fingerprint' then
      perform public.wx_pendiente('CLONE_SUSPECTED', v_loc.id::text || ':' || (env->>'server_fingerprint'), d.company_id,
        jsonb_build_object('location_id', v_loc.id, 'esperada', v_loc.server_fingerprint, 'recibida', env->>'server_fingerprint', 'device_id', d.id));
      perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'SYNC_INGEST', 'DENIED', jsonb_build_object('code', 'CLONE_SUSPECTED'));
      return jsonb_build_object('ok', false, 'code', 'CLONE_SUSPECTED');
    end if;
  end if;
  if d.kind = 'MOBILE_POS' and v_loc.tipo <> 'EVENT' then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  v_tipos := case when d.kind = 'MOBILE_POS' then array['SALE', 'SHIFT', 'CASH_MOVEMENT', 'INVENTORY_MOVEMENT', 'TRANSFER']
                  else array['SALE', 'SHIFT', 'CASH_MOVEMENT', 'TRANSFER'] end;
  if nullif(env->>'device_now', '') is not null then
    v_skew := now() - (env->>'device_now')::timestamptz;
    update public.devices set clock_skew_seconds = extract(epoch from v_skew)::int where id = d.id;
  end if;
  if jsonb_typeof(p->'events') <> 'array' or jsonb_array_length(p->'events') > 500 then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;

  for ev in select * from jsonb_array_elements(p->'events') loop
    v_uuid := public.wx_uuid(ev->>'event_uuid');
    begin
      if v_uuid is null or public.wx_uuid(ev->>'aggregate_uuid') is null or jsonb_typeof(ev->'payload') <> 'object'
         or not (coalesce(ev->>'aggregate_type', '') = any (v_tipos)) then
        salida := salida || jsonb_build_object('event_uuid', ev->>'event_uuid', 'result', 'REJECTED', 'error', 'evento inválido');
        continue;
      end if;
      select * into v_prev from public.sync_events where event_uuid = v_uuid;
      if found then
        salida := salida || jsonb_build_object('event_uuid', v_uuid,
          'result', case when v_prev.company_id <> d.company_id then 'REJECTED' when v_prev.result = 'QUARANTINED' then 'QUARANTINED' else 'DUPLICATE' end);
        continue;
      end if;
      if d.status = 'REVOKED' then
        v_occ := (ev->>'occurred_at')::timestamptz + v_skew;
        if v_occ is null or v_occ > d.revoked_at then
          insert into public.sync_events (event_uuid, company_id, location_id, device_id, aggregate_type, aggregate_uuid, aggregate_version,
            event_type, occurred_at, payload_version, payload, result, local_seq)
          values (v_uuid, d.company_id, d.location_id, d.id, ev->>'aggregate_type', public.wx_uuid(ev->>'aggregate_uuid'),
            coalesce((ev->>'aggregate_version')::bigint, 0), left(ev->>'event_type', 40), (ev->>'occurred_at')::timestamptz,
            coalesce((ev->>'payload_version')::smallint, 1), ev->'payload', 'QUARANTINED', (ev->>'local_seq')::bigint);
          perform public.wx_pendiente('EVENT_QUARANTINED', v_uuid::text, d.company_id,
            jsonb_build_object('device_id', d.id, 'event_type', ev->>'event_type', 'occurred_corrected', v_occ, 'revoked_at', d.revoked_at));
          salida := salida || jsonb_build_object('event_uuid', v_uuid, 'result', 'QUARANTINED');
          continue;
        end if;
      end if;
      perform public.wx_aprob_exigir_evento(d, ev);
      v_ev := public.wx_normalizar_evento(ev, coalesce(v_loc.timezone, 'America/Mexico_City'));
      v_res := case when ev->>'aggregate_type' in ('SALE', 'SHIFT', 'CASH_MOVEMENT') then public.wx_proyectar(d, v_loc.timezone, v_ev) else 'APPLIED' end;
      if v_res <> 'REJECTED' then perform public.wx_proyectar_f2(d, v_loc, v_ev, v_uuid); end if;
      insert into public.sync_events (event_uuid, company_id, location_id, device_id, aggregate_type, aggregate_uuid,
        aggregate_version, event_type, occurred_at, payload_version, payload, result, local_seq)
      values (v_uuid, d.company_id, d.location_id, d.id, ev->>'aggregate_type', public.wx_uuid(ev->>'aggregate_uuid'),
        coalesce((ev->>'aggregate_version')::bigint, 0), left(ev->>'event_type', 40), (ev->>'occurred_at')::timestamptz,
        coalesce((ev->>'payload_version')::smallint, 1), ev->'payload', v_res, (ev->>'local_seq')::bigint)
      on conflict (event_uuid) do nothing;
      if v_res = 'REJECTED' then
        perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'SYNC_EVENT', 'DENIED',
          jsonb_build_object('event_uuid', v_uuid, 'aggregate', ev->>'aggregate_type', 'code', 'FOREIGN_AGGREGATE'));
      end if;
      salida := salida || jsonb_build_object('event_uuid', v_uuid, 'result', case when v_res = 'REJECTED' then 'REJECTED' else 'APPLIED' end);
    exception when others then
      if sqlerrm like 'WX_REJECT:%' then
        perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'SYNC_EVENT', 'DENIED', jsonb_build_object('event_uuid', ev->>'event_uuid', 'motivo', sqlerrm));
        salida := salida || jsonb_build_object('event_uuid', ev->>'event_uuid', 'result', 'REJECTED', 'error', left(substr(sqlerrm, 12), 200));
      else
        salida := salida || jsonb_build_object('event_uuid', ev->>'event_uuid', 'result', 'ERROR', 'error', left(sqlerrm, 200));
      end if;
    end;
  end loop;

  update public.devices set last_sync_at = now(), last_seen_at = now(),
         last_seq = greatest(coalesce(last_seq, 0), coalesce((select max((e->>'local_seq')::bigint) from jsonb_array_elements(p->'events') e), 0))
   where id = d.id;

  -- Stock negativo en un evento: se avisa y se concilia; nunca se borra una venta.
  if v_loc.tipo = 'EVENT' then
    select jsonb_agg(jsonb_build_object('product_uuid', product_uuid, 'qty', qty)) into v_neg from public.location_stock where location_id = v_loc.id and qty < 0;
    if v_neg is not null then
      perform public.wx_pendiente('STOCK_NEGATIVE', v_loc.id::text || ':' || to_char(now(), 'YYYY-MM-DD'), d.company_id, jsonb_build_object('stock', v_neg));
    end if;
  end if;
  return jsonb_build_object('ok', true, 'results', salida);
end $$;
