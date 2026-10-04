-- ============================================================================
--  FASE 3 · ETAPAS 4-6 · MOTOR DE NOTIFICACIONES (push y correo)
--
--    evento de dominio -> regla -> notification_outbox -> notification_deliveries
--                      -> proveedor (Expo / correo) -> recibo
--
--  * notification_outbox (Fase 1) sigue siendo EL evento: uno por hecho
--    (unique kind+ref_uuid). Lo escriben el corte (SHIFT_CLOSED, ya existía)
--    y ahora también: equipo dado de baja, operación rechazada y operación en
--    cuarentena (triggers sobre cloud_audit y sync_events, sin tocar ingest).
--  * notification_kinds: la REGLA de cada tipo (roles que lo reciben, canales,
--    vigencia). Datos, no código.
--  * notification_preferences: cada persona apaga lo que no quiere, por
--    empresa, tipo y canal. Sin fila = lo que diga la regla.
--  * notification_deliveries: una fila por destinatario y canal, con estado,
--    intentos, próximo intento (backoff), arrendamiento y referencia del
--    proveedor. unique(outbox, canal, destino) = nunca dos veces lo mismo.
--  * Privacidad: el texto de un push no lleva importes ni nombres de
--    personas; el detalle se ve dentro de la app.
--  * Los tokens de push NO dan permisos: el destinatario sale de la
--    membresía ACTIVA con el rol de la regla y acceso a esa ubicación.
--
--  Solo la función `notificaciones` (service_role) planea, toma y reporta.
--  Idempotente.
-- ============================================================================

-- ------------------------------------------------------------------ reglas
create table if not exists public.notification_kinds (
  kind text primary key,
  descripcion text not null,
  roles text[] not null default array['OWNER', 'ADMIN'],
  canales text[] not null default array['push', 'email'],
  activo boolean not null default true,
  vigencia interval not null default interval '24 hours'
);
insert into public.notification_kinds (kind, descripcion, roles, canales, vigencia) values
  ('SHIFT_CLOSED',      'Corte de caja cerrado (con o sin diferencia)',          array['OWNER', 'ADMIN'], array['push', 'email'], interval '24 hours'),
  ('DEVICE_REVOKED',    'Un equipo de la empresa fue dado de baja',              array['OWNER', 'ADMIN'], array['push', 'email'], interval '24 hours'),
  ('SYNC_REJECTED',     'La nube rechazó una operación de un equipo',            array['OWNER', 'ADMIN'], array['push'],          interval '24 hours'),
  ('SYNC_QUARANTINED',  'Una operación quedó en cuarentena (equipo revocado)',   array['OWNER', 'ADMIN'], array['push'],          interval '24 hours')
on conflict (kind) do update set descripcion = excluded.descripcion;

-- ------------------------------------------------------------- preferencias
create table if not exists public.notification_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.negocios(id) on delete cascade,
  kind text not null references public.notification_kinds(kind) on delete cascade,
  canal text not null check (canal in ('push', 'email')),
  activo boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, company_id, kind, canal)
);
alter table public.notification_preferences enable row level security;
drop policy if exists "cada quien sus preferencias" on public.notification_preferences;
create policy "cada quien sus preferencias" on public.notification_preferences for all to authenticated
  using (user_id = auth.uid() and public.wx_es_miembro(company_id))
  with check (user_id = auth.uid() and public.wx_es_miembro(company_id));

-- ------------------------------------------------------------- push tokens
alter table public.push_tokens add column if not exists disabled_at timestamptz;
alter table public.push_tokens add column if not exists last_error text;
alter table public.push_tokens add column if not exists updated_at timestamptz not null default now();
-- Las políticas de producción (creadas a mano, sin versionar) no tenían UPDATE:
-- el upsert de la app fallaba al volver a registrar el mismo token. Se versionan.
alter table public.push_tokens enable row level security;
drop policy if exists "dueno ve sus tokens" on public.push_tokens;
drop policy if exists "dueno inserta sus tokens" on public.push_tokens;
drop policy if exists "dueno borra sus tokens" on public.push_tokens;
drop policy if exists "cada quien sus tokens" on public.push_tokens;
create policy "cada quien sus tokens" on public.push_tokens for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ------------------------------------------------------------------ outbox
alter table public.notification_outbox add column if not exists planned_at timestamptz;
alter table public.notification_outbox drop constraint if exists notification_outbox_status_check;
alter table public.notification_outbox add constraint notification_outbox_status_check
  check (status in ('PENDING', 'PLANNED', 'SENT', 'FAILED', 'SKIPPED'));

-- ---------------------------------------------------------------- entregas
create table if not exists public.notification_deliveries (
  id bigserial primary key,
  outbox_id bigint not null references public.notification_outbox(id) on delete cascade,
  company_id uuid not null,
  user_id uuid not null,
  canal text not null check (canal in ('push', 'email')),
  destino text not null,
  titulo text not null,
  cuerpo text not null,
  datos jsonb not null default '{}',
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'DEAD', 'SKIPPED')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  provider_ref text,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  receipt_at timestamptz,
  unique (outbox_id, canal, destino)
);
create index if not exists ix_notif_deliveries_cola on public.notification_deliveries (canal, status, next_attempt_at);
create index if not exists ix_notif_deliveries_recibo on public.notification_deliveries (canal, status, sent_at) where provider_ref is not null and receipt_at is null;
alter table public.notification_deliveries enable row level security;          -- sin políticas: solo service_role

-- ------------------------------------------------------- texto (privacidad)
/* Título y cuerpo SIN importes ni nombres de personas: un push se lee en la
   pantalla bloqueada. El detalle está en la app. */
create or replace function public.wx_notif_texto(p_kind text, p_payload jsonb, p_ubicacion text)
returns jsonb language plpgsql immutable as $$
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
  end if;
  return jsonb_build_object('titulo', 'Aviso de Wybix', 'cuerpo', u || '.');
end $$;

-- ------------------------------------------------------- fuentes de eventos
create or replace function public.wx_notif_desde_auditoria() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_dev public.devices%rowtype; v_ref uuid;
begin
  begin
    if new.action = 'DEVICE_REVOKED' and new.result = 'OK' then
      v_ref := public.wx_uuid(new.detail->>'device_id');
      select * into v_dev from public.devices where id = v_ref;
      if v_ref is not null and found then
        insert into public.notification_outbox (company_id, location_id, kind, ref_uuid, payload)
        values (v_dev.company_id, v_dev.location_id, 'DEVICE_REVOKED', v_ref, jsonb_build_object('device_kind', v_dev.kind))
        on conflict (kind, ref_uuid) do nothing;
      end if;
    elsif new.action = 'SYNC_EVENT' and new.result = 'DENIED' and new.actor_kind = 'DEVICE' then
      v_ref := public.wx_uuid(new.detail->>'event_uuid');
      select * into v_dev from public.devices where id = public.wx_uuid(new.actor_id);
      if v_ref is not null and found then
        insert into public.notification_outbox (company_id, location_id, kind, ref_uuid, payload)
        values (v_dev.company_id, v_dev.location_id, 'SYNC_REJECTED', v_ref, jsonb_build_object('aggregate', new.detail->>'aggregate'))
        on conflict (kind, ref_uuid) do nothing;
      end if;
    end if;
  exception when others then
    raise warning 'notificaciones: no se encoló el aviso de % (%)', new.action, sqlstate;   -- nunca tumba la auditoría
  end;
  return new;
end $$;
drop trigger if exists wx_notif_auditoria on public.cloud_audit;
create trigger wx_notif_auditoria after insert on public.cloud_audit for each row
  when (new.action in ('DEVICE_REVOKED', 'SYNC_EVENT')) execute function public.wx_notif_desde_auditoria();

create or replace function public.wx_notif_desde_cuarentena() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    insert into public.notification_outbox (company_id, location_id, kind, ref_uuid, payload)
    values (new.company_id, new.location_id, 'SYNC_QUARANTINED', new.event_uuid, jsonb_build_object('event_type', new.event_type))
    on conflict (kind, ref_uuid) do nothing;
  exception when others then
    raise warning 'notificaciones: no se encoló la cuarentena (%)', sqlstate;
  end;
  return new;
end $$;
drop trigger if exists wx_notif_cuarentena on public.sync_events;
create trigger wx_notif_cuarentena after insert on public.sync_events for each row
  when (new.result = 'QUARANTINED') execute function public.wx_notif_desde_cuarentena();

-- -------------------------------------------------------------- planear
/* De cada evento PENDING salen sus entregas. Devuelve cuántas entregas creó. */
create or replace function public.notif_planear(p_limite int default 200)
returns int language plpgsql volatile security definer set search_path = public as $$
declare o record; k public.notification_kinds%rowtype; t jsonb; n int := 0; v_ubic text; c text; m record; v_filas int;
begin
  for o in select * from public.notification_outbox where status = 'PENDING' order by id limit p_limite for update skip locked loop
    select * into k from public.notification_kinds where kind = o.kind;
    if not found or not k.activo or o.created_at < now() - k.vigencia then
      update public.notification_outbox set status = 'SKIPPED', planned_at = now() where id = o.id;
      continue;
    end if;
    select nombre into v_ubic from public.sucursales where id = o.location_id;
    t := public.wx_notif_texto(o.kind, o.payload, v_ubic);
    for m in
      select cm.user_id from public.company_memberships cm
       where cm.company_id = o.company_id and cm.status = 'ACTIVE' and cm.role = any (k.roles)
         and (o.location_id is null or cm.location_ids is null or o.location_id = any (cm.location_ids))
    loop
      foreach c in array k.canales loop
        if exists (select 1 from public.notification_preferences p where p.user_id = m.user_id and p.company_id = o.company_id
                     and p.kind = o.kind and p.canal = c and not p.activo) then continue; end if;
        if c = 'push' then
          insert into public.notification_deliveries (outbox_id, company_id, user_id, canal, destino, titulo, cuerpo, datos)
          select o.id, o.company_id, m.user_id, 'push', pt.token, t->>'titulo', t->>'cuerpo',
                 jsonb_build_object('kind', o.kind, 'ref', o.ref_uuid, 'company_id', o.company_id, 'location_id', o.location_id)
            from public.push_tokens pt where pt.owner_id = m.user_id and pt.disabled_at is null
          on conflict (outbox_id, canal, destino) do nothing;
        else
          insert into public.notification_deliveries (outbox_id, company_id, user_id, canal, destino, titulo, cuerpo, datos)
          select o.id, o.company_id, m.user_id, 'email', u.email, t->>'titulo', t->>'cuerpo',
                 jsonb_build_object('kind', o.kind, 'ref', o.ref_uuid, 'company_id', o.company_id, 'location_id', o.location_id)
            from auth.users u where u.id = m.user_id and u.email is not null and u.email <> ''
          on conflict (outbox_id, canal, destino) do nothing;
        end if;
        get diagnostics v_filas = row_count;
        n := n + v_filas;
      end loop;
    end loop;
    update public.notification_outbox set status = 'PLANNED', planned_at = now() where id = o.id;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------- tomar
/* Arrienda hasta p_limite entregas vencidas de un canal (2 minutos). Una
   entrega cuyo arrendamiento venció (el proceso murió) se vuelve a tomar. */
create or replace function public.notif_tomar(p_canal text, p_limite int default 100)
returns setof public.notification_deliveries language sql volatile security definer set search_path = public as $$
  update public.notification_deliveries d set status = 'SENDING', lease_until = now() + interval '2 minutes', attempts = d.attempts + 1
   where d.id in (select id from public.notification_deliveries
                   where canal = p_canal
                     and ((status = 'PENDING' and next_attempt_at <= now()) or (status = 'SENDING' and lease_until < now()))
                   order by id limit p_limite for update skip locked)
  returning d.*;
$$;

/* Espera antes del siguiente intento: 1 min, 5 min, 30 min, 2 h, 6 h. */
create or replace function public.wx_notif_espera(p_intentos int) returns interval language sql immutable as $$
  select case when p_intentos <= 1 then interval '1 minute' when p_intentos = 2 then interval '5 minutes'
              when p_intentos = 3 then interval '30 minutes' when p_intentos = 4 then interval '2 hours' else interval '6 hours' end
$$;

-- ------------------------------------------------------------- resultado
create or replace function public.notif_resultado(p_id bigint, p_ok boolean, p_ref text default null, p_error text default null,
                                                  p_permanente boolean default false, p_token_invalido boolean default false)
returns text language plpgsql volatile security definer set search_path = public as $$
declare d public.notification_deliveries%rowtype; v text;
begin
  select * into d from public.notification_deliveries where id = p_id for update;
  if not found or d.status not in ('SENDING', 'PENDING') then return 'IGNORADO'; end if;
  if p_ok then
    update public.notification_deliveries set status = 'SENT', provider_ref = p_ref, sent_at = now(), lease_until = null, last_error = null where id = p_id;
    return 'SENT';
  end if;
  if p_token_invalido and d.canal = 'push' then
    update public.push_tokens set disabled_at = now(), last_error = left(p_error, 300), updated_at = now() where token = d.destino;
  end if;
  if p_permanente or p_token_invalido or d.attempts >= 6 then
    update public.notification_deliveries set status = 'DEAD', last_error = left(p_error, 500), lease_until = null where id = p_id;
    perform public.wx_audit('SERVICE', 'notificaciones', d.company_id, 'NOTIFICATION_DEAD', 'FAILED',
      jsonb_build_object('delivery_id', d.id, 'canal', d.canal, 'intentos', d.attempts, 'error', left(p_error, 200)));
    v := 'DEAD';
  else
    update public.notification_deliveries set status = 'PENDING', last_error = left(p_error, 500), lease_until = null,
           next_attempt_at = now() + public.wx_notif_espera(d.attempts) where id = p_id;
    v := 'RETRY';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------- recibos
/* Pushes ya aceptados por Expo cuyo recibo aún no se revisa (Expo pide esperar ~15 min). */
create or replace function public.notif_por_recibo(p_limite int default 300, p_espera interval default interval '15 minutes')
returns table (id bigint, provider_ref text) language sql stable security definer set search_path = public as $$
  select id, provider_ref from public.notification_deliveries
   where canal = 'push' and status = 'SENT' and provider_ref is not null and receipt_at is null and sent_at <= now() - p_espera
   order by id limit p_limite
$$;

create or replace function public.notif_recibo(p_id bigint, p_ok boolean, p_error text default null, p_token_invalido boolean default false)
returns void language plpgsql volatile security definer set search_path = public as $$
declare d public.notification_deliveries%rowtype;
begin
  select * into d from public.notification_deliveries where id = p_id for update;
  if not found or d.status <> 'SENT' then return; end if;
  if p_ok then
    update public.notification_deliveries set status = 'DELIVERED', receipt_at = now() where id = p_id;
    return;
  end if;
  if p_token_invalido then
    update public.push_tokens set disabled_at = now(), last_error = left(p_error, 300), updated_at = now() where token = d.destino;
  end if;
  update public.notification_deliveries set status = 'DEAD', receipt_at = now(), last_error = left(p_error, 500) where id = p_id;
end $$;


-- ------------------------------------------------------------------ vencer
/* Una entrega que lleva más de p_horas esperando (canal sin configurar o
   proveedor caído días) ya no se manda: un aviso viejo confunde más que ayuda. */
create or replace function public.notif_vencer(p_horas int default 48)
returns int language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  update public.notification_deliveries set status = 'SKIPPED', last_error = 'VENCIDA', lease_until = null
   where status = 'PENDING' and created_at < now() - make_interval(hours => p_horas);
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------------------ permisos
do $$
declare f text;
begin
  foreach f in array array['notif_planear(integer)', 'notif_tomar(text, integer)', 'notif_resultado(bigint, boolean, text, text, boolean, boolean)',
                           'notif_por_recibo(integer, interval)', 'notif_recibo(bigint, boolean, text, boolean)', 'notif_vencer(integer)',
                           'wx_notif_desde_auditoria()', 'wx_notif_desde_cuarentena()'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon, authenticated', f);
      execute format('grant execute on function public.%s to service_role', f);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.notification_deliveries from anon, authenticated;
    revoke all on public.notification_kinds from anon;
    grant select on public.notification_kinds to authenticated;
    grant select, insert, update, delete on public.notification_preferences to authenticated;
    grant select, insert, update, delete on public.push_tokens to authenticated;
  end if;
end $$;
alter table public.notification_kinds enable row level security;
drop policy if exists "tipos visibles" on public.notification_kinds;
create policy "tipos visibles" on public.notification_kinds for select to authenticated using (true);
