-- ============================================================================
--  FASE 3 · ETAPA 7 · AUTORIZACIÓN A DISTANCIA
--
--  Una tablet pide permiso para una acción restringida (merma, ajuste, retiro,
--  egreso, retorno, recibir, cerrar turno ajeno) cuando no hay un encargado en
--  la feria. La dueña o un admin la aprueba desde Owner con sesión AAL2.
--
--  ES UNA ALTERNATIVA, NO UN REQUISITO: la autorización local (PIN del
--  encargado, sin Internet) sigue igual. Sin red no se pide nada a distancia.
--
--    tablet: solicitar(id, acción, quién pide, payload)  -> PENDING (+ aviso push)
--    owner:  decidir(id, APPROVED|REJECTED, hash)         -> exige AAL2, rol y acceso
--    tablet: consumir(id, payload)                        -> APPROVED -> CONSUMED (una vez)
--
--  Garantías:
--   * id lo genera la tablet: reintentar solicitar es idempotente.
--   * payload_hash lo calcula la NUBE; quien aprueba manda el hash de lo que
--     VIO, y la tablet al consumir manda el payload que va a ejecutar: si
--     cualquiera de los dos no coincide, no pasa (cambio material = otra solicitud).
--   * Solo el MISMO equipo que pidió consume; una vez; antes de expirar.
--   * Una decisión solo sale de PENDING (fila bloqueada): no hay doble aprobación.
--   * Todo se audita en cloud_audit.
--   * Quien pide es un empleado de la feria (location_staff); quien aprueba es un
--     usuario de Owner: identidades distintas (sin autoaprobación posible por diseño).
-- ============================================================================

create table if not exists public.approval_policies (
  action text primary key,
  remota boolean not null default true,
  ttl interval not null default interval '10 minutes',
  roles text[] not null default array['OWNER', 'ADMIN'],
  etiqueta text not null
);
insert into public.approval_policies (action, etiqueta) values
  ('MERMA', 'registrar una merma'), ('AJUSTE', 'ajustar existencias'), ('RETIRO', 'retirar efectivo'),
  ('EGRESO', 'registrar un egreso'), ('RETORNO', 'regresar el sobrante'), ('RECIBIR_TRANSFERENCIA', 'recibir mercancía'),
  ('CERRAR_TURNO_AJENO', 'cerrar el turno de otra persona')
on conflict (action) do update set etiqueta = excluded.etiqueta;

create table if not exists public.approval_requests (
  id uuid primary key,
  company_id uuid not null references public.negocios(id) on delete cascade,
  location_id uuid not null references public.sucursales(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  action text not null references public.approval_policies(action),
  requested_by jsonb not null,
  payload jsonb not null,
  payload_hash text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'CONSUMED')),
  expires_at timestamptz not null,
  decided_by uuid,
  decided_name text,
  decided_at timestamptz,
  decision_note text,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ix_approval_requests_company on public.approval_requests (company_id, status, created_at desc);
alter table public.approval_requests enable row level security;      -- sin políticas: solo por funciones
alter table public.approval_policies enable row level security;

create or replace function public.wx_aprob_hash(p_action text, p_payload jsonb) returns text
language sql immutable as $$ select encode(sha256(convert_to(p_action || ':' || p_payload::text, 'UTF8')), 'hex') $$;

/* Vence lo que pasó de su hora (se llama al leer; no hace falta un proceso aparte). */
create or replace function public.wx_aprob_vencer(p_id uuid default null) returns void
language sql security definer set search_path = public as $$
  update public.approval_requests set status = 'EXPIRED'
   where status in ('PENDING', 'APPROVED') and expires_at < now() and (p_id is null or id = p_id);
$$;

create or replace function public.wx_aprob_salida(r public.approval_requests) returns jsonb
language sql stable as $$
  select jsonb_build_object('ok', true, 'id', r.id, 'status', r.status, 'action', r.action, 'expires_at', r.expires_at,
    'decided_name', r.decided_name, 'decided_at', r.decided_at, 'decision_note', r.decision_note)
$$;

-- --------------------------------------------------------------- tablet
create or replace function public.aprobacion_solicitar(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare d public.devices%rowtype; pol public.approval_policies%rowtype; r public.approval_requests%rowtype;
        v_id uuid := public.wx_uuid(p->>'id'); v_action text := upper(coalesce(p->>'action', '')); v_payload jsonb := coalesce(p->'payload', '{}');
        v_emp uuid := public.wx_uuid(p->'requested_by'->>'uuid');
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE';
  if not found then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if v_id is null or jsonb_typeof(v_payload) <> 'object' or pg_column_size(v_payload) > 4096 then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  select * into pol from public.approval_policies where action = v_action;
  if not found or not pol.remota then return jsonb_build_object('ok', false, 'code', 'NOT_REMOTE'); end if;
  -- Quien pide trabaja en ESTA ubicación (no basta con que la tablet lo diga).
  if v_emp is null or not exists (select 1 from public.location_staff ls join public.employees e on e.id = ls.employee_id
                                   where ls.location_id = d.location_id and ls.active and e.company_id = d.company_id
                                     and (e.id = v_emp or e.pos_user_uuid::text = v_emp::text)) then
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'APPROVAL_REQUEST', 'DENIED', jsonb_build_object('id', v_id, 'motivo', 'EMPLEADO'));
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;

  select * into r from public.approval_requests where id = v_id;
  if found then
    -- Reintento de la MISMA solicitud: se devuelve su estado. Otro equipo u otro contenido: conflicto.
    if r.device_id <> d.id or r.payload_hash <> public.wx_aprob_hash(v_action, v_payload) or r.action <> v_action then
      return jsonb_build_object('ok', false, 'code', 'CONFLICT');
    end if;
    perform public.wx_aprob_vencer(v_id);
    select * into r from public.approval_requests where id = v_id;
    return public.wx_aprob_salida(r);
  end if;

  insert into public.approval_requests (id, company_id, location_id, device_id, action, requested_by, payload, payload_hash, expires_at)
  values (v_id, d.company_id, d.location_id, d.id, v_action,
          jsonb_build_object('uuid', v_emp, 'name', left(coalesce(p->'requested_by'->>'name', ''), 80), 'role', left(coalesce(p->'requested_by'->>'role', ''), 20)),
          v_payload, public.wx_aprob_hash(v_action, v_payload), now() + pol.ttl)
  returning * into r;
  insert into public.notification_outbox (company_id, location_id, kind, ref_uuid, payload)
  values (r.company_id, r.location_id, 'APPROVAL_REQUESTED', r.id, jsonb_build_object('action', r.action))
  on conflict (kind, ref_uuid) do nothing;
  perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'APPROVAL_REQUEST', 'OK', jsonb_build_object('id', r.id, 'action', r.action));
  return public.wx_aprob_salida(r);
end $$;

create or replace function public.aprobacion_estado(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare r public.approval_requests%rowtype;
begin
  perform public.wx_aprob_vencer(public.wx_uuid(p->>'id'));
  select * into r from public.approval_requests where id = public.wx_uuid(p->>'id') and device_id = public.wx_uuid(p->>'device_id');
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  return public.wx_aprob_salida(r);
end $$;

create or replace function public.aprobacion_consumir(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare r public.approval_requests%rowtype; v_id uuid := public.wx_uuid(p->>'id');
begin
  perform public.wx_aprob_vencer(v_id);
  select * into r from public.approval_requests where id = v_id for update;
  if not found or r.device_id <> public.wx_uuid(p->>'device_id') then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if r.status <> 'APPROVED' then return jsonb_build_object('ok', false, 'code', 'NOT_APPROVED', 'status', r.status); end if;
  if r.payload_hash <> public.wx_aprob_hash(r.action, coalesce(p->'payload', '{}')) then
    perform public.wx_audit('DEVICE', r.device_id::text, r.company_id, 'APPROVAL_CONSUME', 'DENIED', jsonb_build_object('id', r.id, 'motivo', 'PAYLOAD_CHANGED'));
    return jsonb_build_object('ok', false, 'code', 'PAYLOAD_CHANGED');
  end if;
  update public.approval_requests set status = 'CONSUMED', consumed_at = now() where id = r.id returning * into r;
  perform public.wx_audit('DEVICE', r.device_id::text, r.company_id, 'APPROVAL_CONSUME', 'OK', jsonb_build_object('id', r.id, 'action', r.action, 'aprobo', r.decided_by));
  return public.wx_aprob_salida(r) || jsonb_build_object('approver', jsonb_build_object('uuid', r.id, 'name', r.decided_name, 'user_id', r.decided_by));
end $$;

create or replace function public.aprobacion_cancelar(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare r public.approval_requests%rowtype;
begin
  update public.approval_requests set status = 'CANCELLED'
   where id = public.wx_uuid(p->>'id') and device_id = public.wx_uuid(p->>'device_id') and status = 'PENDING'
  returning * into r;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_PENDING'); end if;
  perform public.wx_audit('DEVICE', r.device_id::text, r.company_id, 'APPROVAL_CANCEL', 'OK', jsonb_build_object('id', r.id));
  return public.wx_aprob_salida(r);
end $$;

-- ---------------------------------------------------------------- owner
/* Pendientes (y las últimas resueltas) de las ubicaciones a las que la persona tiene acceso. */
create or replace function public.owner_aprobaciones(p_company uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if public.wx_rol(p_company) is null then raise exception 'DENIED' using errcode = '42501'; end if;
  perform public.wx_aprob_vencer();
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'status', a.status, 'action', a.action, 'etiqueta', pol.etiqueta,
            'location', s.nombre, 'location_id', a.location_id, 'requested_by', a.requested_by, 'payload', a.payload,
            'payload_hash', a.payload_hash, 'expires_at', a.expires_at, 'created_at', a.created_at,
            'decided_name', a.decided_name, 'decided_at', a.decided_at) order by (a.status = 'PENDING') desc, a.created_at desc)
     from public.approval_requests a join public.sucursales s on s.id = a.location_id join public.approval_policies pol on pol.action = a.action
    where a.company_id = p_company and public.wx_puede_ubicacion(a.location_id)
      and (a.status = 'PENDING' or a.created_at > now() - interval '24 hours')), '[]');
end $$;

create or replace function public.owner_decidir_aprobacion(p_id uuid, p_decision text, p_hash text, p_nota text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare r public.approval_requests%rowtype; pol public.approval_policies%rowtype; u uuid := auth.uid(); b jsonb; v_rol text;
        v_dec text := upper(coalesce(p_decision, '')); v_nombre text;
begin
  b := public.wx_mfa_bloqueo(u);
  if b is not null then return b; end if;
  if v_dec not in ('APPROVED', 'REJECTED') then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
  perform public.wx_aprob_vencer(p_id);
  select * into r from public.approval_requests where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  select * into pol from public.approval_policies where action = r.action;
  -- Rol de la regla, en esa empresa, con acceso a ESA ubicación.
  select cm.role into v_rol from public.company_memberships cm
   where cm.company_id = r.company_id and cm.user_id = u and cm.status = 'ACTIVE'
     and (cm.location_ids is null or r.location_id = any (cm.location_ids));
  if v_rol is null or not (v_rol = any (pol.roles)) then
    perform public.wx_audit('USER', u::text, r.company_id, 'APPROVAL_DECIDE', 'DENIED', jsonb_build_object('id', r.id));
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;
  if r.status <> 'PENDING' then return jsonb_build_object('ok', false, 'code', 'ALREADY_DECIDED', 'status', r.status); end if;
  if coalesce(p_hash, '') <> r.payload_hash then return jsonb_build_object('ok', false, 'code', 'PAYLOAD_CHANGED'); end if;
  select coalesce(nullif(to_jsonb(u2)->'raw_user_meta_data'->>'full_name', ''), split_part(u2.email, '@', 1)) into v_nombre from auth.users u2 where u2.id = u;
  update public.approval_requests set status = v_dec, decided_by = u, decided_name = coalesce(v_nombre, 'Owner'), decided_at = now(),
         decision_note = left(p_nota, 200) where id = r.id returning * into r;
  perform public.wx_audit('USER', u::text, r.company_id, 'APPROVAL_DECIDE', v_dec,
    jsonb_build_object('id', r.id, 'action', r.action, 'aal', public.wx_claims()->>'aal'));
  return public.wx_aprob_salida(r);
end $$;

-- ------------------------------------------- aviso push de la solicitud
insert into public.notification_kinds (kind, descripcion, roles, canales, vigencia) values
  ('APPROVAL_REQUESTED', 'Una tablet pide autorización a distancia', array['OWNER', 'ADMIN'], array['push'], interval '10 minutes')
on conflict (kind) do update set descripcion = excluded.descripcion;

create or replace function public.wx_notif_texto(p_kind text, p_payload jsonb, p_ubicacion text)
returns jsonb language plpgsql stable set search_path = public as $$
declare u text := coalesce(nullif(p_ubicacion, ''), 'Tu negocio'); d numeric;
begin
  if p_kind = 'SHIFT_CLOSED' then
    d := nullif(p_payload->>'difference', '')::numeric;
    if d is not null and d <> 0 then
      return jsonb_build_object('titulo', 'Corte con diferencia', 'cuerpo', u || coalesce(' · ' || nullif(p_payload->>'register', ''), '') || '. Abre Wybix para revisarlo.');
    end if;
    return jsonb_build_object('titulo', 'Corte cerrado', 'cuerpo', u || coalesce(' · ' || nullif(p_payload->>'register', ''), '') || '.');
  elsif p_kind = 'DEVICE_REVOKED' then
    return jsonb_build_object('titulo', 'Equipo dado de baja', 'cuerpo', u || ': se dio de baja un equipo de la empresa.');
  elsif p_kind = 'SYNC_REJECTED' then
    return jsonb_build_object('titulo', 'Operación rechazada', 'cuerpo', u || ': la nube rechazó una operación de un equipo. Revísala en Wybix.');
  elsif p_kind = 'SYNC_QUARANTINED' then
    return jsonb_build_object('titulo', 'Operación en revisión', 'cuerpo', u || ': llegó una operación de un equipo dado de baja.');
  elsif p_kind = 'APPROVAL_REQUESTED' then
    return jsonb_build_object('titulo', 'Autorización pendiente', 'cuerpo',
      u || ': piden autorización para ' || coalesce((select etiqueta from public.approval_policies where action = p_payload->>'action'), 'una acción') || '.');
  end if;
  return jsonb_build_object('titulo', 'Aviso de Wybix', 'cuerpo', u || '.');
end $$;

-- ---------------------------------- verificación cruzada al sincronizar
/* Si un evento dice "lo autorizó una aprobación a distancia", esa aprobación
   tiene que existir, estar CONSUMIDA y ser de ese mismo equipo. Si no, queda
   auditado y como pendiente de revisión (el evento no se borra). */
create or replace function public.wx_aprob_verificar_evento() returns trigger
language plpgsql security definer set search_path = public as $$
declare v uuid := public.wx_uuid(new.payload->'authorized_by'->>'uuid'); a public.approval_requests%rowtype; v_ok boolean;
begin
  if coalesce(new.payload->'authorized_by'->>'remote', '') <> 'true' or new.result <> 'APPLIED' then return new; end if;
  select * into a from public.approval_requests where id = v;
  -- La aprobación existe, es de ESA tablet, se consumió, corresponde al TIPO de
  -- operación del evento y no respalda ya a otro evento.
  v_ok := found and a.device_id = new.device_id and a.status = 'CONSUMED'
    and case new.event_type
          when 'INVENTORY_MOVEMENT_RECORDED' then a.action in ('MERMA', 'AJUSTE')
          when 'CASH_MOVEMENT_RECORDED' then a.action in ('RETIRO', 'EGRESO')
          when 'SHIFT_CLOSED' then a.action = 'CERRAR_TURNO_AJENO'
          when 'TRANSFER_RECEIVED' then a.action = 'RECIBIR_TRANSFERENCIA'
          when 'RETURN_SENT' then a.action = 'RETORNO'
          else false end
    and not exists (select 1 from public.sync_events e where e.event_uuid <> new.event_uuid and e.result = 'APPLIED'
                      and e.payload->'authorized_by'->>'uuid' = v::text);
  if not v_ok then
    perform public.wx_audit('DEVICE', new.device_id::text, new.company_id, 'APPROVAL_MISMATCH', 'DENIED',
      jsonb_build_object('event_uuid', new.event_uuid, 'approval_id', v));
    perform public.wx_pendiente('APPROVAL_MISMATCH', new.event_uuid::text, new.company_id,
      jsonb_build_object('event_uuid', new.event_uuid, 'approval_id', v, 'device_id', new.device_id));
  end if;
  return new;
exception when others then
  raise warning 'aprobaciones: no se pudo verificar el evento (%)', sqlstate;
  return new;
end $$;
drop trigger if exists wx_aprob_verificar on public.sync_events;
create trigger wx_aprob_verificar after insert on public.sync_events for each row
  when (new.payload ? 'authorized_by') execute function public.wx_aprob_verificar_evento();

-- ------------------------------------------------------------------ permisos
do $$
declare f text;
begin
  foreach f in array array['aprobacion_solicitar(jsonb)', 'aprobacion_estado(jsonb)', 'aprobacion_consumir(jsonb)', 'aprobacion_cancelar(jsonb)',
                           'wx_aprob_vencer(uuid)', 'wx_aprob_verificar_evento()'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon, authenticated', f);
      execute format('grant execute on function public.%s to service_role', f);
    end if;
  end loop;
  foreach f in array array['owner_aprobaciones(uuid)', 'owner_decidir_aprobacion(uuid, text, text, text)'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon', f);
      execute format('grant execute on function public.%s to authenticated, service_role', f);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.approval_requests, public.approval_policies from anon, authenticated;
  end if;
end $$;
