-- ============================================================================
--  PANEL DE ADMINISTRACIÓN DE LA PLATAFORMA (wybixpos.com.mx/admin)
-- ----------------------------------------------------------------------------
--  Hasta aquí el panel era de SOLO LECTURA y se entraba con una contraseña
--  compartida (ADMIN_PASSWORD en Vercel). Esta migración lo convierte en la
--  consola de operación de Wybix:
--
--    IDENTIDAD   platform_admins: quién es administrador de la PLATAFORMA (no
--                de un negocio) y con qué rol. El usuario es uno de Supabase
--                Auth con segundo factor; la Edge Function `admin` exige el
--                JWT con aal2 y una fila activa aquí.
--    AUDITORÍA   admin_audit: cada acción (y cada intento denegado) deja una
--                fila. Solo se agrega: un trigger impide editar o borrar.
--    LÍMITE      admin_rate_hit: ventana deslizante por administrador, en la
--                base (las Edge Functions no comparten memoria).
--    COMANDOS    RPC nuevas para lo que no existía (suspender, emitir a mano,
--                cambiar titular u origen, bajar a MonoCaja, add-ons, pruebas,
--                equipos, apps, releases, menú en línea, adaptaciones).
--    CONSULTAS   admin_q_*: lecturas ya armadas para el panel. La lógica de
--                negocio vive en Postgres; la función solo enruta.
--
--  SEGURIDAD: igual que el licenciamiento v2. Tablas con RLS y sin políticas,
--  sin privilegios para anon ni authenticated. Funciones SECURITY DEFINER que
--  SOLO service_role ejecuta. El actor (`admin:<uuid>`) y el motivo viajan a
--  license_events además de a admin_audit.
--
--  Idempotente. Requiere el licenciamiento v2 (partes A y B), la Fase 1
--  (devices), el menú en línea y WhatsApp.
-- ============================================================================

-- ------------------------------------------------------------ administradores
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('OWNER', 'OPERATOR', 'VIEWER')),
  active     boolean not null default true,
  note       text,
  created_at timestamptz not null default now(),
  created_by text
);

-- ------------------------------------------------------------------ auditoría
create table if not exists public.admin_audit (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_id   uuid,
  actor_role text,
  action     text not null,
  target     text,
  reason     text,
  input      jsonb not null default '{}',
  result     jsonb,
  ok         boolean not null,
  ip         text,
  user_agent text
);
create index if not exists ix_admin_audit_at on public.admin_audit (at desc);
create index if not exists ix_admin_audit_target on public.admin_audit (target, at desc) where target is not null;

create or replace function public.admin_audit_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'admin_audit solo admite INSERT' using errcode = 'insufficient_privilege';
end $$;
drop trigger if exists tr_admin_audit_append_only on public.admin_audit;
create trigger tr_admin_audit_append_only before update or delete on public.admin_audit
  for each row execute function public.admin_audit_append_only();

-- ------------------------------------------------------------- límite de uso
create table if not exists public.admin_rate (
  actor_id uuid not null,
  bucket   timestamptz not null,
  hits     int not null default 0,
  primary key (actor_id, bucket)
);

-- ============================================================================
--  IDENTIDAD, AUDITORÍA Y LÍMITE
-- ============================================================================

/* El rol de un usuario, o null si no es administrador activo. */
create or replace function public.admin_whoami(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when a.user_id is null then null
              else jsonb_build_object('user_id', a.user_id, 'role', a.role) end
    from (select 1) x
    left join public.platform_admins a on a.user_id = p_user and a.active;
$$;

create or replace function public.admin_audit_log(
  p_actor uuid, p_role text, p_action text, p_target text, p_reason text,
  p_input jsonb, p_result jsonb, p_ok boolean, p_ip text, p_user_agent text)
returns void language sql security definer set search_path = public as $$
  insert into public.admin_audit (actor_id, actor_role, action, target, reason, input, result, ok, ip, user_agent)
  values (p_actor, p_role, p_action, nullif(p_target, ''), nullif(trim(p_reason), ''),
          coalesce(p_input, '{}'), p_result, p_ok, left(p_ip, 64), left(p_user_agent, 300));
$$;

/*
 * Cuenta una petición y dice si sigue dentro del límite: p_limit por
 * p_window_s segundos (cubetas de 10 s). Borra lo viejo de paso.
 */
create or replace function public.admin_rate_hit(p_actor uuid, p_limit int default 120, p_window_s int default 60)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_bucket timestamptz := to_timestamp(floor(extract(epoch from now()) / 10) * 10); v_total int;
begin
  insert into public.admin_rate (actor_id, bucket, hits) values (p_actor, v_bucket, 1)
  on conflict (actor_id, bucket) do update set hits = public.admin_rate.hits + 1;
  delete from public.admin_rate where bucket < now() - make_interval(secs => greatest(p_window_s, 10) * 2);
  select coalesce(sum(hits), 0) into v_total from public.admin_rate
   where actor_id = p_actor and bucket > now() - make_interval(secs => greatest(p_window_s, 10));
  return v_total <= p_limit;
end $$;

-- ============================================================================
--  COMANDOS DE LICENCIA (lo que faltaba en el licenciamiento v2)
-- ============================================================================

/* Motivo obligatorio para todo cambio administrativo. */
create or replace function public.admin_requiere_motivo(p_reason text, p_actor text)
returns jsonb language sql immutable as $$
  select case when coalesce(length(trim(p_reason)), 0) < 5 or coalesce(trim(p_actor), '') = ''
              then jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Falta el motivo (mínimo 5 letras) o quién lo autoriza.')
         end;
$$;

/*
 * Clave nueva WYBIX-XXXX-XXXX-XXXX con el alfabeto de la web (sin I, O, 0, 1).
 * gen_random_uuid() usa el generador criptográfico de Postgres; se toman solo
 * bytes sin los bits fijos de versión y variante (6 y 8).
 */
create or replace function public.license_new_key()
returns text language plpgsql volatile set search_path = public as $$
declare
  abc text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  h bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  idx int[] := array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13];
  k text := 'WYBIX';
  i int;
begin
  for i in 1..12 loop
    if (i - 1) % 4 = 0 then k := k || '-'; end if;
    k := k || substr(abc, (get_byte(h, idx[i]) % 32) + 1, 1);
  end loop;
  return k;
end $$;

/* Suspender, reactivar o cancelar. El POS se entera al refrescar (≤ 24 h con red). */
create or replace function public.license_set_status(p_license uuid, p_status text, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.licenses%rowtype; v_err jsonb := public.admin_requiere_motivo(p_reason, p_actor);
begin
  if v_err is not null then return v_err; end if;
  if p_status not in ('activa', 'suspendida', 'cancelada') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Estado desconocido.');
  end if;
  select * into l from public.licenses where id = p_license for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Licencia no encontrada.'); end if;
  if l.status = p_status then return jsonb_build_object('ok', true, 'unchanged', true, 'status', l.status); end if;
  update public.licenses set status = p_status where id = p_license;
  perform public.license_log(p_license, 'STATUS_CHANGED',
    jsonb_build_object('from', l.status, 'to', p_status, 'reason', p_reason), p_actor);
  return jsonb_build_object('ok', true, 'from', l.status, 'status', p_status);
end $$;

/* Clasificar una licencia: PRODUCTION, INTERNAL, QA o TEST. */
create or replace function public.license_set_origin(p_license uuid, p_origin text, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.licenses%rowtype; v_err jsonb := public.admin_requiere_motivo(p_reason, p_actor);
begin
  if v_err is not null then return v_err; end if;
  if p_origin not in ('PRODUCTION', 'INTERNAL', 'QA', 'TEST') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Origen desconocido.');
  end if;
  select * into l from public.licenses where id = p_license for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Licencia no encontrada.'); end if;
  if l.origin is not distinct from p_origin then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  update public.licenses set origin = p_origin where id = p_license;
  perform public.license_log(p_license, 'ORIGIN_CHANGED',
    jsonb_build_object('from', l.origin, 'to', p_origin, 'reason', p_reason), p_actor);
  return jsonb_build_object('ok', true, 'from', l.origin, 'origin', p_origin);
end $$;

/* Corregir los datos del titular (nombre, correo, teléfono, negocio). */
create or replace function public.license_update_customer(p_license uuid, p_customer jsonb, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  l public.licenses%rowtype;
  v_err jsonb := public.admin_requiere_motivo(p_reason, p_actor);
  v_name text := nullif(trim(p_customer->>'name'), '');
  v_email text := nullif(lower(trim(p_customer->>'email')), '');
  v_phone text := nullif(trim(p_customer->>'phone'), '');
  v_business text := nullif(trim(p_customer->>'business'), '');
begin
  if v_err is not null then return v_err; end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Correo inválido.');
  end if;
  select * into l from public.licenses where id = p_license for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Licencia no encontrada.'); end if;
  update public.licenses
     set customer_name  = case when p_customer ? 'name' then coalesce(v_name, customer_name) else customer_name end,
         customer_email = case when p_customer ? 'email' then v_email else customer_email end,
         customer_phone = case when p_customer ? 'phone' then v_phone else customer_phone end,
         negocio        = case when p_customer ? 'business' then v_business else negocio end
   where id = p_license;
  perform public.license_log(p_license, 'CUSTOMER_UPDATED', jsonb_build_object(
    'before', jsonb_build_object('name', l.customer_name, 'email', l.customer_email, 'phone', l.customer_phone, 'business', l.negocio),
    'changes', p_customer, 'reason', p_reason), p_actor);
  return jsonb_build_object('ok', true);
end $$;

/*
 * MultiCaja -> MonoCaja. Solo si queda a lo más UNA computadora activa: no
 * se decide aquí cuál caja deja de vender. Libera primero las demás.
 */
create or replace function public.license_downgrade_to_mono(p_license uuid, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.licenses%rowtype; v_activas int; v_err jsonb := public.admin_requiere_motivo(p_reason, p_actor);
begin
  if v_err is not null then return v_err; end if;
  select * into l from public.licenses where id = p_license for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Licencia no encontrada.'); end if;
  if l.plan = 'mono' then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  select count(*) into v_activas from public.license_activations where license_id = p_license and active;
  if v_activas > 1 then
    return jsonb_build_object('ok', false, 'code', 'DEVICES_OVER_LIMIT', 'active', v_activas,
      'error', format('Tiene %s computadoras activas. Libera las que sobran antes de pasar a MonoCaja.', v_activas));
  end if;
  update public.licenses set plan = 'mono', max_registers = public.license_legacy_max_registers('mono') where id = p_license;
  perform public.license_log(p_license, 'MULTI_TO_MONO', jsonb_build_object('reason', p_reason), p_actor);
  return jsonb_build_object('ok', true);
end $$;

/* Encender o apagar un complemento (MULTIBRANCH). */
create or replace function public.license_set_addon(p_license uuid, p_addon text, p_enabled boolean, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.licenses%rowtype; v_err jsonb := public.admin_requiere_motivo(p_reason, p_actor);
begin
  if v_err is not null then return v_err; end if;
  if p_addon not in ('MULTIBRANCH') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Complemento desconocido.');
  end if;
  select * into l from public.licenses where id = p_license for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Licencia no encontrada.'); end if;
  if (p_addon = any (l.addons)) = p_enabled then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  update public.licenses
     set addons = case when p_enabled then array_append(addons, p_addon) else array_remove(addons, p_addon) end
   where id = p_license;
  perform public.license_log(p_license, case when p_enabled then 'ADDON_ADDED' else 'ADDON_REMOVED' end,
    jsonb_build_object('addon', p_addon, 'reason', p_reason), p_actor);
  return jsonb_build_object('ok', true);
end $$;

/*
 * Emitir una licencia SIN pasar por PayPal: transferencia, efectivo o
 * cortesía. A diferencia de license_create_from_order, el importe no se
 * valida contra la cotización (lo decide el administrador y queda escrito):
 * el precio de lista sale del catálogo, lo pagado es lo que se capturó y la
 * diferencia se registra como descuento con su motivo.
 *
 *   p_order = { edition: EDITION_MONO|EDITION_MULTI, vertical: COMMERCE|…,
 *               origin: PRODUCTION|INTERNAL|QA|TEST,
 *               payment: { provider: TRANSFER|CASH|COURTESY, ref?, amount },
 *               customer: { name, email, phone, business },
 *               support: BASIC|PRIORITY, reason, actor }
 */
create or replace function public.license_issue_manual(p_order jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor text := p_order->>'actor';
  v_reason text := p_order->>'reason';
  v_err jsonb := public.admin_requiere_motivo(p_order->>'reason', p_order->>'actor');
  v_edition text := p_order->>'edition';
  v_vert text := upper(trim(coalesce(p_order->>'vertical', '')));
  v_origin text := coalesce(nullif(p_order->>'origin', ''), 'PRODUCTION');
  v_prov text := upper(trim(coalesce(p_order->'payment'->>'provider', '')));
  v_ref text := nullif(trim(p_order->'payment'->>'ref'), '');
  v_paid numeric := coalesce(nullif(p_order->'payment'->>'amount', '')::numeric, 0);
  v_support text := coalesce(nullif(p_order->>'support', ''), 'BASIC');
  v_cust jsonb := coalesce(p_order->'customer', '{}');
  v_plan text; v_list numeric; v_id uuid; v_key text; i int;
begin
  if v_err is not null then return v_err; end if;
  select edition, list_price into v_plan, v_list from public.license_catalog where code = v_edition and kind = 'EDITION';
  if v_plan is null then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Edición desconocida.'); end if;
  if v_vert not in ('COMMERCE', 'HOSPITALITY', 'SERVICES') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Elige el giro.');
  end if;
  if v_origin not in ('PRODUCTION', 'INTERNAL', 'QA', 'TEST') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Origen desconocido.');
  end if;
  if v_prov not in ('TRANSFER', 'CASH', 'COURTESY') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Forma de pago desconocida.');
  end if;
  if v_prov <> 'COURTESY' and (v_ref is null or v_paid <= 0) then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Un pago necesita referencia e importe.');
  end if;
  if v_prov = 'COURTESY' then v_paid := 0; end if;
  if v_support not in ('BASIC', 'PRIORITY') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Soporte desconocido.');
  end if;
  if coalesce(nullif(trim(v_cust->>'name'), ''), nullif(trim(v_cust->>'business'), '')) is null then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Falta el nombre del cliente o del negocio.');
  end if;
  -- Idempotente por referencia de pago: el mismo depósito no emite dos licencias.
  if v_ref is not null then
    select l.id, l.license_key into v_id, v_key from public.licenses l
     where exists (select 1 from public.license_purchases p where p.license_id = l.id and p.payment_provider = v_prov and p.payment_ref = v_ref)
     limit 1;
    if v_id is not null then
      return jsonb_build_object('ok', true, 'existing', true, 'license_id', v_id, 'license_key', v_key);
    end if;
  end if;

  for i in 1..5 loop
    v_key := public.license_new_key();
    begin
      insert into public.licenses (license_key, plan, max_registers, customer_name, customer_email, customer_phone,
                                   buyer_email, buyer_name, negocio, cajas, status, support_tier, origin, notes)
      values (v_key, v_plan, public.license_legacy_max_registers(v_plan),
              coalesce(nullif(trim(v_cust->>'name'), ''), trim(v_cust->>'business')),
              nullif(lower(trim(v_cust->>'email')), ''), nullif(trim(v_cust->>'phone'), ''),
              nullif(lower(trim(v_cust->>'email')), ''), nullif(trim(v_cust->>'name'), ''), nullif(trim(v_cust->>'business'), ''),
              1, 'activa', v_support, v_origin, 'Emitida desde el panel: ' || v_reason)
      returning id into v_id;
      exit;
    exception when unique_violation then
      v_id := null;
    end;
  end loop;
  if v_id is null then return jsonb_build_object('ok', false, 'code', 'KEY_CONFLICT', 'error', 'No se pudo generar una clave única.'); end if;

  insert into public.license_verticals (license_id, vertical, source) values (v_id, v_vert, 'ADMIN');
  perform public.license_record_purchase(v_id, 'INITIAL', v_edition, v_list, null,
    case when v_list is not null and v_paid < v_list then v_list - v_paid end, null,
    case when v_list is not null and v_paid < v_list then v_reason end,
    v_paid, v_prov, coalesce(v_ref, 'ADMIN-' || v_id::text),
    jsonb_build_object('vertical', v_vert, 'manual', true), v_actor);
  perform public.license_log(v_id, 'LICENSE_CREATED', jsonb_build_object(
    'edition', v_plan, 'vertical', v_vert, 'provider', v_prov, 'order_ref', v_ref, 'paid', v_paid,
    'origin', v_origin, 'manual', true, 'reason', v_reason), v_actor);
  return jsonb_build_object('ok', true, 'existing', false, 'license_id', v_id, 'license_key', v_key);
end $$;

/* Mover una adaptación de código por su flujo. */
create or replace function public.license_code_change_set_status(p_change uuid, p_status text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.license_code_changes%rowtype;
begin
  if p_status not in ('REGISTRADO', 'EN_PROCESO', 'ENTREGADO', 'CANCELADO') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Estado desconocido.');
  end if;
  select * into c from public.license_code_changes where id = p_change for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Adaptación no encontrada.'); end if;
  if c.status = p_status then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  update public.license_code_changes
     set status = p_status, delivered_at = case when p_status = 'ENTREGADO' then now() else delivered_at end
   where id = p_change;
  perform public.license_log(c.license_id, 'CODE_CHANGE_STATUS',
    jsonb_build_object('change_id', p_change, 'from', c.status, 'to', p_status), p_actor);
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================================
--  COMANDOS DE EQUIPOS, PRUEBAS Y APPS
-- ============================================================================

/* Extender (o reabrir) la prueba gratis de una computadora. */
create or replace function public.device_trial_extend(p_machine_id text, p_days int, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.device_trials%rowtype; v_err jsonb := public.admin_requiere_motivo(p_reason, p_actor); v_fin timestamptz;
begin
  if v_err is not null then return v_err; end if;
  if p_days is null or p_days < 1 or p_days > 90 then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Entre 1 y 90 días.');
  end if;
  select * into t from public.device_trials where machine_id = p_machine_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Esa computadora no tiene prueba.'); end if;
  v_fin := greatest(t.expires_at, now()) + make_interval(days => p_days);
  update public.device_trials set expires_at = v_fin, status = 'active' where id = t.id;
  perform public.license_log(null, 'TRIAL_EXTENDED', jsonb_build_object(
    'machine_id', p_machine_id, 'from', t.expires_at, 'to', v_fin, 'days', p_days, 'reason', p_reason), p_actor);
  return jsonb_build_object('ok', true, 'expires_at', v_fin);
end $$;

/* Revocar (o reactivar) la credencial de nube de un equipo (POS, pantalla, celular POS). */
create or replace function public.device_set_status(p_device uuid, p_status text, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; v_err jsonb := public.admin_requiere_motivo(p_reason, p_actor);
begin
  if v_err is not null then return v_err; end if;
  if p_status <> 'REVOKED' then
    -- Reactivar exige credencial nueva: la da el propio equipo al volver a enlazarse.
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Solo se puede revocar; el equipo se vuelve a enlazar desde el POS.');
  end if;
  select * into d from public.devices where id = p_device for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Equipo no encontrado.'); end if;
  if d.status = 'REVOKED' then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  update public.devices set status = 'REVOKED', revoked_at = now(), credential_hash = null where id = p_device;
  insert into public.cloud_audit (actor_kind, actor_id, company_id, action, result, detail)
  values ('USER', p_actor, d.company_id, 'ADMIN_DEVICE_REVOKED', 'OK',
          jsonb_build_object('device_id', p_device, 'kind', d.kind, 'reason', p_reason));
  return jsonb_build_object('ok', true);
end $$;

/* Cuántas apps del dueño puede tener un negocio. */
create or replace function public.owner_app_quota_set(p_negocio uuid, p_total int, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_err jsonb := public.admin_requiere_motivo(p_reason, p_actor); v_antes int;
begin
  if v_err is not null then return v_err; end if;
  if p_total is null or p_total < 1 or p_total > 50 then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Entre 1 y 50 apps.');
  end if;
  if not exists (select 1 from public.negocios where id = p_negocio) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Negocio no encontrado.');
  end if;
  select total_apps into v_antes from public.negocio_app_quota where negocio_id = p_negocio::text;
  insert into public.negocio_app_quota (negocio_id, total_apps, updated_at) values (p_negocio::text, p_total, now())
  on conflict (negocio_id) do update set total_apps = excluded.total_apps, updated_at = now();
  insert into public.cloud_audit (actor_kind, actor_id, company_id, action, result, detail)
  values ('USER', p_actor, p_negocio, 'ADMIN_APP_QUOTA', 'OK', jsonb_build_object('from', v_antes, 'to', p_total, 'reason', p_reason));
  return jsonb_build_object('ok', true, 'total_apps', p_total);
end $$;

/* Desactivar o reactivar una app del dueño (un celular). */
create or replace function public.owner_app_set_active(p_app uuid, p_active boolean, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.owner_apps%rowtype; v_err jsonb := public.admin_requiere_motivo(p_reason, p_actor);
begin
  if v_err is not null then return v_err; end if;
  select * into a from public.owner_apps where id = p_app for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'App no encontrada.'); end if;
  if a.active = p_active then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  update public.owner_apps set active = p_active where id = p_app;
  insert into public.cloud_audit (actor_kind, actor_id, company_id, action, result, detail)
  values ('USER', p_actor, (case when a.negocio_id ~ '^[0-9a-f-]{36}$' then a.negocio_id::uuid end),
          case when p_active then 'ADMIN_APP_ON' else 'ADMIN_APP_OFF' end, 'OK',
          jsonb_build_object('app_id', p_app, 'reason', p_reason));
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================================
--  COMANDOS DE PLATAFORMA: RELEASES Y MENÚ EN LÍNEA
-- ============================================================================

/* 1.2.3 -> {1,2,3}; null si no es semver simple. */
create or replace function public.admin_semver(p text)
returns int[] language sql immutable as $$
  select case when p ~ '^\d{1,4}\.\d{1,4}\.\d{1,4}$' then string_to_array(p, '.')::int[] end;
$$;

/* Publicar la versión de una app (hoy POS Mobile y la app del dueño leen app_releases). */
create or replace function public.app_release_upsert(p_app text, p_channel text, p_latest text, p_min text, p_notes text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.app_releases%rowtype;
begin
  if coalesce(p_app, '') !~ '^[a-z][a-z0-9-]{1,30}$' or p_channel not in ('production', 'beta') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'App o canal inválido.');
  end if;
  if public.admin_semver(p_latest) is null or public.admin_semver(p_min) is null then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Usa versiones con forma 1.2.3.');
  end if;
  if public.admin_semver(p_min) > public.admin_semver(p_latest) then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'La mínima no puede ser mayor que la última.');
  end if;
  select * into r from public.app_releases where app = p_app and channel = p_channel for update;
  if found and public.admin_semver(p_latest) < public.admin_semver(r.latest_version) then
    return jsonb_build_object('ok', false, 'code', 'DOWNGRADE', 'error', 'La versión nueva es menor que la publicada.');
  end if;
  insert into public.app_releases (app, channel, latest_version, min_supported_version, notes, published_at)
  values (p_app, p_channel, p_latest, p_min, nullif(trim(p_notes), ''), now())
  on conflict (app, channel) do update
    set latest_version = excluded.latest_version, min_supported_version = excluded.min_supported_version,
        notes = excluded.notes, published_at = now();
  insert into public.cloud_audit (actor_kind, actor_id, action, result, detail)
  values ('USER', p_actor, 'ADMIN_APP_RELEASE', 'OK', jsonb_build_object('app', p_app, 'channel', p_channel,
          'before', case when r.app is not null then jsonb_build_object('latest', r.latest_version, 'min', r.min_supported_version) end,
          'latest', p_latest, 'min', p_min));
  return jsonb_build_object('ok', true);
end $$;

/* Despublicar / volver a publicar un menú en línea, o cambiarle el slug. */
create or replace function public.menu_admin_update(p_location uuid, p_changes jsonb, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.menu_publicaciones%rowtype; v_err jsonb := public.admin_requiere_motivo(p_reason, p_actor);
        v_slug text := nullif(lower(trim(p_changes->>'slug')), '');
begin
  if v_err is not null then return v_err; end if;
  select * into m from public.menu_publicaciones where location_id = p_location for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Esa sucursal no tiene menú.'); end if;
  if p_changes ? 'slug' then
    if v_slug is null or v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' then
      return jsonb_build_object('ok', false, 'code', 'BAD_SLUG', 'error', 'Slug inválido: minúsculas, números y guiones (3 a 40).');
    end if;
    if exists (select 1 from public.menu_publicaciones where slug = v_slug and location_id <> p_location) then
      return jsonb_build_object('ok', false, 'code', 'SLUG_TAKEN', 'error', 'Ese slug ya lo usa otro negocio.');
    end if;
  end if;
  update public.menu_publicaciones
     set slug = case when p_changes ? 'slug' then v_slug else slug end,
         activo = case when p_changes ? 'activo' then (p_changes->>'activo')::boolean else activo end
   where location_id = p_location;
  insert into public.cloud_audit (actor_kind, actor_id, company_id, action, result, detail)
  values ('USER', p_actor, m.company_id, 'ADMIN_MENU_UPDATE', 'OK', jsonb_build_object(
    'location_id', p_location, 'before', jsonb_build_object('slug', m.slug, 'activo', m.activo), 'changes', p_changes, 'reason', p_reason));
  return jsonb_build_object('ok', true);
end $$;

/*
 * Dar de alta, cambiar de rol o desactivar a un administrador por su correo
 * (el usuario ya debe existir en Auth). Nunca deja la plataforma sin un OWNER
 * activo, y nadie se quita a sí mismo el rol de OWNER.
 */
create or replace function public.platform_admin_set(p_email text, p_role text, p_active boolean, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_owners int;
begin
  if p_role not in ('OWNER', 'OPERATOR', 'VIEWER') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Rol desconocido.');
  end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Ese correo no tiene cuenta. Que se registre primero.');
  end if;
  if v_user = p_actor_id and (p_role <> 'OWNER' or not p_active) then
    return jsonb_build_object('ok', false, 'code', 'SELF', 'error', 'No puedes quitarte tu propio rol de OWNER.');
  end if;
  insert into public.platform_admins (user_id, role, active, created_by)
  values (v_user, p_role, p_active, 'admin:' || p_actor_id)
  on conflict (user_id) do update set role = excluded.role, active = excluded.active;
  select count(*) into v_owners from public.platform_admins where role = 'OWNER' and active;
  if v_owners = 0 then
    raise exception 'Debe quedar al menos un OWNER activo';
  end if;
  return jsonb_build_object('ok', true, 'user_id', v_user);
end $$;

-- ============================================================================
--  CONSULTAS DEL PANEL (solo lectura)
-- ============================================================================

/* Fecha de hoy en México (UTC-6, sin horario de verano). */
create or replace function public.admin_hoy_mx()
returns date language sql stable as $$ select (now() at time zone 'America/Mexico_City')::date $$;

/* Tablero: negocios con ventas, alertas y riesgo; y contadores de la plataforma. */
create or replace function public.admin_q_overview()
returns jsonb language sql stable security definer set search_path = public as $$
  with hoy as (select public.admin_hoy_mx() d),
  mes as (select date_trunc('month', (select d from hoy))::date d),
  neg as (
    select n.id, coalesce(n.nombre, 'Sin nombre') nombre, n.owner_id is not null vinculado, n.created_at,
           (select count(*) from public.sucursales s where s.negocio_id = n.id) sucursales,
           coalesce((select sum(r.total) from public.resumen_ventas r join public.sucursales s on s.id = r.sucursal_id
                      where s.negocio_id = n.id and r.fecha = (select d from hoy)), 0) ventas_hoy,
           coalesce((select sum(r.total) from public.resumen_ventas r join public.sucursales s on s.id = r.sucursal_id
                      where s.negocio_id = n.id and r.fecha >= (select d from mes)), 0) ventas_mes,
           coalesce((select sum(r.utilidad) from public.resumen_ventas r join public.sucursales s on s.id = r.sucursal_id
                      where s.negocio_id = n.id and r.fecha >= (select d from mes)), 0) utilidad_mes,
           (select count(*) from public.alertas a join public.sucursales s on s.id = a.sucursal_id
             where s.negocio_id = n.id and not a.leida) alertas,
           (select count(*) from public.seguridad_riesgo g join public.sucursales s on s.id = g.sucursal_id
             where s.negocio_id = n.id and g.nivel = 'alto') riesgo_alto
      from public.negocios n)
  select jsonb_build_object(
    'hoy', (select d from hoy),
    'negocios', coalesce((select jsonb_agg(to_jsonb(neg) order by ventas_mes desc) from neg), '[]'),
    'totales', jsonb_build_object(
      'negocios', (select count(*) from neg),
      'ventas_hoy', (select coalesce(sum(ventas_hoy), 0) from neg),
      'ventas_mes', (select coalesce(sum(ventas_mes), 0) from neg),
      'alertas', (select coalesce(sum(alertas), 0) from neg),
      'riesgo_alto', (select coalesce(sum(riesgo_alto), 0) from neg)),
    'licencias', jsonb_build_object(
      'activas', (select count(*) from public.licenses where status = 'activa'),
      'suspendidas', (select count(*) from public.licenses where status = 'suspendida'),
      'canceladas', (select count(*) from public.licenses where status = 'cancelada'),
      'por_revisar', (select count(*) from public.license_review_queue),
      'vencen_30d', (select count(*) from public.licenses l where l.status = 'activa'
                       and public.license_paid_until(l.id) between now() and now() + interval '30 days')),
    'pruebas_activas', (select count(*) from public.device_trials where status = 'active' and expires_at > now()));
$$;

/* Detalle de un negocio: sucursales, licencias por computadora, prueba, apps, equipos. */
create or replace function public.admin_q_negocio(p_negocio uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with n as (select * from public.negocios where id = p_negocio),
  s as (select * from public.sucursales where negocio_id = p_negocio),
  hoy as (select public.admin_hoy_mx() d)
  select case when not exists (select 1 from n) then null else jsonb_build_object(
    'negocio', (select jsonb_build_object('id', id, 'nombre', nombre, 'owner_id', owner_id, 'created_at', created_at) from n),
    'sucursales', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'nombre', s.nombre, 'license_machine_id', s.license_machine_id,
        'ventas_hoy', coalesce((select sum(total) from public.resumen_ventas r where r.sucursal_id = s.id and r.fecha = (select d from hoy)), 0),
        'ventas_mes', coalesce((select sum(total) from public.resumen_ventas r where r.sucursal_id = s.id
                                 and r.fecha >= date_trunc('month', (select d from hoy))::date), 0),
        'menu', (select jsonb_build_object('slug', m.slug, 'activo', m.activo, 'latido_en', m.latido_en)
                   from public.menu_publicaciones m where m.location_id = s.id)) order by s.created_at) from s), '[]'),
    'licencias', coalesce((select jsonb_agg(jsonb_build_object(
        'license_id', l.id, 'license_key', l.license_key, 'plan', l.plan, 'status', l.status, 'origin', l.origin,
        'machine_id', a.machine_id, 'alias', a.machine_alias, 'active', a.active, 'last_seen_at', a.last_seen_at))
        from public.license_activations a join public.licenses l on l.id = a.license_id
       where a.machine_id in (select license_machine_id from s where license_machine_id is not null)), '[]'),
    'pruebas', coalesce((select jsonb_agg(jsonb_build_object(
        'machine_id', t.machine_id, 'business_name', t.business_name, 'email', t.email, 'vertical', t.vertical,
        'started_at', t.started_at, 'expires_at', t.expires_at, 'status', t.status))
        from public.device_trials t where t.machine_id in (select license_machine_id from s where license_machine_id is not null)), '[]'),
    'apps', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'device_id', o.device_id, 'active', o.active, 'is_paid_extra', o.is_paid_extra, 'created_at', o.created_at)
        order by o.created_at) from public.owner_apps o where o.negocio_id = p_negocio::text), '[]'),
    'apps_cupo', coalesce((select total_apps from public.negocio_app_quota where negocio_id = p_negocio::text), 1),
    'equipos', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'kind', d.kind, 'name', d.name, 'status', d.status, 'location_id', d.location_id,
        'app_version', d.app_version, 'last_seen_at', d.last_seen_at, 'revoked_at', d.revoked_at)
        order by d.created_at) from public.devices d where d.company_id = p_negocio), '[]'),
    'whatsapp', (select jsonb_build_object('status', w.status, 'display_phone', w.display_phone,
                   'verified_name', w.verified_name, 'last_error', w.last_error, 'connected_at', w.connected_at)
                   from public.wa_cuentas w where w.company_id = p_negocio),
    'push_tokens', (select count(*) from public.push_tokens p join n on p.owner_id = n.owner_id))
  end;
$$;

/* Buscar licencias por clave, cliente, correo o negocio. */
create or replace function public.admin_q_licencias(p_q text default null, p_status text default null, p_origin text default null,
                                                    p_limit int default 50, p_offset int default 0)
returns jsonb language sql stable security definer set search_path = public as $$
  with f as (
    select l.* from public.licenses l
     where (p_status is null or l.status = p_status)
       and (p_origin is null or (p_origin = 'NONE' and l.origin is null) or l.origin = p_origin)
       and (coalesce(trim(p_q), '') = '' or l.license_key ilike '%' || trim(p_q) || '%'
            or l.customer_name ilike '%' || trim(p_q) || '%' or l.customer_email ilike '%' || trim(p_q) || '%'
            or l.negocio ilike '%' || trim(p_q) || '%'))
  select jsonb_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((select jsonb_agg(r order by r.created_at desc) from (
      select f.id, f.license_key, f.plan, f.status, f.origin, f.customer_name, f.customer_email, f.negocio, f.created_at,
             f.first_activated_at, public.license_paid_until(f.id) paid_until,
             (select coalesce(jsonb_agg(v.vertical order by v.vertical), '[]') from public.license_verticals v where v.license_id = f.id) verticals,
             (select count(*) from public.license_activations a where a.license_id = f.id and a.active) equipos
        from f order by f.created_at desc
       limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) r), '[]'));
$$;

/* Todo sobre una licencia: runtime, equipos, giros, compras, periodos, adaptaciones, bitácora. */
create or replace function public.admin_q_licencia(p_license uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when l.id is null then null else jsonb_build_object(
    'license', jsonb_build_object('id', l.id, 'license_key', l.license_key, 'plan', l.plan, 'status', l.status, 'origin', l.origin,
       'customer_name', l.customer_name, 'customer_email', l.customer_email, 'customer_phone', l.customer_phone,
       'negocio', l.negocio, 'support_tier', l.support_tier, 'support_until', l.support_until, 'addons', l.addons,
       'created_at', l.created_at, 'first_activated_at', l.first_activated_at, 'included_until', l.included_until,
       'paid_until', public.license_paid_until(l.id), 'notes', l.notes),
    'runtime', public.license_runtime(l.id),
    'equipos', coalesce((select jsonb_agg(jsonb_build_object('machine_id', a.machine_id, 'alias', a.machine_alias, 'active', a.active,
        'first_seen_at', a.first_seen_at, 'last_seen_at', a.last_seen_at, 'released_at', a.released_at, 'released_by', a.released_by,
        'sucursal', (select jsonb_build_object('id', s.id, 'nombre', s.nombre, 'negocio_id', s.negocio_id)
                       from public.sucursales s where s.license_machine_id = a.machine_id limit 1))
        order by a.active desc, a.last_seen_at desc) from public.license_activations a where a.license_id = l.id), '[]'),
    'giros', coalesce((select jsonb_agg(jsonb_build_object('vertical', v.vertical, 'screen_tier', v.screen_tier,
        'source', v.source, 'added_at', v.added_at) order by v.vertical) from public.license_verticals v where v.license_id = l.id), '[]'),
    'compras', coalesce((select jsonb_agg(to_jsonb(p) - 'detail' order by p.created_at desc)
        from public.license_purchases p where p.license_id = l.id), '[]'),
    'periodos', coalesce((select jsonb_agg(to_jsonb(x) order by x.period_end desc)
        from public.license_subscriptions x where x.license_id = l.id), '[]'),
    'adaptaciones', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc)
        from public.license_code_changes c where c.license_id = l.id), '[]'),
    'soporte', (select to_jsonb(s) from public.license_support_summary s where s.license_id = l.id),
    'eventos', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from (
        select * from public.license_events where license_id = l.id order by created_at desc limit 200) e), '[]'))
  end
  from (select 1) x left join public.licenses l on l.id = p_license;
$$;

/* Pruebas gratis por computadora. */
create or replace function public.admin_q_pruebas(p_q text default null, p_activas boolean default false, p_limit int default 100)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.expires_at desc), '[]') from (
    select machine_id, business_name, email, vertical, vertical_changes, started_at, expires_at, status,
           (status = 'active' and expires_at > now()) vigente
      from public.device_trials
     where (not coalesce(p_activas, false) or (status = 'active' and expires_at > now()))
       and (coalesce(trim(p_q), '') = '' or business_name ilike '%' || trim(p_q) || '%'
            or email ilike '%' || trim(p_q) || '%' or machine_id ilike '%' || trim(p_q) || '%')
     order by expires_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) t;
$$;

/* Comercial: SOLO licencias PRODUCTION. Ingresos por mes, renovaciones próximas y vencidas. */
create or replace function public.admin_q_comercial(p_meses int default 12)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'por_mes', coalesce((select jsonb_agg(m order by m.mes) from (
        select to_char(date_trunc('month', p.created_at), 'YYYY-MM') mes, count(*) compras,
               coalesce(sum(p.price_paid), 0) ingresos,
               count(*) filter (where p.kind = 'INITIAL') nuevas,
               count(*) filter (where p.kind = 'SUBSCRIPTION') renovaciones
          from public.license_commercial_purchases p
         where p.created_at >= date_trunc('month', now()) - make_interval(months => least(greatest(coalesce(p_meses, 12), 1), 36) - 1)
         group by 1) m), '[]'),
    'clientes', (select count(*) from public.license_commercial_licenses where status = 'activa'),
    'por_vencer', coalesce((select jsonb_agg(v order by v.paid_until) from (
        select l.id, l.license_key, l.customer_name, l.customer_email, public.license_paid_until(l.id) paid_until
          from public.license_commercial_licenses l
         where l.status = 'activa' and public.license_paid_until(l.id) between now() and now() + interval '45 days') v), '[]'),
    'vencidas', coalesce((select jsonb_agg(v order by v.paid_until desc) from (
        select l.id, l.license_key, l.customer_name, l.customer_email, public.license_paid_until(l.id) paid_until
          from public.license_commercial_licenses l
         where l.status = 'activa' and public.license_paid_until(l.id) < now()
         limit 200) v), '[]'),
    'compras_recientes', coalesce((select jsonb_agg(c order by c.created_at desc) from (
        select p.id, p.license_id, l.license_key, l.customer_name, p.kind, p.catalog_code, p.list_price, p.discount_amount,
               p.price_paid, p.payment_provider, p.payment_ref, p.created_by, p.created_at
          from public.license_purchases p join public.licenses l on l.id = p.license_id
         order by p.created_at desc limit 100) c), '[]'));
$$;

/* Cola de revisión: sin clasificar, sin giro o candidatas a cancelar. */
create or replace function public.admin_q_revision()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc), '[]') from public.license_review_queue q;
$$;

/* Adaptaciones abiertas de todas las licencias. */
create or replace function public.admin_q_adaptaciones(p_abiertas boolean default true)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]') from (
    select c.*, l.license_key, l.customer_name from public.license_code_changes c join public.licenses l on l.id = c.license_id
     where not coalesce(p_abiertas, true) or c.status in ('REGISTRADO', 'EN_PROCESO')
     order by c.created_at desc limit 300) x;
$$;

/* Catálogo completo y los últimos cambios de precio. */
create or replace function public.admin_q_catalogo()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'productos', coalesce((select jsonb_agg(to_jsonb(c) order by c.sort, c.code) from public.license_catalog c), '[]'),
    'historial', coalesce((select jsonb_agg(to_jsonb(h)) from (
        select * from public.license_catalog_price_history order by 1 desc limit 50) h), '[]'));
$$;

/* Plataforma: versiones publicadas, menús en línea y cuentas de WhatsApp (sin secretos). */
create or replace function public.admin_q_plataforma()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'releases', coalesce((select jsonb_agg(to_jsonb(r) order by r.app, r.channel) from public.app_releases r), '[]'),
    'menus', coalesce((select jsonb_agg(m order by m.publicado_en desc) from (
        select mp.location_id, mp.company_id, mp.slug, mp.activo, mp.recibe_pedidos, mp.negocio, mp.latido_en, mp.publicado_en,
               s.nombre sucursal
          from public.menu_publicaciones mp left join public.sucursales s on s.id = mp.location_id) m), '[]'),
    'whatsapp', coalesce((select jsonb_agg(w order by w.connected_at desc) from (
        select wc.company_id, n.nombre negocio, wc.status, wc.display_phone, wc.verified_name, wc.last_error, wc.connected_at, wc.updated_at
          from public.wa_cuentas wc left join public.negocios n on n.id = wc.company_id) w), '[]'));
$$;

/* Bitácora del panel. */
create or replace function public.admin_q_auditoria(p_limit int default 100, p_before bigint default null, p_target text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id desc), '[]') from (
    select * from public.admin_audit
     where (p_before is null or id < p_before) and (p_target is null or target = p_target)
     order by id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) a;
$$;

/* Administradores (para la pantalla de equipo). */
create or replace function public.admin_q_admins()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', a.user_id, 'email', u.email, 'role', a.role, 'active', a.active,
                  'note', a.note, 'created_at', a.created_at) order by a.created_at), '[]')
    from public.platform_admins a left join auth.users u on u.id = a.user_id;
$$;

-- ============================================================================
--  PRIVILEGIOS: nada para anon ni authenticated
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['platform_admins', 'admin_audit', 'admin_rate'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'admin_whoami(uuid)',
    'admin_audit_log(uuid, text, text, text, text, jsonb, jsonb, boolean, text, text)',
    'admin_rate_hit(uuid, integer, integer)',
    'admin_requiere_motivo(text, text)', 'license_new_key()',
    'license_set_status(uuid, text, text, text)', 'license_set_origin(uuid, text, text, text)',
    'license_update_customer(uuid, jsonb, text, text)', 'license_downgrade_to_mono(uuid, text, text)',
    'license_set_addon(uuid, text, boolean, text, text)', 'license_issue_manual(jsonb)',
    'license_code_change_set_status(uuid, text, text)',
    'device_trial_extend(text, integer, text, text)', 'device_set_status(uuid, text, text, text)',
    'owner_app_quota_set(uuid, integer, text, text)', 'owner_app_set_active(uuid, boolean, text, text)',
    'admin_semver(text)', 'app_release_upsert(text, text, text, text, text, text)',
    'menu_admin_update(uuid, jsonb, text, text)', 'admin_hoy_mx()',
    'admin_q_overview()', 'admin_q_negocio(uuid)', 'admin_q_licencias(text, text, text, integer, integer)',
    'admin_q_licencia(uuid)', 'admin_q_pruebas(text, boolean, integer)', 'admin_q_comercial(integer)',
    'admin_q_revision()', 'admin_q_adaptaciones(boolean)', 'admin_q_catalogo()', 'admin_q_plataforma()',
    'admin_q_auditoria(integer, bigint, text)', 'admin_q_admins()', 'admin_audit_append_only()',
    'platform_admin_set(text, text, boolean, uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ============================================================================
--  ALTA DEL PRIMER ADMINISTRADOR (a mano, una vez, en el SQL Editor):
--
--    insert into public.platform_admins (user_id, role, created_by)
--    select id, 'OWNER', 'sql-editor' from auth.users where email = '<tu correo>'
--    on conflict (user_id) do update set role = 'OWNER', active = true;
-- ============================================================================
