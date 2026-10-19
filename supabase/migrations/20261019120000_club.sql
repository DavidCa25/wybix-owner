-- ============================================================================
--  CLUB (POS 0063): membresías que valen en todas las sucursales.
--
--  La caja sube hechos (sp_sync_capture):
--    MEMBERSHIP_PLAN        el plan (producto de cobro, días, límite diario)
--    MEMBERSHIP             hasta cuándo está pagada una membresía
--    MEMBERSHIP_REDEMPTION  un beneficio dado en esa caja (o anulado)
--    POINTS_CONFIG          (POS 0064) cómo se ganan los puntos
--    STAMP_CARD             (POS 0064) una tarjeta de sellos
--    LOYALTY_LEDGER         (POS 0064) un movimiento de puntos o sellos
--  y baja lo de las demás con club_pull (sp_membership_apply_remote y
--  sp_loyalty_points_apply_remote).
--
--  PUNTOS: el saldo de un cliente es la suma de sus movimientos en todas las
--  sucursales. Cada caja sube solo los suyos; club_pull le devuelve los de
--  las DEMÁS sucursales. El cliente se reconoce por su teléfono.
--
--  CANJES DOBLES: una caja sin internet deja canjear (decisión del negocio).
--  Aquí, al llegar cada canje, se recalcula el día de esa membresía: por orden
--  en que ocurrieron, los que pasan del límite diario quedan doble = true. La
--  marca baja a todas las cajas y se revisa en Fidelización > Club.
--
--  Los saldos no viajan: paid_until se queda con el MAYOR reportado.
-- ============================================================================
begin;

create table if not exists public.club_plans (
  uuid uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid,
  name text not null,
  sale_product_uuid uuid,
  period_days int not null default 30,
  daily_limit int not null default 1,
  grace_days int not null default 0,
  active boolean not null default true,
  products jsonb not null default '[]',
  aggregate_version bigint not null default 0,
  changed_at timestamptz not null default now()
);
create index if not exists ix_club_plans_company on public.club_plans (company_id, changed_at);

create table if not exists public.club_memberships (
  uuid uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  plan_uuid uuid not null,
  customer_name text,
  phone text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CANCELLED')),
  paid_until date,
  location_id uuid,
  changed_at timestamptz not null default now()
);
create index if not exists ix_club_memberships_company on public.club_memberships (company_id, changed_at);

create table if not exists public.club_redemptions (
  uuid uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  membership_uuid uuid not null,
  location_id uuid not null,
  device_id uuid,
  redeem_date date not null,
  units int not null default 1,
  product_uuid uuid,
  product_name text,
  amount numeric(12, 2),
  voided boolean not null default false,
  doble boolean not null default false,
  occurred_at timestamptz,
  changed_at timestamptz not null default now()
);
create index if not exists ix_club_redemptions_dia on public.club_redemptions (membership_uuid, redeem_date);
create index if not exists ix_club_redemptions_company on public.club_redemptions (company_id, changed_at);

create table if not exists public.club_points_config (
  company_id uuid primary key references public.negocios(id) on delete cascade,
  enabled boolean not null default false,
  per_amount numeric(12, 2),
  points_per int not null default 1,
  visit_points int not null default 0,
  expiry_months int,
  updated_local text,
  location_id uuid,
  aggregate_version bigint not null default 0,
  changed_at timestamptz not null default now()
);

create table if not exists public.club_stamp_cards (
  uuid uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid,
  name text not null,
  stamps_required int not null,
  reward_product_uuid uuid,
  active boolean not null default true,
  products jsonb not null default '[]',
  aggregate_version bigint not null default 0,
  changed_at timestamptz not null default now()
);
create index if not exists ix_club_stamp_cards_company on public.club_stamp_cards (company_id, changed_at);

create table if not exists public.club_ledger (
  uuid uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid not null,
  device_id uuid,
  customer_name text,
  phone text,
  program text not null check (program in ('POINTS', 'STAMPS')),
  card_uuid uuid,
  delta int not null,
  kind text not null check (kind in ('EARN', 'REDEEM', 'REVERSE', 'EXPIRE', 'ADJUST')),
  reason text,
  amount numeric(12, 2),
  note text,
  created_local text,
  occurred_at timestamptz,
  changed_at timestamptz not null default now()
);
create index if not exists ix_club_ledger_company on public.club_ledger (company_id, changed_at);

alter table public.club_points_config enable row level security;
alter table public.club_stamp_cards enable row level security;
alter table public.club_ledger enable row level security;
revoke all on public.club_points_config, public.club_stamp_cards, public.club_ledger from public, anon, authenticated;

alter table public.club_plans enable row level security;
alter table public.club_memberships enable row level security;
alter table public.club_redemptions enable row level security;
revoke all on public.club_plans, public.club_memberships, public.club_redemptions from public, anon, authenticated;

/* Recalcula el día de una membresía: en el orden en que ocurrieron, lo que pasa del límite es doble. */
create or replace function public.wx_club_recalcular_dia(p_company uuid, p_membership uuid, p_dia date)
returns void language plpgsql security definer set search_path = public as $$
declare v_limite int;
begin
  select coalesce(pl.daily_limit, 1) into v_limite
    from public.club_memberships m left join public.club_plans pl on pl.uuid = m.plan_uuid
   where m.uuid = p_membership and m.company_id = p_company;
  v_limite := coalesce(v_limite, 1);
  with orden as (
    select r.uuid, r.doble, r.voided,
           sum(case when r.voided then 0 else r.units end)
             over (order by r.occurred_at nulls last, r.changed_at, r.uuid rows between unbounded preceding and current row) as acumulado
      from public.club_redemptions r
     where r.membership_uuid = p_membership and r.redeem_date = p_dia and r.company_id = p_company)
  update public.club_redemptions r
     set doble = (not o.voided and o.acumulado > v_limite), changed_at = now()
    from orden o
   where o.uuid = r.uuid and o.doble is distinct from (not o.voided and o.acumulado > v_limite);
end $$;

create or replace function public.wx_proyectar_club(d public.devices, v_loc public.sucursales, ev jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare t text := ev->>'aggregate_type'; pl jsonb := ev->'payload';
        agg uuid := public.wx_uuid(ev->>'aggregate_uuid'); v_ver bigint := coalesce((ev->>'aggregate_version')::bigint, 0);
        v_dia date;
begin
  if d.kind <> 'POS_PRIMARY' or v_loc.tipo = 'EVENT' then raise exception 'WX_REJECT: solo una sucursal maneja el Club'; end if;
  if t = 'MEMBERSHIP_PLAN' then
    if exists (select 1 from public.club_plans where uuid = agg and company_id <> d.company_id) then raise exception 'WX_REJECT: plan ajeno'; end if;
    insert into public.club_plans as f (uuid, company_id, location_id, name, sale_product_uuid, period_days, daily_limit, grace_days, active, products, aggregate_version)
    values (agg, d.company_id, d.location_id, coalesce(pl->>'name', 'Club'), public.wx_uuid(pl->>'sale_product_uuid'),
            coalesce((pl->>'period_days')::int, 30), coalesce((pl->>'daily_limit')::int, 1), coalesce((pl->>'grace_days')::int, 0),
            coalesce((pl->>'active')::boolean, true), coalesce(pl->'products', '[]'::jsonb), v_ver)
    on conflict (uuid) do update set name = excluded.name, sale_product_uuid = excluded.sale_product_uuid, period_days = excluded.period_days,
        daily_limit = excluded.daily_limit, grace_days = excluded.grace_days, active = excluded.active, products = excluded.products,
        aggregate_version = excluded.aggregate_version, changed_at = now()
      where f.aggregate_version < excluded.aggregate_version;
  elsif t = 'MEMBERSHIP' then
    if exists (select 1 from public.club_memberships where uuid = agg and company_id <> d.company_id) then raise exception 'WX_REJECT: membresia ajena'; end if;
    insert into public.club_memberships as f (uuid, company_id, plan_uuid, customer_name, phone, status, paid_until, location_id)
    values (agg, d.company_id, public.wx_uuid(pl->>'plan_uuid'), pl->>'customer_name', pl->>'phone',
            case when pl->>'status' = 'CANCELLED' then 'CANCELLED' else 'ACTIVE' end, nullif(pl->>'paid_until', '')::date, d.location_id)
    on conflict (uuid) do update set
        customer_name = coalesce(excluded.customer_name, f.customer_name), phone = coalesce(excluded.phone, f.phone),
        paid_until = greatest(f.paid_until, excluded.paid_until),
        status = case when excluded.status = 'CANCELLED' then 'CANCELLED'
                      when f.status = 'CANCELLED' and excluded.paid_until > coalesce(f.paid_until, '1900-01-01') then 'ACTIVE'
                      else f.status end,
        location_id = excluded.location_id, changed_at = now()
      where f.paid_until is distinct from greatest(f.paid_until, excluded.paid_until) or f.status <> excluded.status
         or f.customer_name is distinct from excluded.customer_name or f.phone is distinct from excluded.phone;
  elsif t = 'MEMBERSHIP_REDEMPTION' then
    if exists (select 1 from public.club_redemptions where uuid = agg and company_id <> d.company_id) then raise exception 'WX_REJECT: canje ajeno'; end if;
    v_dia := nullif(pl->>'redeem_date', '')::date;
    if v_dia is null or public.wx_uuid(pl->>'membership_uuid') is null then raise exception 'WX_REJECT: canje incompleto'; end if;
    insert into public.club_redemptions as f (uuid, company_id, membership_uuid, location_id, device_id, redeem_date, units, product_uuid, product_name, amount, voided, occurred_at)
    values (agg, d.company_id, public.wx_uuid(pl->>'membership_uuid'), d.location_id, d.id, v_dia, greatest(1, coalesce((pl->>'units')::int, 1)),
            public.wx_uuid(pl->>'product_uuid'), pl->>'product_name', nullif(pl->>'amount', '')::numeric,
            coalesce((pl->>'voided')::boolean, false), (ev->>'occurred_at')::timestamptz)
    on conflict (uuid) do update set voided = excluded.voided, changed_at = now() where f.voided <> excluded.voided;
    perform public.wx_club_recalcular_dia(d.company_id, public.wx_uuid(pl->>'membership_uuid'), v_dia);
  elsif t = 'POINTS_CONFIG' then
    insert into public.club_points_config as f (company_id, enabled, per_amount, points_per, visit_points, expiry_months, updated_local, location_id, aggregate_version)
    values (d.company_id, coalesce((pl->>'enabled')::boolean, false), nullif(pl->>'per_amount', '')::numeric, coalesce((pl->>'points_per')::int, 1),
            coalesce((pl->>'visit_points')::int, 0), nullif(pl->>'expiry_months', '')::int, pl->>'updated_local', d.location_id, v_ver)
    on conflict (company_id) do update set enabled = excluded.enabled, per_amount = excluded.per_amount, points_per = excluded.points_per,
        visit_points = excluded.visit_points, expiry_months = excluded.expiry_months, updated_local = excluded.updated_local,
        location_id = excluded.location_id, aggregate_version = excluded.aggregate_version, changed_at = now()
      where coalesce(f.updated_local, '') < coalesce(excluded.updated_local, '');
  elsif t = 'STAMP_CARD' then
    if exists (select 1 from public.club_stamp_cards where uuid = agg and company_id <> d.company_id) then raise exception 'WX_REJECT: tarjeta ajena'; end if;
    insert into public.club_stamp_cards as f (uuid, company_id, location_id, name, stamps_required, reward_product_uuid, active, products, aggregate_version)
    values (agg, d.company_id, d.location_id, coalesce(pl->>'name', 'Tarjeta'), greatest(2, coalesce((pl->>'stamps_required')::int, 10)),
            public.wx_uuid(pl->>'reward_product_uuid'), coalesce((pl->>'active')::boolean, true), coalesce(pl->'products', '[]'::jsonb), v_ver)
    on conflict (uuid) do update set name = excluded.name, stamps_required = excluded.stamps_required, reward_product_uuid = excluded.reward_product_uuid,
        active = excluded.active, products = excluded.products, aggregate_version = excluded.aggregate_version, changed_at = now()
      where f.aggregate_version < excluded.aggregate_version;
  elsif t = 'LOYALTY_LEDGER' then
    if exists (select 1 from public.club_ledger where uuid = agg and company_id <> d.company_id) then raise exception 'WX_REJECT: movimiento ajeno'; end if;
    if coalesce((pl->>'delta')::int, 0) = 0 or pl->>'program' not in ('POINTS', 'STAMPS') then raise exception 'WX_REJECT: movimiento incompleto'; end if;
    insert into public.club_ledger (uuid, company_id, location_id, device_id, customer_name, phone, program, card_uuid, delta, kind, reason, amount, note, created_local, occurred_at)
    values (agg, d.company_id, d.location_id, d.id, pl->>'customer_name', pl->>'phone', pl->>'program', public.wx_uuid(pl->>'card_uuid'),
            (pl->>'delta')::int, pl->>'kind', pl->>'reason', nullif(pl->>'amount', '')::numeric, pl->>'note', pl->>'created_local',
            (ev->>'occurred_at')::timestamptz)
    on conflict (uuid) do nothing;
  end if;
end $$;

/* Lo del Club que cambió desde `desde`, para que la caja lo aplique. Toda la
   empresa: también lo de esta caja, para que reciba sus marcas de doble. */
create or replace function public.club_pull(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; v_desde timestamptz := coalesce(nullif(p->>'desde', '')::timestamptz, '1970-01-01'::timestamptz);
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE' and kind in ('POS_PRIMARY', 'POS_SECONDARY');
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  return jsonb_build_object('ok', true, 'cursor', now(),
    'plans', coalesce((select jsonb_agg(jsonb_build_object('uuid', x.uuid, 'name', x.name, 'sale_product_uuid', x.sale_product_uuid,
        'period_days', x.period_days, 'daily_limit', x.daily_limit, 'grace_days', x.grace_days, 'active', x.active, 'products', x.products))
      from (select * from public.club_plans where company_id = d.company_id and changed_at > v_desde order by changed_at limit 500) x), '[]'),
    'memberships', coalesce((select jsonb_agg(jsonb_build_object('uuid', x.uuid, 'plan_uuid', x.plan_uuid, 'customer_name', x.customer_name,
        'phone', x.phone, 'status', x.status, 'paid_until', x.paid_until))
      from (select * from public.club_memberships where company_id = d.company_id and changed_at > v_desde order by changed_at limit 3000) x), '[]'),
    'redemptions', coalesce((select jsonb_agg(jsonb_build_object('uuid', r.uuid, 'membership_uuid', r.membership_uuid, 'redeem_date', r.redeem_date,
        'units', r.units, 'product_uuid', r.product_uuid, 'product_name', r.product_name, 'location_name', s.nombre,
        'voided', r.voided, 'doble', r.doble))
      from (select * from public.club_redemptions where company_id = d.company_id and changed_at > v_desde
              and redeem_date >= current_date - 7 order by changed_at limit 3000) r
      left join public.sucursales s on s.id = r.location_id), '[]'),
    'points_config', (select jsonb_build_object('enabled', c.enabled, 'per_amount', c.per_amount, 'points_per', c.points_per,
        'visit_points', c.visit_points, 'expiry_months', c.expiry_months, 'updated_local', c.updated_local)
      from public.club_points_config c where c.company_id = d.company_id and c.changed_at > v_desde),
    'stamp_cards', coalesce((select jsonb_agg(jsonb_build_object('uuid', x.uuid, 'name', x.name, 'stamps_required', x.stamps_required,
        'reward_product_uuid', x.reward_product_uuid, 'active', x.active, 'products', x.products))
      from (select * from public.club_stamp_cards where company_id = d.company_id and changed_at > v_desde order by changed_at limit 500) x), '[]'),
    /* Los movimientos de las DEMÁS sucursales: los de esta ya están en su base. */
    'ledger', coalesce((select jsonb_agg(jsonb_build_object('uuid', l.uuid, 'customer_name', l.customer_name, 'phone', l.phone,
        'program', l.program, 'card_uuid', l.card_uuid, 'delta', l.delta, 'kind', l.kind, 'reason', l.reason, 'amount', l.amount,
        'note', l.note, 'created_local', l.created_local, 'location_name', s.nombre))
      from (select * from public.club_ledger where company_id = d.company_id and location_id is distinct from d.location_id
              and changed_at > v_desde order by changed_at limit 5000) l
      left join public.sucursales s on s.id = l.location_id), '[]'));
end $$;

revoke all on function public.wx_club_recalcular_dia(uuid, uuid, date), public.wx_proyectar_club(public.devices, public.sucursales, jsonb), public.club_pull(jsonb) from public, anon, authenticated;
grant execute on function public.wx_club_recalcular_dia(uuid, uuid, date), public.wx_proyectar_club(public.devices, public.sucursales, jsonb), public.club_pull(jsonb) to service_role;

/* sync_ingest: igual que en 20261015120000, más MEMBERSHIP_PLAN, MEMBERSHIP, MEMBERSHIP_REDEMPTION,
   POINTS_CONFIG, STAMP_CARD y LOYALTY_LEDGER. */
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
                  else array['SALE', 'SHIFT', 'CASH_MOVEMENT', 'TRANSFER', 'PRODUCTION', 'WASTE', 'MEMBERSHIP_PLAN', 'MEMBERSHIP', 'MEMBERSHIP_REDEMPTION', 'POINTS_CONFIG', 'STAMP_CARD', 'LOYALTY_LEDGER'] end;
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
      -- 0063 · Club: planes, membresías y canjes (con marca de doble).
      if ev->>'aggregate_type' in ('MEMBERSHIP_PLAN', 'MEMBERSHIP', 'MEMBERSHIP_REDEMPTION', 'POINTS_CONFIG', 'STAMP_CARD', 'LOYALTY_LEDGER') then perform public.wx_proyectar_club(d, v_loc, v_ev); end if;
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


commit;
