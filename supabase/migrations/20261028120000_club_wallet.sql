-- ============================================================================
--  CLUB EN WALLET: la tarjeta del Club en Apple Wallet y Google Wallet.
--
--  Un pase por empresa y teléfono (los últimos 10 dígitos, igual que el Club
--  reconoce al cliente en las cajas). Su SERIAL (24 hex, aleatorio) es lo único
--  que viaja en el código del pase: `WXC-<serial>`.
--
--    club_wallet_marcas         colores y logo de la marca (los sube la caja)
--    club_wallet_pases          un pase por cliente; `sucio_en` = su Club cambió
--    club_wallet_dispositivos   los iPhone que registraron el pase (PassKit)
--
--  Cambios -> aviso: los triggers marcan `sucio_en` cuando llega un movimiento
--  de puntos o sellos, cambia una membresía, la configuración o la marca. El
--  ciclo `club-wallet {action:'notificar'}` (pg_cron, cada minuto, INACTIVO al
--  crearse) recalcula el pase y, si lo que enseña cambió, avisa a Apple y a
--  Google. Sin Vault no llama a nadie (falla cerrado).
--
--  Todo con la service role: la Edge Function club-wallet es la única puerta.
-- ============================================================================
begin;

create or replace function public.wx_tel10(t text) returns text
language sql immutable parallel safe as $$ select right(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 10) $$;

create table if not exists public.club_wallet_marcas (
  company_id uuid primary key references public.negocios(id) on delete cascade,
  fondo text not null check (fondo ~* '^#[0-9a-f]{6}$'),
  texto text not null check (texto ~* '^#[0-9a-f]{6}$'),
  etiqueta text not null check (etiqueta ~* '^#[0-9a-f]{6}$'),
  logo_png text check (length(logo_png) < 250000),
  icon_png text check (length(icon_png) < 250000),
  updated_at timestamptz not null default now()
);

create table if not exists public.club_wallet_pases (
  serial text primary key check (serial ~ '^[0-9a-f]{24}$'),
  company_id uuid not null references public.negocios(id) on delete cascade,
  phone_key text not null check (phone_key ~ '^[0-9]{10}$'),
  customer_name text,
  huella text,
  sucio_en timestamptz default now(),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_device uuid,
  unique (company_id, phone_key)
);
create index if not exists ix_club_wallet_pases_sucios on public.club_wallet_pases (sucio_en) where sucio_en is not null;
create index if not exists ix_club_wallet_pases_alta on public.club_wallet_pases (company_id, created_at);

create table if not exists public.club_wallet_dispositivos (
  device_library_id text not null check (length(device_library_id) between 1 and 64),
  serial text not null references public.club_wallet_pases(serial) on delete cascade,
  push_token text not null check (length(push_token) between 1 and 200),
  created_at timestamptz not null default now(),
  primary key (device_library_id, serial)
);
create index if not exists ix_club_wallet_disp_token on public.club_wallet_dispositivos (push_token);
create index if not exists ix_club_wallet_disp_serial on public.club_wallet_dispositivos (serial);

/* El saldo de un cliente se suma por teléfono: sin índice, cada pase recorrería el libro. */
create index if not exists ix_club_ledger_tel on public.club_ledger (company_id, public.wx_tel10(phone));
create index if not exists ix_club_memberships_tel on public.club_memberships (company_id, public.wx_tel10(phone));

alter table public.club_wallet_marcas enable row level security;
alter table public.club_wallet_pases enable row level security;
alter table public.club_wallet_dispositivos enable row level security;
revoke all on public.club_wallet_marcas, public.club_wallet_pases, public.club_wallet_dispositivos from public, anon, authenticated;

/* ---------------------------------------------------------------- triggers */

create or replace function public.wx_club_wallet_sucio_tel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.club_wallet_pases set sucio_en = clock_timestamp()
   where company_id = new.company_id and phone_key = public.wx_tel10(new.phone);
  return null;
end $$;

create or replace function public.wx_club_wallet_sucio_empresa() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.club_wallet_pases set sucio_en = clock_timestamp() where company_id = new.company_id;
  return null;
end $$;

drop trigger if exists tg_club_wallet_ledger on public.club_ledger;
create trigger tg_club_wallet_ledger after insert on public.club_ledger for each row execute function public.wx_club_wallet_sucio_tel();
drop trigger if exists tg_club_wallet_membresia on public.club_memberships;
create trigger tg_club_wallet_membresia after insert or update on public.club_memberships for each row execute function public.wx_club_wallet_sucio_tel();
drop trigger if exists tg_club_wallet_puntos on public.club_points_config;
create trigger tg_club_wallet_puntos after insert or update on public.club_points_config for each row execute function public.wx_club_wallet_sucio_empresa();
drop trigger if exists tg_club_wallet_tarjetas on public.club_stamp_cards;
create trigger tg_club_wallet_tarjetas after insert or update on public.club_stamp_cards for each row execute function public.wx_club_wallet_sucio_empresa();
drop trigger if exists tg_club_wallet_planes on public.club_plans;
create trigger tg_club_wallet_planes after insert or update on public.club_plans for each row execute function public.wx_club_wallet_sucio_empresa();
drop trigger if exists tg_club_wallet_marca on public.club_wallet_marcas;
create trigger tg_club_wallet_marca after insert or update on public.club_wallet_marcas for each row execute function public.wx_club_wallet_sucio_empresa();

/* ------------------------------------------------------------- la caja */

create or replace function public.wx_club_wallet_equipo(p jsonb) returns public.devices
language sql stable security definer set search_path = public as $$
  select d.* from public.devices d
   where d.id = public.wx_uuid(p->>'device_id') and d.status = 'ACTIVE' and d.kind in ('POS_PRIMARY', 'POS_SECONDARY')
$$;

/* Un pase por teléfono: emitir dos veces da el mismo serial (el de `p.serial` solo se usa si es nuevo). */
create or replace function public.club_wallet_emitir(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.devices; v_tel text := public.wx_tel10(p->>'phone'); v_serial text; v_nuevo boolean;
begin
  d := public.wx_club_wallet_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if length(v_tel) <> 10 or coalesce(p->>'serial', '') !~ '^[0-9a-f]{24}$' then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  insert into public.club_wallet_pases as w (serial, company_id, phone_key, customer_name, created_device)
  values (p->>'serial', d.company_id, v_tel, nullif(left(p->>'customer_name', 120), ''), d.id)
  on conflict (company_id, phone_key) do update set customer_name = coalesce(excluded.customer_name, w.customer_name)
  returning w.serial, (w.serial = p->>'serial') into v_serial, v_nuevo;
  return jsonb_build_object('ok', true, 'serial', v_serial, 'nuevo', v_nuevo);
end $$;

create or replace function public.club_wallet_marca(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.devices;
begin
  d := public.wx_club_wallet_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  insert into public.club_wallet_marcas as m (company_id, fondo, texto, etiqueta, logo_png, icon_png)
  values (d.company_id, p->>'fondo', p->>'texto', p->>'etiqueta', p->>'logo_png', p->>'icon_png')
  on conflict (company_id) do update set fondo = excluded.fondo, texto = excluded.texto, etiqueta = excluded.etiqueta,
      logo_png = excluded.logo_png, icon_png = excluded.icon_png, updated_at = now()
    where (m.fondo, m.texto, m.etiqueta, coalesce(m.logo_png, ''), coalesce(m.icon_png, ''))
          is distinct from (excluded.fondo, excluded.texto, excluded.etiqueta, coalesce(excluded.logo_png, ''), coalesce(excluded.icon_png, ''));
  return jsonb_build_object('ok', true);
end $$;

/* La caja leyó `WXC-<serial>`: ¿de quién es? Solo si el pase es de SU empresa. */
create or replace function public.club_wallet_resolver(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.devices; w public.club_wallet_pases;
begin
  d := public.wx_club_wallet_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  select * into w from public.club_wallet_pases where serial = p->>'serial' and company_id = d.company_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'phone', w.phone_key, 'customer_name', w.customer_name);
end $$;

/* ---------------------------------------------------------- lo que enseña */

create or replace function public.club_wallet_estado(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare w public.club_wallet_pases; v_hoy date := (now() at time zone 'America/Mexico_City')::date; v_marca jsonb;
begin
  select * into w from public.club_wallet_pases where serial = p->>'serial';
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  select jsonb_build_object('fondo', m.fondo, 'texto', m.texto, 'etiqueta', m.etiqueta, 'logo_png', m.logo_png, 'icon_png', m.icon_png)
    into v_marca from public.club_wallet_marcas m where m.company_id = w.company_id;
  return jsonb_build_object(
    'ok', true, 'serial', w.serial, 'company_id', w.company_id,
    'negocio', (select n.nombre from public.negocios n where n.id = w.company_id),
    'socio', coalesce(w.customer_name,
               (select m.customer_name from public.club_memberships m where m.company_id = w.company_id and public.wx_tel10(m.phone) = w.phone_key and m.customer_name is not null order by m.changed_at desc limit 1),
               (select l.customer_name from public.club_ledger l where l.company_id = w.company_id and public.wx_tel10(l.phone) = w.phone_key and l.customer_name is not null order by l.changed_at desc limit 1)),
    'marca', v_marca,
    'puntos', jsonb_build_object(
      'activo', coalesce((select c.enabled from public.club_points_config c where c.company_id = w.company_id), false),
      'saldo', coalesce((select sum(l.delta) from public.club_ledger l where l.company_id = w.company_id and public.wx_tel10(l.phone) = w.phone_key and l.program = 'POINTS'), 0)),
    'sellos', coalesce((select jsonb_agg(jsonb_build_object('uuid', t.uuid, 'nombre', t.name, 'requeridos', t.stamps_required,
        'llevas', greatest(0, coalesce((select sum(l.delta) from public.club_ledger l where l.company_id = w.company_id and public.wx_tel10(l.phone) = w.phone_key
                                          and l.program = 'STAMPS' and l.card_uuid = t.uuid), 0))) order by t.name)
      from public.club_stamp_cards t where t.company_id = w.company_id and t.active), '[]'),
    'membresias', coalesce((select jsonb_agg(jsonb_build_object('plan', x.plan, 'hasta', x.paid_until, 'estado', x.estado) order by x.orden, x.paid_until desc nulls last)
      from (select coalesce(pl.name, 'Club') as plan, m.paid_until,
                   case when m.status = 'CANCELLED' then 'CANCELADA'
                        when m.paid_until + coalesce(pl.grace_days, 0) >= v_hoy then 'ACTIVA' else 'VENCIDA' end as estado,
                   case when m.status = 'CANCELLED' then 2 when m.paid_until + coalesce(pl.grace_days, 0) >= v_hoy then 0 else 1 end as orden
              from public.club_memberships m left join public.club_plans pl on pl.uuid = m.plan_uuid
             where m.company_id = w.company_id and public.wx_tel10(m.phone) = w.phone_key) x), '[]'),
    'actualizado', to_char(w.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end $$;

create or replace function public.club_wallet_logo(p jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('logo_png', coalesce(m.logo_png, m.icon_png)) from public.club_wallet_marcas m where m.company_id = public.wx_uuid(p->>'company_id')
$$;

/* -------------------------------------------------- web service de PassKit */

create or replace function public.club_wallet_registrar(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_nuevo boolean;
begin
  if not exists (select 1 from public.club_wallet_pases where serial = p->>'serial') then return jsonb_build_object('ok', false); end if;
  insert into public.club_wallet_dispositivos as x (device_library_id, serial, push_token)
  values (p->>'device_library_id', p->>'serial', p->>'push_token')
  on conflict (device_library_id, serial) do update set push_token = excluded.push_token
  returning (xmax = 0) into v_nuevo;
  return jsonb_build_object('ok', true, 'nuevo', v_nuevo);
end $$;

create or replace function public.club_wallet_baja(p jsonb) returns jsonb
language sql security definer set search_path = public as $$
  with b as (delete from public.club_wallet_dispositivos where device_library_id = p->>'device_library_id' and serial = p->>'serial' returning 1)
  select jsonb_build_object('ok', true, 'bajas', (select count(*) from b))
$$;

/* APNs respondió 410: ese token ya no existe en ningún pase. */
create or replace function public.club_wallet_baja_token(p jsonb) returns jsonb
language sql security definer set search_path = public as $$
  with b as (delete from public.club_wallet_dispositivos where push_token = p->>'push_token' returning 1)
  select jsonb_build_object('ok', true, 'bajas', (select count(*) from b))
$$;

/* Los pases de un iPhone que cambiaron desde `desde` (milisegundos: la etiqueta que Apple guarda). */
create or replace function public.club_wallet_seriales(p jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ok', true,
    'serials', coalesce(jsonb_agg(w.serial order by w.serial), '[]'),
    'ultimo', coalesce(max(floor(extract(epoch from w.updated_at) * 1000))::bigint, 0))
    from public.club_wallet_dispositivos x join public.club_wallet_pases w on w.serial = x.serial
   where x.device_library_id = p->>'device_library_id'
     and (p->>'desde' is null or floor(extract(epoch from w.updated_at) * 1000) > (p->>'desde')::numeric)
$$;

/* --------------------------------------------------------- ciclo de avisos */

create or replace function public.club_wallet_pendientes(p jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ok', true, 'pases', coalesce(jsonb_agg(jsonb_build_object('serial', w.serial, 'visto', w.sucio_en,
           'tokens', coalesce((select jsonb_agg(distinct x.push_token) from public.club_wallet_dispositivos x where x.serial = w.serial), '[]'))), '[]'))
    from (select * from public.club_wallet_pases where sucio_en is not null order by sucio_en
           limit least(greatest(coalesce((p->>'limite')::int, 200), 1), 500)) w
$$;

/* Lo recalculado: si la huella cambió, el pase tiene fecha nueva (Apple la pide con passesUpdatedSince).
   Solo se limpia `sucio_en` si nadie lo volvió a ensuciar mientras se calculaba. */
create or replace function public.club_wallet_marcar(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare w public.club_wallet_pases; v_cambio boolean;
begin
  select * into w from public.club_wallet_pases where serial = p->>'serial' for update;
  if not found then return jsonb_build_object('ok', false); end if;
  v_cambio := w.huella is distinct from (p->>'huella');
  update public.club_wallet_pases
     set huella = p->>'huella',
         updated_at = case when v_cambio then now() else updated_at end,
         sucio_en = case when sucio_en <= coalesce(nullif(p->>'visto', '')::timestamptz, sucio_en) then null else sucio_en end
   where serial = w.serial
   returning * into w;
  return jsonb_build_object('ok', true, 'cambio', v_cambio, 'actualizado', to_char(w.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end $$;

/* ------------------------------------------------- club_pull + pases */

/* club_pull: igual que en 20261019120000, más `wallet_passes` (serial -> teléfono)
   para que cualquier caja de la empresa reconozca un pase sin internet. */
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
      left join public.sucursales s on s.id = l.location_id), '[]'),
    'wallet_passes', coalesce((select jsonb_agg(jsonb_build_object('serial', w.serial, 'phone', w.phone_key, 'customer_name', w.customer_name))
      from (select * from public.club_wallet_pases where company_id = d.company_id and created_at > v_desde order by created_at limit 3000) w), '[]'));
end $$;

/* ------------------------------------------------------------------ pg_cron */

do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then create extension if not exists pg_net; end if;
end $$;

create or replace function public.wx_club_wallet_disparar() returns void
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secreto text;
begin
  if not exists (select 1 from public.club_wallet_pases where sucio_en is not null) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'wybix_wallet_url';
  select decrypted_secret into v_secreto from vault.decrypted_secrets where name = 'wybix_webhook_secret';
  if v_url is null or v_url !~ '^https?://' or coalesce(length(v_secreto), 0) < 32 then
    raise warning 'club-wallet: falta configuración en Vault; no se dispara el ciclo';
    return;
  end if;
  perform net.http_post(url := v_url, body := '{"action":"notificar"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secreto),
    timeout_milliseconds := 25000);
exception when others then
  raise warning 'club-wallet: no se pudo disparar el ciclo (sqlstate %)', sqlstate;
end $$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if exists (select 1 from cron.job where jobname = 'wybix-club-wallet') then perform cron.unschedule('wybix-club-wallet'); end if;
    perform cron.schedule('wybix-club-wallet', '* * * * *', 'select public.wx_club_wallet_disparar()');
    perform cron.alter_job((select jobid from cron.job where jobname = 'wybix-club-wallet'), active := false);
  else
    raise notice 'pg_cron no está disponible aquí: el ciclo de la tarjeta en Wallet no se programa';
  end if;
end $$;

/* --------------------------------------------------------------- permisos */

revoke all on function public.wx_tel10(text), public.wx_club_wallet_sucio_tel(), public.wx_club_wallet_sucio_empresa(),
  public.wx_club_wallet_equipo(jsonb), public.club_wallet_emitir(jsonb), public.club_wallet_marca(jsonb), public.club_wallet_resolver(jsonb),
  public.club_wallet_estado(jsonb), public.club_wallet_logo(jsonb), public.club_wallet_registrar(jsonb), public.club_wallet_baja(jsonb),
  public.club_wallet_baja_token(jsonb), public.club_wallet_seriales(jsonb), public.club_wallet_pendientes(jsonb), public.club_wallet_marcar(jsonb),
  public.club_pull(jsonb), public.wx_club_wallet_disparar() from public, anon, authenticated;
grant execute on function public.wx_tel10(text), public.club_wallet_emitir(jsonb), public.club_wallet_marca(jsonb), public.club_wallet_resolver(jsonb),
  public.club_wallet_estado(jsonb), public.club_wallet_logo(jsonb), public.club_wallet_registrar(jsonb), public.club_wallet_baja(jsonb),
  public.club_wallet_baja_token(jsonb), public.club_wallet_seriales(jsonb), public.club_wallet_pendientes(jsonb), public.club_wallet_marcar(jsonb),
  public.club_pull(jsonb), public.wx_club_wallet_disparar() to service_role;

commit;
