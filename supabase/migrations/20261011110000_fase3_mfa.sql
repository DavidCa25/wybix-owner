-- ============================================================================
--  FASE 3 · ETAPA 3 · MFA DEL DUEÑO (TOTP de Supabase Auth + AAL2 en el backend)
--
--  Regla: toda operación ADMINISTRATIVA de un usuario (crear eventos o
--  ubicaciones, cambiar su estado, asignar personal, generar códigos de
--  tablet, revocar equipos, resolver clones, invitar) exige una sesión AAL2.
--  Se impone en `wx_actor_admin`, el único punto por el que pasan todas, y
--  no en la pantalla: ocultar un botón no protege nada.
--
--    sin factor TOTP verificado     -> MFA_ENROLL_REQUIRED
--    con factor, sesión AAL1        -> MFA_REQUIRED
--    sesión AAL2 del MISMO usuario  -> pasa
--
--  Lo que NO cambia: los equipos (POS principal, tablets) siguen autorizados
--  por su credencial de dispositivo, y licencias y funciones fiscales se
--  autorizan por dispositivo, no por usuario. Las LECTURAS del dueño
--  (resumen, equipos, personal) siguen en AAL1.
--
--  Recuperación: 10 códigos de un solo uso (hash SHA-256 con sal por
--  usuario), generables solo con AAL2. Consumir uno lo hace la función
--  owner-mfa con service_role, con límite de 5 intentos fallidos cada 15
--  minutos; si es válido, la función quita los factores y cierra las demás
--  sesiones, y la persona vuelve a enrolarse.
--
--  Idempotente. auth.mfa_factors existe en Supabase; en las pruebas se emula.
-- ============================================================================

-- ------------------------------------------------------------------ sesión
create or replace function public.wx_claims() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function public.wx_mfa_factores(p_user uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from auth.mfa_factors where user_id = p_user and status::text = 'verified'
$$;

/* null = puede; si no, el error que se le devuelve a la app. */
create or replace function public.wx_mfa_bloqueo(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c jsonb := public.wx_claims(); n int;
begin
  if p_user is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  n := public.wx_mfa_factores(p_user);
  if n = 0 then return jsonb_build_object('ok', false, 'code', 'MFA_ENROLL_REQUIRED'); end if;
  -- La sesión tiene que ser de ESTE usuario y estar en AAL2.
  if c->>'sub' = p_user::text and c->>'aal' = 'aal2' then return null; end if;
  return jsonb_build_object('ok', false, 'code', 'MFA_REQUIRED');
end $$;

-- ------------------------------------------------- wx_actor_admin con AAL2
-- Texto exacto de 20261002120000 más la comprobación de MFA en la rama USER.
create or replace function public.wx_actor_admin(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.devices%rowtype; v_user uuid := public.wx_uuid(p->>'user_id'); v_company uuid := public.wx_uuid(p->>'company_id'); v_rol text;
begin
  if p ? 'device_id' then
    select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE';
    if not found or d.kind <> 'POS_PRIMARY' then return null; end if;
    return jsonb_build_object('kind', 'DEVICE', 'id', d.id, 'company_id', d.company_id, 'location_id', d.location_id);
  end if;
  if v_user is null or v_company is null then return null; end if;
  select role into v_rol from public.company_memberships where company_id = v_company and user_id = v_user and status = 'ACTIVE';
  -- OJO: `null not in (...)` es null, no true. Sin membresía = sin permiso.
  if v_rol is null or v_rol not in ('OWNER', 'ADMIN') then return null; end if;
  -- FASE 3: una persona solo administra con segundo factor.
  if public.wx_mfa_bloqueo(v_user) is not null then return null; end if;
  return jsonb_build_object('kind', 'USER', 'id', v_user, 'company_id', v_company, 'role', v_rol);
end $$;

-- ------------------------------------- envoltorios del dueño: error claro
-- Mismo cuerpo que en 20261010120000, con la comprobación DELANTE para que la
-- app sepa si tiene que pedir el código o el enrolamiento (y no un DENIED).
create or replace function public.owner_crear_evento(p_company uuid, p jsonb)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(public.wx_mfa_bloqueo(auth.uid()),
    public.pos_create_location(coalesce(p, '{}') || jsonb_build_object('user_id', auth.uid(), 'company_id', p_company, 'tipo', 'EVENT')));
$$;
create or replace function public.owner_evento_estado(p_company uuid, p_location uuid, p_status text, p_forzar boolean default false, p_motivo text default null)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(public.wx_mfa_bloqueo(auth.uid()),
    public.evento_cambiar_estado(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company, 'location_id', p_location,
                                                    'status', p_status, 'forzar', p_forzar, 'motivo', p_motivo)));
$$;
create or replace function public.owner_asignar_personal(p_company uuid, p_location uuid, p_employee uuid, p_role text, p_active boolean default true)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(public.wx_mfa_bloqueo(auth.uid()),
    public.evento_asignar_personal(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company, 'location_id', p_location,
                                                      'employee_id', p_employee, 'role', p_role, 'active', p_active)));
$$;
create or replace function public.owner_codigo_tablet(p_company uuid, p_location uuid, p_register_name text default null)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(public.wx_mfa_bloqueo(auth.uid()),
    public.evento_codigo_tablet(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company, 'location_id', p_location, 'register_name', p_register_name)));
$$;
create or replace function public.owner_revocar_dispositivo(p_company uuid, p_device uuid)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(public.wx_mfa_bloqueo(auth.uid()),
    public.dispositivo_revocar(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company, 'target_device_id', p_device)));
$$;
create or replace function public.owner_resolver_clon(p_company uuid, p_location uuid, p_decision text)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(public.wx_mfa_bloqueo(auth.uid()),
    public.ubicacion_resolver_clon(jsonb_build_object('user_id', auth.uid(), 'company_id', p_company, 'location_id', p_location, 'decision', p_decision)));
$$;

-- --------------------------------------------------- códigos de recuperación
create table if not exists public.mfa_recovery_codes (
  user_id uuid not null,
  code_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  primary key (user_id, code_hash)
);
create table if not exists public.mfa_recovery_attempts (
  id bigserial primary key,
  user_id uuid not null,
  at timestamptz not null default now(),
  ok boolean not null
);
create index if not exists ix_mfa_recovery_attempts on public.mfa_recovery_attempts (user_id, at desc);
alter table public.mfa_recovery_codes enable row level security;     -- sin políticas: nadie lee desde la API
alter table public.mfa_recovery_attempts enable row level security;
revoke all on public.mfa_recovery_codes, public.mfa_recovery_attempts from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.mfa_recovery_codes, public.mfa_recovery_attempts from anon, authenticated;
  end if;
end $$;

/* "abcde-12345", "ABCDE12345" y " abcde 12345 " son el mismo código. */
create or replace function public.wx_mfa_normalizar(p text) returns text
language sql immutable as $$ select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;

create or replace function public.wx_mfa_hash(p_user uuid, p_codigo text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(p_user::text || ':' || public.wx_mfa_normalizar(p_codigo), 'UTF8')), 'hex')
$$;

/* Genera 10 códigos nuevos (borra los anteriores). Solo con AAL2. Se muestran UNA vez. */
create or replace function public.mfa_generar_codigos()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare u uuid := auth.uid(); b jsonb := public.wx_mfa_bloqueo(auth.uid()); v_codigos text[] := '{}'; c text; i int;
begin
  if b is not null then
    perform public.wx_audit('USER', u::text, null, 'MFA_RECOVERY_GENERATE', 'DENIED', jsonb_build_object('code', b->>'code'));
    return b;
  end if;
  delete from public.mfa_recovery_codes where user_id = u;
  for i in 1..10 loop
    -- 10 caracteres hexadecimales (40 bits) por código, de gen_random_uuid (CSPRNG del servidor).
    c := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    c := substr(c, 1, 5) || '-' || substr(c, 6, 5);
    insert into public.mfa_recovery_codes (user_id, code_hash) values (u, public.wx_mfa_hash(u, c));
    v_codigos := v_codigos || c;
  end loop;
  perform public.wx_audit('USER', u::text, null, 'MFA_RECOVERY_GENERATE', 'OK', jsonb_build_object('cantidad', 10));
  return jsonb_build_object('ok', true, 'codigos', to_jsonb(v_codigos));
end $$;

/* Lo que la app necesita para decidir qué pantalla mostrar. Sin secretos. */
create or replace function public.mfa_estado()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'factores', public.wx_mfa_factores(auth.uid()),
    'aal', public.wx_claims()->>'aal',
    'codigos_restantes', (select count(*) from public.mfa_recovery_codes where user_id = auth.uid() and used_at is null))
$$;

/* La app avisa de un cambio; lo auditado es lo que la BASE ve, no lo que dice la app. */
create or replace function public.mfa_registrar(p_evento text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare u uuid := auth.uid(); v_evento text := upper(coalesce(p_evento, ''));
begin
  if u is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  if v_evento not in ('ENROLLED', 'UNENROLLED', 'VERIFIED', 'SIGNED_OUT_OTHERS') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  end if;
  perform public.wx_audit('USER', u::text, null, 'MFA_' || v_evento, 'OK',
    jsonb_build_object('factores_verificados', public.wx_mfa_factores(u), 'aal', public.wx_claims()->>'aal'));
  return jsonb_build_object('ok', true);
end $$;

/* Solo la función owner-mfa (service_role), después de validar el JWT. */
create or replace function public.mfa_consumir_codigo(p_user uuid, p_codigo text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_fallos int; v_hash text;
begin
  if p_user is null then return jsonb_build_object('ok', false, 'code', 'DENIED'); end if;
  -- Serializa los intentos de la misma persona (dos a la vez no se saltan el límite).
  perform pg_advisory_xact_lock(hashtext('mfa-recuperacion:' || p_user::text));
  select count(*) into v_fallos from public.mfa_recovery_attempts
   where user_id = p_user and not ok and at > now() - interval '15 minutes';
  if v_fallos >= 5 then
    perform public.wx_audit('USER', p_user::text, null, 'MFA_RECOVERY_USE', 'RATE_LIMITED', '{}');
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED');
  end if;
  v_hash := public.wx_mfa_hash(p_user, p_codigo);
  update public.mfa_recovery_codes set used_at = now()
   where user_id = p_user and code_hash = v_hash and used_at is null;
  if not found then
    insert into public.mfa_recovery_attempts (user_id, ok) values (p_user, false);
    perform public.wx_audit('USER', p_user::text, null, 'MFA_RECOVERY_USE', 'DENIED', '{}');
    return jsonb_build_object('ok', false, 'code', 'INVALID_CODE');
  end if;
  insert into public.mfa_recovery_attempts (user_id, ok) values (p_user, true);
  perform public.wx_audit('USER', p_user::text, null, 'MFA_RECOVERY_USE', 'OK',
    jsonb_build_object('restantes', (select count(*) from public.mfa_recovery_codes where user_id = p_user and used_at is null)));
  return jsonb_build_object('ok', true);
end $$;

/* Después de quitar los factores (owner-mfa), se registra el resultado. */
create or replace function public.mfa_recuperacion_completada(p_user uuid, p_factores_quitados int)
returns void language sql security definer set search_path = public as $$
  select public.wx_audit('USER', p_user::text, null, 'MFA_RECOVERED', 'OK',
    jsonb_build_object('factores_quitados', p_factores_quitados, 'factores_restantes', public.wx_mfa_factores(p_user)));
$$;

-- ------------------------------------------------------------------ permisos
do $$
declare f text;
begin
  foreach f in array array['wx_mfa_factores(uuid)', 'wx_mfa_bloqueo(uuid)', 'mfa_consumir_codigo(uuid, text)',
                           'mfa_recuperacion_completada(uuid, integer)', 'wx_actor_admin(jsonb)'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon, authenticated', f);
      execute format('grant execute on function public.%s to service_role', f);
    end if;
  end loop;
  foreach f in array array['mfa_generar_codigos()', 'mfa_estado()', 'mfa_registrar(text)',
    'owner_crear_evento(uuid, jsonb)', 'owner_evento_estado(uuid, uuid, text, boolean, text)', 'owner_asignar_personal(uuid, uuid, uuid, text, boolean)',
    'owner_codigo_tablet(uuid, uuid, text)', 'owner_revocar_dispositivo(uuid, uuid)', 'owner_resolver_clon(uuid, uuid, text)'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon', f);
      execute format('grant execute on function public.%s to authenticated, service_role', f);
    end if;
  end loop;
end $$;
