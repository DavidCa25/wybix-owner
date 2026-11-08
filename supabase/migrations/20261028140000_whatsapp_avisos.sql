-- ============================================================================
--  AVISOS POR WHATSAPP AL CLIENTE FINAL
--
--    PEDIDO_LISTO           la caja avisa que la comanda del pedido quedó
--                           LISTA (POS 0068 -> función whatsapp-avisos).
--    MEMBRESIA_POR_VENCER   X días antes de paid_until (club_memberships).
--    MEMBRESIA_VENCE_HOY    el día de paid_until.
--
--  * wa_settings: lo enciende/apaga el negocio por tipo de aviso, y cuántos
--    días antes se avisa la membresía. Sin fila = TODO APAGADO.
--  * wa_optouts: un teléfono que pidió no recibir avisos de ESE negocio
--    (botón «Ya no recibir avisos», texto BAJA, o la caja a petición del
--    cliente). Se respeta al encolar y otra vez al enviar.
--  * wa_messages: UNA fila por aviso y su estado (PENDING -> SENDING -> SENT
--    -> DELIVERED -> READ, o FAILED / SKIPPED con motivo).
--    unique(company_id, kind, ref_key) = el mismo aviso nunca sale dos veces:
--      PEDIDO_LISTO          ref_key = id del aviso que generó la caja (uuid)
--      MEMBRESIA_*           ref_key = <membresía>:<paid_until>; renovar
--                            cambia paid_until y abre un ciclo nuevo.
--  * Vigencia: un «pedido listo» de hace una hora ya no sirve (30 min); un
--    aviso de membresía vale el día (24 h). Lo vencido queda SKIPPED/VENCIDA.
--  * El teléfono se guarda normalizado (solo dígitos, con lada: 52 + 10 en
--    México) para que el opt-out empate con lo que devuelve WhatsApp.
--  * NÚMERO DEL NEGOCIO (opción B): cada negocio conecta SU cuenta de
--    WhatsApp Business (WABA) con Embedded Signup de Meta; Wybix es Tech
--    Provider. wa_cuentas guarda su waba_id, phone_number_id, el estado de
--    sus plantillas y su token CIFRADO (AES-GCM en la función, con la llave
--    WHATSAPP_CLAVE_TOKENS que nunca entra a la base). Sin cuenta ACTIVA y
--    sin la plantilla APROBADA en esa WABA, no se encola nada.
--    wa_conexiones: el enlace de un solo uso (30 min) que la caja principal
--    abre en el navegador para conectar; solo se guarda el sha256.
--
--  Solo service_role toca estas tablas: la caja entra por la función
--  whatsapp-avisos (credencial del equipo -> device_autenticar) y Meta por
--  whatsapp-webhook (firma HMAC). Idempotente.
-- ============================================================================
begin;

-- ---------------------------------------------------------------- ajustes
create table if not exists public.wa_settings (
  company_id uuid primary key references public.negocios(id) on delete cascade,
  pedido_listo boolean not null default false,
  membresia boolean not null default false,
  dias_antes int not null default 3 check (dias_antes between 1 and 15),
  como_renovar text not null default 'paga tu mensualidad en caja' check (length(como_renovar) between 3 and 120),
  updated_at timestamptz not null default now(),
  updated_by_device uuid
);

/* La cuenta de WhatsApp de cada negocio. plantillas: nombre -> estado en Meta
   (APPROVED, PENDING, REJECTED, PAUSED, DISABLED, NO_CREADA). */
create table if not exists public.wa_cuentas (
  company_id uuid primary key references public.negocios(id) on delete cascade,
  status text not null default 'ACTIVA' check (status in ('ACTIVA', 'ERROR', 'DESCONECTADA')),
  waba_id text not null check (waba_id ~ '^\d{5,25}$'),
  phone_number_id text not null check (phone_number_id ~ '^\d{5,25}$'),
  display_phone text,
  verified_name text,
  token_cifrado text,
  pin_cifrado text,
  plantillas jsonb not null default '{}',
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_device uuid
);
/* Un número de Meta pertenece a un solo negocio a la vez. */
create unique index if not exists ux_wa_cuentas_numero on public.wa_cuentas (phone_number_id) where status <> 'DESCONECTADA';
create index if not exists ix_wa_cuentas_waba on public.wa_cuentas (waba_id);

create table if not exists public.wa_conexiones (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  company_id uuid not null references public.negocios(id) on delete cascade,
  device_id uuid not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ix_wa_conexiones_company on public.wa_conexiones (company_id, created_at desc);

create table if not exists public.wa_optouts (
  company_id uuid not null references public.negocios(id) on delete cascade,
  phone text not null,
  source text not null check (source in ('BOTON', 'TEXTO', 'CAJA')),
  created_at timestamptz not null default now(),
  primary key (company_id, phone)
);

create table if not exists public.wa_messages (
  id bigserial primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid,
  kind text not null check (kind in ('PEDIDO_LISTO', 'MEMBRESIA_POR_VENCER', 'MEMBRESIA_VENCE_HOY')),
  ref_key text not null,
  phone text not null,
  template text not null,
  lang text not null default 'es_MX',
  params jsonb not null default '[]',
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  expires_at timestamptz not null,
  provider text,
  provider_ref text,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  unique (company_id, kind, ref_key)
);
create index if not exists ix_wa_messages_cola on public.wa_messages (status, next_attempt_at);
create index if not exists ix_wa_messages_ref on public.wa_messages (provider_ref) where provider_ref is not null;
create index if not exists ix_wa_messages_company on public.wa_messages (company_id, created_at desc);
create index if not exists ix_wa_messages_phone on public.wa_messages (phone, created_at desc);

/* Cuándo corrió por última vez el planeador de membresías (una vez por hora). */
create table if not exists public.wa_planner_state (
  id int primary key default 1 check (id = 1),
  last_run timestamptz
);
insert into public.wa_planner_state (id) values (1) on conflict (id) do nothing;

alter table public.wa_settings enable row level security;
alter table public.wa_optouts enable row level security;
alter table public.wa_messages enable row level security;
alter table public.wa_planner_state enable row level security;
alter table public.wa_cuentas enable row level security;
alter table public.wa_conexiones enable row level security;
revoke all on public.wa_settings, public.wa_optouts, public.wa_messages, public.wa_planner_state, public.wa_cuentas, public.wa_conexiones from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.wa_settings, public.wa_optouts, public.wa_messages, public.wa_planner_state, public.wa_cuentas, public.wa_conexiones from anon, authenticated;
    revoke all on sequence public.wa_messages_id_seq from anon, authenticated;
  end if;
end $$;

-- ------------------------------------------------------------- teléfono
/* Solo dígitos, con lada. México: 10 dígitos -> 52 + 10; el 521 heredado de
   los celulares (lo que a veces devuelve WhatsApp) -> 52 + 10. Otro país:
   tal cual si mide 11-15 dígitos. Lo demás no es un teléfono: null. */
create or replace function public.wa_tel(p text) returns text language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
begin
  if d ~ '^00' then d := substr(d, 3); end if;
  if length(d) = 10 then return '52' || d; end if;
  if length(d) = 13 and d ~ '^521' then return '52' || substr(d, 4); end if;
  if length(d) between 11 and 15 then return d; end if;
  return null;
end $$;

/* El equipo de caja activo, de empresa y sucursal activas (o nada). */
create or replace function public.wx_wa_equipo(p jsonb) returns public.devices
language plpgsql stable security definer set search_path = public as $$
declare d public.devices%rowtype;
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE'
     and kind in ('POS_PRIMARY', 'POS_SECONDARY');
  if d.id is null or not exists (select 1 from public.negocios where id = d.company_id and status = 'ACTIVE')
     or not exists (select 1 from public.sucursales where id = d.location_id and status = 'ACTIVE') then
    return null;
  end if;
  return d;
end $$;

-- ------------------------------------------------------ cuenta del negocio
/* Lo que la caja puede ver de la cuenta: nunca el token ni el PIN. */
create or replace function public.wa_cuenta_publica(p_company uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when c.company_id is null or c.status = 'DESCONECTADA' then null else jsonb_build_object(
    'status', c.status, 'telefono', c.display_phone, 'nombre', c.verified_name,
    'plantillas', c.plantillas, 'error', c.last_error, 'conectada', c.connected_at) end
    from (select 1) x left join public.wa_cuentas c on c.company_id = p_company;
$$;

/* ¿Puede salir esta plantilla por la cuenta de este negocio? */
create or replace function public.wa_plantilla_lista(p_company uuid, p_template text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.wa_cuentas where company_id = p_company and status = 'ACTIVA'
                    and plantillas->>p_template = 'APPROVED');
$$;

/* La caja principal pide conectar (o se desconecta); cualquier caja consulta.
   p.accion: 'iniciar' (p.token_hash = sha256 del enlace de un solo uso),
   'estado', 'desconectar'. */
create or replace function public.wa_conexion(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; v_hash text := lower(coalesce(p->>'token_hash', ''));
begin
  d := public.wx_wa_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if p->>'accion' in ('iniciar', 'desconectar') and d.kind <> 'POS_PRIMARY' then
    return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY');
  end if;
  if p->>'accion' = 'iniciar' then
    if v_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
    /* Un enlace vivo a la vez: el anterior deja de servir. */
    update public.wa_conexiones set used_at = now() where company_id = d.company_id and used_at is null;
    if (select count(*) from public.wa_conexiones where company_id = d.company_id and created_at > now() - interval '1 hour') >= 10 then
      return jsonb_build_object('ok', false, 'code', 'RATE_LIMIT');
    end if;
    insert into public.wa_conexiones (token_hash, company_id, device_id, expires_at)
    values (v_hash, d.company_id, d.id, now() + interval '30 minutes');
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'WHATSAPP_CONECTAR', 'OK', '{}'::jsonb);
  elsif p->>'accion' = 'desconectar' then
    update public.wa_cuentas set status = 'DESCONECTADA', token_cifrado = null, pin_cifrado = null,
           updated_at = now(), updated_by_device = d.id
     where company_id = d.company_id;
    update public.wa_messages set status = 'SKIPPED', last_error = 'SIN_NUMERO', lease_until = null
     where company_id = d.company_id and status = 'PENDING';
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'WHATSAPP_DESCONECTAR', 'OK', '{}'::jsonb);
  elsif p->>'accion' is distinct from 'estado' then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  return jsonb_build_object('ok', true, 'cuenta', public.wa_cuenta_publica(d.company_id), 'company_id', d.company_id,
                            'principal', d.kind = 'POS_PRIMARY');
end $$;

/* La página de conexión, con el enlace: ¿sigue vivo? ¿de qué negocio es? */
create or replace function public.wa_conexion_sesion(p_hash text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare k public.wa_conexiones%rowtype;
begin
  select * into k from public.wa_conexiones where token_hash = lower(coalesce(p_hash, ''));
  if k.token_hash is null or k.used_at is not null or k.expires_at < now()
     or not exists (select 1 from public.negocios where id = k.company_id and status = 'ACTIVE') then
    return jsonb_build_object('ok', false, 'code', 'ENLACE_VENCIDO');
  end if;
  return jsonb_build_object('ok', true, 'company_id', k.company_id,
    'negocio', (select nombre from public.negocios where id = k.company_id),
    'cuenta', public.wa_cuenta_publica(k.company_id));
end $$;

/* Meta terminó el Embedded Signup y la función ya canjeó el código: se
   gasta el enlace y se guarda la cuenta. Token y PIN llegan cifrados. */
create or replace function public.wa_conexion_guardar(p_hash text, p_waba text, p_numero text, p_telefono text, p_nombre text,
                                                      p_token_cifrado text, p_pin_cifrado text, p_plantillas jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_company uuid; v_device uuid;
begin
  if coalesce(p_waba, '') !~ '^\d{5,25}$' or coalesce(p_numero, '') !~ '^\d{5,25}$' or coalesce(length(p_token_cifrado), 0) < 20 then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  update public.wa_conexiones set used_at = now()
   where token_hash = lower(coalesce(p_hash, '')) and used_at is null and expires_at >= now()
  returning company_id, device_id into v_company, v_device;
  if v_company is null then return jsonb_build_object('ok', false, 'code', 'ENLACE_VENCIDO'); end if;
  if exists (select 1 from public.wa_cuentas where phone_number_id = p_numero and status <> 'DESCONECTADA' and company_id <> v_company) then
    return jsonb_build_object('ok', false, 'code', 'NUMERO_OCUPADO');
  end if;
  insert into public.wa_cuentas as c (company_id, status, waba_id, phone_number_id, display_phone, verified_name,
                                      token_cifrado, pin_cifrado, plantillas, last_error, connected_at, updated_at, updated_by_device)
  values (v_company, 'ACTIVA', p_waba, p_numero, left(p_telefono, 30), left(p_nombre, 120), p_token_cifrado, p_pin_cifrado,
          coalesce(p_plantillas, '{}'), null, now(), now(), v_device)
  on conflict (company_id) do update set status = 'ACTIVA', waba_id = excluded.waba_id, phone_number_id = excluded.phone_number_id,
      display_phone = excluded.display_phone, verified_name = excluded.verified_name, token_cifrado = excluded.token_cifrado,
      pin_cifrado = excluded.pin_cifrado, plantillas = excluded.plantillas, last_error = null, connected_at = now(),
      updated_at = now(), updated_by_device = excluded.updated_by_device;
  perform public.wx_audit('DEVICE', v_device::text, v_company, 'WHATSAPP_CONECTADA', 'OK',
                          jsonb_build_object('waba', p_waba, 'tel', '•••' || right(coalesce(p_telefono, ''), 4)));
  return jsonb_build_object('ok', true, 'company_id', v_company, 'cuenta', public.wa_cuenta_publica(v_company));
end $$;

/* El estado de las plantillas, por empresa (la caja refresca) o por WABA
   (webhook message_template_status_update). Mezcla, no reemplaza. */
create or replace function public.wa_cuenta_plantillas(p_company uuid default null, p_waba text default null, p_plantillas jsonb default '{}')
returns int language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  if jsonb_typeof(p_plantillas) is distinct from 'object' then return 0; end if;
  update public.wa_cuentas set plantillas = plantillas || p_plantillas, updated_at = now()
   where status <> 'DESCONECTADA' and ((p_company is not null and company_id = p_company) or (p_waba is not null and waba_id = p_waba));
  get diagnostics n = row_count;
  return n;
end $$;

/* Meta avisa que la cuenta cambió (el negocio quitó a Wybix, la cuenta se
   bloqueó) o el envío vio un token inválido. */
create or replace function public.wa_cuenta_estado(p_company uuid default null, p_waba text default null, p_status text default 'ERROR', p_error text default null)
returns int language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  if p_status not in ('ACTIVA', 'ERROR', 'DESCONECTADA') then return 0; end if;
  update public.wa_cuentas set status = p_status, last_error = left(p_error, 300), updated_at = now(),
         token_cifrado = case when p_status = 'DESCONECTADA' then null else token_cifrado end,
         pin_cifrado = case when p_status = 'DESCONECTADA' then null else pin_cifrado end
   where status <> 'DESCONECTADA' and ((p_company is not null and company_id = p_company) or (p_waba is not null and waba_id = p_waba));
  get diagnostics n = row_count;
  return n;
end $$;

/* Lo que la función necesita para mandar por la cuenta del negocio. */
create or replace function public.wa_credencial(p_company uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('status', status, 'waba_id', waba_id, 'phone_number_id', phone_number_id,
                            'token_cifrado', token_cifrado, 'pin_cifrado', pin_cifrado, 'plantillas', plantillas)
    from public.wa_cuentas where company_id = p_company and status <> 'DESCONECTADA';
$$;

-- ---------------------------------------------------------------- ajustes
/* Leer (cualquier caja) o guardar (solo la principal) los ajustes. */
create or replace function public.wa_config(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; s public.wa_settings%rowtype; c jsonb := p->'config';
begin
  d := public.wx_wa_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if p->>'accion' = 'guardar' then
    if d.kind <> 'POS_PRIMARY' then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
    if c is null or jsonb_typeof(c) <> 'object'
       or coalesce((c->>'dias_antes')::int, 3) not between 1 and 15
       or length(coalesce(nullif(trim(c->>'como_renovar'), ''), 'paga tu mensualidad en caja')) not between 3 and 120 then
      return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
    end if;
    insert into public.wa_settings as w (company_id, pedido_listo, membresia, dias_antes, como_renovar, updated_at, updated_by_device)
    values (d.company_id, coalesce((c->>'pedido_listo')::boolean, false), coalesce((c->>'membresia')::boolean, false),
            coalesce((c->>'dias_antes')::int, 3),
            /* Una línea y sin punto final: la plantilla ya pone el suyo. */
            regexp_replace(regexp_replace(coalesce(nullif(trim(c->>'como_renovar'), ''), 'paga tu mensualidad en caja'), '[\r\n\t]+', ' ', 'g'), '[\s.;,]+$', ''),
            now(), d.id)
    on conflict (company_id) do update set pedido_listo = excluded.pedido_listo, membresia = excluded.membresia,
        dias_antes = excluded.dias_antes, como_renovar = excluded.como_renovar, updated_at = now(), updated_by_device = d.id;
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'WHATSAPP_CONFIG', 'OK', c);
  end if;
  select * into s from public.wa_settings where company_id = d.company_id;
  return jsonb_build_object('ok', true, 'config', jsonb_build_object(
    'pedido_listo', coalesce(s.pedido_listo, false), 'membresia', coalesce(s.membresia, false),
    'dias_antes', coalesce(s.dias_antes, 3), 'como_renovar', coalesce(s.como_renovar, 'paga tu mensualidad en caja'),
    'updated_at', s.updated_at),
    'principal', d.kind = 'POS_PRIMARY', 'cuenta', public.wa_cuenta_publica(d.company_id));
end $$;

-- ------------------------------------------------------------ pedido listo
/* La caja avisa que un pedido quedó listo. Encola (o reconoce) el aviso.
   Devuelve code:
     ENCOLADO      nuevo, va a salir          YA          ese id ya se encoló
     DESACTIVADO   el negocio lo tiene apagado
     SIN_NUMERO    el negocio no tiene su WhatsApp conectado (o falló)
     PLANTILLA_PENDIENTE  Meta aún no aprueba la plantilla en su WABA
     OPT_OUT      ese teléfono pidió no recibir avisos (queda registrado SKIPPED)
     TEL_INVALIDO  no es un teléfono          RATE_LIMIT  más de 300 en una hora
   p: device_id, id (uuid del aviso en la caja), numero, telefono, url (opcional). */
create or replace function public.wa_pedido_listo(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; k uuid := public.wx_uuid(p->>'id'); v_tel text := public.wa_tel(p->>'telefono');
        v_num int; v_url text := nullif(trim(coalesce(p->>'url', '')), ''); v_neg text; m public.wa_messages%rowtype;
        v_opt boolean;
begin
  d := public.wx_wa_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  begin v_num := (p->>'numero')::int; exception when others then v_num := null; end;
  if k is null or v_num is null or v_num < 1 or v_num > 99999 then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  if v_tel is null then return jsonb_build_object('ok', false, 'code', 'TEL_INVALIDO'); end if;
  /* La dirección de seguimiento es la del Local Host (red del local): solo http(s), sin espacios. */
  if v_url is not null and (v_url !~ '^https?://[^\s]+$' or length(v_url) > 200) then v_url := null; end if;

  select * into m from public.wa_messages where company_id = d.company_id and kind = 'PEDIDO_LISTO' and ref_key = k::text;
  if found then
    return jsonb_build_object('ok', true, 'code', 'YA', 'message_id', m.id, 'status', m.status);
  end if;
  if not coalesce((select pedido_listo from public.wa_settings where company_id = d.company_id), false) then
    return jsonb_build_object('ok', false, 'code', 'DESACTIVADO');
  end if;
  if not exists (select 1 from public.wa_cuentas where company_id = d.company_id and status = 'ACTIVA') then
    return jsonb_build_object('ok', false, 'code', 'SIN_NUMERO');
  end if;
  /* Con enlace solo si esa plantilla ya está aprobada en la WABA del negocio;
     si no, la de sin enlace; si tampoco, no se encola. */
  if v_url is not null and not public.wa_plantilla_lista(d.company_id, 'wybix_pedido_listo_seguimiento') then v_url := null; end if;
  if v_url is null and not public.wa_plantilla_lista(d.company_id, 'wybix_pedido_listo') then
    return jsonb_build_object('ok', false, 'code', 'PLANTILLA_PENDIENTE');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('wa-pedido:' || d.company_id::text, 0));
  if (select count(*) from public.wa_messages where company_id = d.company_id and kind = 'PEDIDO_LISTO'
        and created_at > now() - interval '1 hour') >= 300 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMIT');
  end if;
  select nombre into v_neg from public.negocios where id = d.company_id;
  v_opt := exists (select 1 from public.wa_optouts where company_id = d.company_id and phone = v_tel);
  insert into public.wa_messages (company_id, location_id, kind, ref_key, phone, template, params, expires_at, status, last_error)
  values (d.company_id, d.location_id, 'PEDIDO_LISTO', k::text, v_tel,
          case when v_url is null then 'wybix_pedido_listo' else 'wybix_pedido_listo_seguimiento' end,
          case when v_url is null then jsonb_build_array(v_num::text, left(coalesce(v_neg, 'el negocio'), 60))
               else jsonb_build_array(v_num::text, left(coalesce(v_neg, 'el negocio'), 60), v_url) end,
          now() + interval '30 minutes',
          case when v_opt then 'SKIPPED' else 'PENDING' end,
          case when v_opt then 'OPT_OUT' end)
  on conflict (company_id, kind, ref_key) do nothing
  returning * into m;
  if m.id is null then   -- otra petición con el mismo id ganó la carrera
    select * into m from public.wa_messages where company_id = d.company_id and kind = 'PEDIDO_LISTO' and ref_key = k::text;
    return jsonb_build_object('ok', true, 'code', 'YA', 'message_id', m.id, 'status', m.status);
  end if;
  if v_opt then return jsonb_build_object('ok', false, 'code', 'OPT_OUT', 'message_id', m.id); end if;
  return jsonb_build_object('ok', true, 'code', 'ENCOLADO', 'message_id', m.id);
end $$;

-- ------------------------------------------------------------- membresías
/* Encola los avisos de membresía del día. Corre en cada ciclo del motor pero
   trabaja como mucho una vez por hora (wa_planner_state), y solo entre las
   9:00 y las 20:59 de la sucursal de la membresía: un recordatorio no
   despierta a nadie. `p_forzar` salta el «una vez por hora» y `p_ahora`
   finge la hora (pruebas). Devuelve cuántos encoló. */
drop function if exists public.wa_planear_membresias(boolean);
create or replace function public.wa_planear_membresias(p_forzar boolean default false, p_ahora timestamptz default null) returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int := 0; v_filas int; v_ahora timestamptz := coalesce(p_ahora, now());
begin
  if not p_forzar then
    update public.wa_planner_state set last_run = now()
     where id = 1 and (last_run is null or last_run < now() - interval '1 hour');
    if not found then return 0; end if;
  end if;

  with base as (
    select m.uuid, m.company_id, m.location_id, public.wa_tel(m.phone) as tel, m.paid_until, pl.name as plan,
           ws.dias_antes, ws.como_renovar, ng.nombre as negocio,
           (v_ahora at time zone coalesce(s.timezone, 'America/Mexico_City')) as ahora_local
      from public.club_memberships m
      join public.wa_settings ws on ws.company_id = m.company_id and ws.membresia
      join public.negocios ng on ng.id = m.company_id and ng.status = 'ACTIVE'
      left join public.club_plans pl on pl.uuid = m.plan_uuid
      left join public.sucursales s on s.id = m.location_id
     where m.status = 'ACTIVE' and m.paid_until is not null and m.phone is not null
       and m.paid_until between v_ahora::date - 2 and v_ahora::date + 16
  ), cand as (
    select b.*, b.ahora_local::date as hoy,
           case when b.paid_until = b.ahora_local::date then 'MEMBRESIA_VENCE_HOY'
                when b.paid_until > b.ahora_local::date and b.paid_until - b.ahora_local::date <= b.dias_antes then 'MEMBRESIA_POR_VENCER'
           end as kind
      from base b
     where b.tel is not null and extract(hour from b.ahora_local) between 9 and 20
  )
  insert into public.wa_messages (company_id, location_id, kind, ref_key, phone, template, params, expires_at, status, last_error)
  select c.company_id, c.location_id, c.kind, c.uuid::text || ':' || c.paid_until::text, c.tel,
         case c.kind when 'MEMBRESIA_VENCE_HOY' then 'wybix_membresia_vence_hoy' else 'wybix_membresia_por_vencer' end,
         case c.kind when 'MEMBRESIA_VENCE_HOY'
              then jsonb_build_array(left(coalesce(c.plan, 'del Club'), 60), left(c.negocio, 60), c.como_renovar)
              else jsonb_build_array(left(coalesce(c.plan, 'del Club'), 60), left(c.negocio, 60), to_char(c.paid_until, 'DD/MM/YYYY'), c.como_renovar) end,
         now() + interval '24 hours',
         case when o.phone is not null then 'SKIPPED' else 'PENDING' end,
         case when o.phone is not null then 'OPT_OUT' end
    from cand c
    left join public.wa_optouts o on o.company_id = c.company_id and o.phone = c.tel
   where c.kind is not null
     and public.wa_plantilla_lista(c.company_id, case c.kind when 'MEMBRESIA_VENCE_HOY' then 'wybix_membresia_vence_hoy' else 'wybix_membresia_por_vencer' end)
  on conflict (company_id, kind, ref_key) do nothing;
  get diagnostics v_filas = row_count;
  n := n + v_filas;
  return n;
end $$;

-- ------------------------------------------------------------------ envío
/* Arrienda hasta p_limite avisos listos para salir (2 minutos). Antes,
   descarta lo que ya no debe salir: vencido, teléfono dado de baja o el
   negocio apagó ese tipo de aviso después de encolarlo. */
create or replace function public.wa_tomar(p_limite int default 50)
returns setof public.wa_messages language plpgsql volatile security definer set search_path = public as $$
begin
  update public.wa_messages set status = 'SKIPPED', last_error = 'VENCIDA', lease_until = null
   where status in ('PENDING', 'SENDING') and expires_at < now() and (status = 'PENDING' or lease_until < now());
  update public.wa_messages w set status = 'SKIPPED', last_error = 'OPT_OUT', lease_until = null
   where w.status = 'PENDING' and exists (select 1 from public.wa_optouts o where o.company_id = w.company_id and o.phone = w.phone);
  update public.wa_messages w set status = 'SKIPPED', last_error = 'DESACTIVADO', lease_until = null
   where w.status = 'PENDING' and not exists (
     select 1 from public.wa_settings s where s.company_id = w.company_id
        and case when w.kind = 'PEDIDO_LISTO' then s.pedido_listo else s.membresia end);
  update public.wa_messages w set status = 'SKIPPED', last_error = 'SIN_NUMERO', lease_until = null
   where w.status = 'PENDING' and not exists (
     select 1 from public.wa_cuentas c where c.company_id = w.company_id and c.status = 'ACTIVA');
  return query
  update public.wa_messages m set status = 'SENDING', lease_until = now() + interval '2 minutes', attempts = m.attempts + 1
   where m.id in (select id from public.wa_messages
                   where ((status = 'PENDING' and next_attempt_at <= now()) or (status = 'SENDING' and lease_until < now()))
                     and expires_at >= now()
                   order by id limit p_limite for update skip locked)
  returning m.*;
end $$;

/* Toma UN aviso concreto (el que la caja acaba de encolar), para mandarlo sin
   esperar al ciclo. Mismas reglas que wa_tomar. */
create or replace function public.wa_tomar_uno(p_id bigint)
returns setof public.wa_messages language sql volatile security definer set search_path = public as $$
  update public.wa_messages m set status = 'SENDING', lease_until = now() + interval '2 minutes', attempts = m.attempts + 1
   where m.id = p_id and m.status = 'PENDING' and m.next_attempt_at <= now() and m.expires_at >= now()
     and not exists (select 1 from public.wa_optouts o where o.company_id = m.company_id and o.phone = m.phone)
     and exists (select 1 from public.wa_cuentas c where c.company_id = m.company_id and c.status = 'ACTIVA')
  returning m.*;
$$;

create or replace function public.wa_resultado(p_id bigint, p_ok boolean, p_ref text default null, p_error text default null,
                                               p_permanente boolean default false, p_proveedor text default null)
returns text language plpgsql volatile security definer set search_path = public as $$
declare m public.wa_messages%rowtype;
begin
  select * into m from public.wa_messages where id = p_id for update;
  if not found or m.status <> 'SENDING' then return 'IGNORADO'; end if;
  if p_ok then
    update public.wa_messages set status = 'SENT', provider_ref = left(p_ref, 200), provider = left(p_proveedor, 20),
           sent_at = now(), lease_until = null, last_error = null where id = p_id;
    return 'SENT';
  end if;
  if p_permanente or m.attempts >= 5 then
    update public.wa_messages set status = 'FAILED', last_error = left(p_error, 500), provider = left(p_proveedor, 20), lease_until = null where id = p_id;
    return 'FAILED';
  end if;
  update public.wa_messages set status = 'PENDING', last_error = left(p_error, 500), lease_until = null,
         next_attempt_at = now() + public.wx_notif_espera(m.attempts) where id = p_id;
  return 'RETRY';
end $$;

/* Estado que reporta Meta por webhook (sent, delivered, read, failed). Solo
   avanza: un «delivered» que llega después de «read» no lo baja. */
create or replace function public.wa_estado(p_ref text, p_estado text, p_error text default null)
returns text language plpgsql volatile security definer set search_path = public as $$
declare m public.wa_messages%rowtype;
        rango constant jsonb := '{"SENDING":0,"SENT":1,"DELIVERED":2,"READ":3}';
        v_nuevo text := case lower(p_estado) when 'sent' then 'SENT' when 'delivered' then 'DELIVERED'
                                             when 'read' then 'READ' when 'failed' then 'FAILED' end;
begin
  if v_nuevo is null or coalesce(p_ref, '') = '' then return 'IGNORADO'; end if;
  select * into m from public.wa_messages where provider_ref = p_ref for update;
  if not found then return 'DESCONOCIDO'; end if;
  if v_nuevo = 'FAILED' then
    if m.status in ('SENT', 'DELIVERED', 'SENDING') then
      update public.wa_messages set status = 'FAILED', last_error = left(coalesce(p_error, 'failed'), 500) where id = m.id;
      return 'FAILED';
    end if;
    return 'IGNORADO';
  end if;
  if not (rango ? m.status) or (rango->>v_nuevo)::int <= (rango->>m.status)::int then return 'IGNORADO'; end if;
  update public.wa_messages set status = v_nuevo,
         delivered_at = case when v_nuevo in ('DELIVERED', 'READ') then coalesce(delivered_at, now()) else delivered_at end,
         read_at = case when v_nuevo = 'READ' then now() else read_at end
   where id = m.id;
  return v_nuevo;
end $$;

-- ---------------------------------------------------------------- opt-out
/* El cliente pide no recibir más avisos (o volver a recibirlos).
   p.phone_number_id  el número del negocio que recibió la respuesta (Meta lo
                      manda en metadata): identifica al negocio sin adivinar.
   p.message_id       el aviso cuyo botón tocó: debe ser de ese mismo negocio
                      y de ese mismo teléfono.
   p.phone            quien respondió.
   p.alta = true      quita la baja (solo con texto ALTA o desde la caja). */
create or replace function public.wa_baja(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_tel text := public.wa_tel(p->>'phone'); v_src text := coalesce(p->>'source', 'TEXTO');
        v_alta boolean := coalesce((p->>'alta')::boolean, false); v_empresas uuid[]; v_company uuid; m public.wa_messages%rowtype;
begin
  if v_src not in ('BOTON', 'TEXTO') or v_tel is null then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  select company_id into v_company from public.wa_cuentas
   where phone_number_id = coalesce(p->>'phone_number_id', '') and status <> 'DESCONECTADA';
  if v_company is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if p ? 'message_id' then
    select * into m from public.wa_messages where id = (p->>'message_id')::bigint;
    /* El botón solo vale desde el teléfono al que se le mandó ese aviso, y por el número que lo mandó. */
    if m.id is null or m.phone <> v_tel or m.company_id <> v_company then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  end if;
  v_empresas := array[v_company];
  if v_empresas is null then return jsonb_build_object('ok', true, 'empresas', 0); end if;
  if v_alta then
    delete from public.wa_optouts where phone = v_tel and company_id = any (v_empresas);
  else
    insert into public.wa_optouts (company_id, phone, source)
    select unnest(v_empresas), v_tel, v_src on conflict (company_id, phone) do nothing;
    update public.wa_messages set status = 'SKIPPED', last_error = 'OPT_OUT', lease_until = null
     where phone = v_tel and company_id = any (v_empresas) and status = 'PENDING';
  end if;
  return jsonb_build_object('ok', true, 'empresas', coalesce(array_length(v_empresas, 1), 0), 'alta', v_alta);
end $$;

-- ------------------------------------------------------------ desde la caja
/* La caja: registro de avisos, consultar/dar de baja/reactivar un teléfono.
   p.accion: 'registro' | 'baja' | 'alta' | 'estado_tel'. */
create or replace function public.wa_caja(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; v_tel text := public.wa_tel(p->>'telefono'); v_lim int;
begin
  d := public.wx_wa_equipo(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if p->>'accion' = 'registro' then
    v_lim := least(greatest(coalesce((p->>'limite')::int, 100), 1), 300);
    return jsonb_build_object('ok', true,
      'resumen', (select jsonb_build_object(
          'enviados', count(*) filter (where status in ('SENT', 'DELIVERED', 'READ')),
          'leidos', count(*) filter (where status = 'READ'),
          'fallidos', count(*) filter (where status = 'FAILED'),
          'omitidos', count(*) filter (where status = 'SKIPPED'),
          'pendientes', count(*) filter (where status in ('PENDING', 'SENDING')))
        from public.wa_messages where company_id = d.company_id and created_at > now() - interval '30 days'),
      'bajas', (select count(*) from public.wa_optouts where company_id = d.company_id),
      'avisos', coalesce((select jsonb_agg(x order by x.id desc) from (
          select id, kind, status, last_error, provider,
                 /* El teléfono, enmascarado: el registro lo ve quien administra, no hace falta completo. */
                 '•••' || right(phone, 4) as telefono,
                 created_at, sent_at, delivered_at, read_at
            from public.wa_messages where company_id = d.company_id order by id desc limit v_lim) x), '[]'));
  end if;
  if v_tel is null then return jsonb_build_object('ok', false, 'code', 'TEL_INVALIDO'); end if;
  if p->>'accion' = 'baja' then
    insert into public.wa_optouts (company_id, phone, source) values (d.company_id, v_tel, 'CAJA') on conflict (company_id, phone) do nothing;
    update public.wa_messages set status = 'SKIPPED', last_error = 'OPT_OUT', lease_until = null
     where company_id = d.company_id and phone = v_tel and status = 'PENDING';
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'WHATSAPP_OPTOUT', 'OK', jsonb_build_object('tel', '•••' || right(v_tel, 4)));
  elsif p->>'accion' = 'alta' then
    delete from public.wa_optouts where company_id = d.company_id and phone = v_tel;
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'WHATSAPP_OPTIN', 'OK', jsonb_build_object('tel', '•••' || right(v_tel, 4)));
  elsif p->>'accion' is distinct from 'estado_tel' then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  return jsonb_build_object('ok', true, 'baja', exists (select 1 from public.wa_optouts where company_id = d.company_id and phone = v_tel));
end $$;

-- ---------------------------------------------------------------- permisos
do $$
declare f text;
begin
  foreach f in array array['wa_tel(text)', 'wx_wa_equipo(jsonb)', 'wa_config(jsonb)', 'wa_pedido_listo(jsonb)',
                           'wa_planear_membresias(boolean, timestamptz)', 'wa_tomar(integer)', 'wa_tomar_uno(bigint)',
                           'wa_resultado(bigint, boolean, text, text, boolean, text)', 'wa_estado(text, text, text)',
                           'wa_baja(jsonb)', 'wa_caja(jsonb)', 'wa_cuenta_publica(uuid)', 'wa_plantilla_lista(uuid, text)',
                           'wa_conexion(jsonb)', 'wa_conexion_sesion(text)',
                           'wa_conexion_guardar(text, text, text, text, text, text, text, jsonb)',
                           'wa_cuenta_plantillas(uuid, text, jsonb)', 'wa_cuenta_estado(uuid, text, text, text)',
                           'wa_credencial(uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon, authenticated', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function public.%s to service_role', f);
    end if;
  end loop;
end $$;

commit;
