-- ============================================================================
-- Producción por tandas (POS 0060) en la nube.
--
-- La caja ya fabrica por tandas: planea, empieza (salen los ingredientes) y
-- registra lo que salió con su merma; al cierre, registra la merma de lo que
-- no se vendió. Aquí llegan esos hechos para que el dueño los vea:
--
--   production_batch_facts   una fila por tanda, con su último estado
--                            (planeada, en preparación, lista, cancelada),
--                            lo planeado, lo bueno, la merma y el costo.
--   production_waste_facts   la merma de producto terminado, una por una.
--
-- Los saldos NO viajan: la existencia se reconstruye de los hechos, como
-- siempre. Las filas solo avanzan: un evento con una versión anterior a la
-- guardada no la pisa (los eventos pueden llegar desordenados).
--
-- sync_ingest acepta los dos agregados nuevos solo de cajas de sucursal
-- (POS_PRIMARY); la tablet de eventos no produce.
-- ============================================================================

create table if not exists public.production_batch_facts (
  batch_uuid      uuid primary key,
  company_id      uuid not null references public.negocios (id) on delete cascade,
  location_id     uuid not null references public.sucursales (id) on delete cascade,
  device_id       uuid,
  product_uuid    uuid,
  product_name    text,
  status          text not null check (status in ('PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
  production_date date,
  planned_qty     numeric(12, 2),
  good_qty        numeric(12, 2),
  waste_qty       numeric(12, 2),
  waste_reason    text,
  total_cost      numeric(14, 4),
  unit_cost       numeric(14, 4),
  started_local   timestamp,
  finished_local  timestamp,
  created_by      text,
  started_by      text,
  finished_by     text,
  consumption     jsonb not null default '[]'::jsonb,
  aggregate_version bigint not null default 0,
  updated_at      timestamptz not null default now()
);
create index if not exists ix_production_batch_facts_loc_date on public.production_batch_facts (location_id, production_date);

create table if not exists public.production_waste_facts (
  waste_uuid   uuid primary key,
  company_id   uuid not null references public.negocios (id) on delete cascade,
  location_id  uuid not null references public.sucursales (id) on delete cascade,
  device_id    uuid,
  product_uuid uuid,
  product_name text,
  qty          numeric(12, 2) not null,
  reason       text,
  unit_cost    numeric(14, 4),
  waste_date   date,
  created_by   text,
  occurred_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists ix_production_waste_facts_loc_date on public.production_waste_facts (location_id, waste_date);

alter table public.production_batch_facts enable row level security;
alter table public.production_waste_facts enable row level security;
drop policy if exists "miembro ve produccion" on public.production_batch_facts;
create policy "miembro ve produccion" on public.production_batch_facts for select to authenticated using (public.wx_puede_ubicacion(location_id));
drop policy if exists "miembro ve merma" on public.production_waste_facts;
create policy "miembro ve merma" on public.production_waste_facts for select to authenticated using (public.wx_puede_ubicacion(location_id));
revoke insert, update, delete on public.production_batch_facts, public.production_waste_facts from anon, authenticated;

/* Proyecta un hecho de producción ya validado por sync_ingest. */
create or replace function public.wx_proyectar_produccion(d public.devices, v_loc public.sucursales, ev jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare t text := ev->>'aggregate_type'; pl jsonb := ev->'payload';
        agg uuid := public.wx_uuid(ev->>'aggregate_uuid'); v_ver bigint := coalesce((ev->>'aggregate_version')::bigint, 0);
begin
  if d.kind <> 'POS_PRIMARY' or v_loc.tipo = 'EVENT' then raise exception 'WX_REJECT: solo una sucursal registra produccion'; end if;
  if t = 'PRODUCTION' then
    if exists (select 1 from public.production_batch_facts where batch_uuid = agg and company_id <> d.company_id) then
      raise exception 'WX_REJECT: tanda ajena';
    end if;
    insert into public.production_batch_facts as f (batch_uuid, company_id, location_id, device_id, product_uuid, product_name, status,
        production_date, planned_qty, good_qty, waste_qty, waste_reason, total_cost, unit_cost, started_local, finished_local,
        created_by, started_by, finished_by, consumption, aggregate_version, updated_at)
    values (agg, d.company_id, d.location_id, d.id, public.wx_uuid(pl->>'product_uuid'), pl->>'product_name', pl->>'status',
        nullif(pl->>'production_date', '')::date, nullif(pl->>'planned_qty', '')::numeric, nullif(pl->>'good_qty', '')::numeric,
        nullif(pl->>'waste_qty', '')::numeric, pl->>'waste_reason', nullif(pl->>'total_cost', '')::numeric, nullif(pl->>'unit_cost', '')::numeric,
        nullif(pl->>'started_local', '')::timestamp, nullif(pl->>'finished_local', '')::timestamp,
        pl->>'created_by', pl->>'started_by', pl->>'finished_by', coalesce(pl->'consumption', '[]'::jsonb), v_ver, now())
    on conflict (batch_uuid) do update set
        status = excluded.status, planned_qty = excluded.planned_qty, good_qty = excluded.good_qty, waste_qty = excluded.waste_qty,
        waste_reason = excluded.waste_reason, total_cost = excluded.total_cost, unit_cost = excluded.unit_cost,
        started_local = excluded.started_local, finished_local = excluded.finished_local,
        started_by = excluded.started_by, finished_by = excluded.finished_by, consumption = excluded.consumption,
        aggregate_version = excluded.aggregate_version, updated_at = now()
      where f.aggregate_version < excluded.aggregate_version;
  elsif t = 'WASTE' then
    insert into public.production_waste_facts (waste_uuid, company_id, location_id, device_id, product_uuid, product_name,
        qty, reason, unit_cost, waste_date, created_by, occurred_at)
    values (agg, d.company_id, d.location_id, d.id, public.wx_uuid(pl->>'product_uuid'), pl->>'product_name',
        (pl->>'qty')::numeric, pl->>'reason', nullif(pl->>'unit_cost', '')::numeric, nullif(pl->>'waste_date', '')::date,
        pl->>'created_by', (ev->>'occurred_at')::timestamptz)
    on conflict (waste_uuid) do nothing;
  end if;
end $$;
revoke all on function public.wx_proyectar_produccion(public.devices, public.sucursales, jsonb) from public, anon, authenticated;
grant execute on function public.wx_proyectar_produccion(public.devices, public.sucursales, jsonb) to service_role;

/* sync_ingest: igual que en 20261011160000, más PRODUCTION y WASTE. */
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
                  else array['SALE', 'SHIFT', 'CASH_MOVEMENT', 'TRANSFER', 'PRODUCTION', 'WASTE'] end;
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
      -- 0060 · Producción por tandas y merma de terminado (solo cajas de sucursal).
      if ev->>'aggregate_type' in ('PRODUCTION', 'WASTE') then perform public.wx_proyectar_produccion(d, v_loc, v_ev); end if;
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
