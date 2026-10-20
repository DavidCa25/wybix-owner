-- ============================================================================
--  CORTE DE CAJA POR CORREO (detallado)
--
--  El POS, al cerrar un corte (o desde "Correos de cortes" para los
--  anteriores), llama a la función `corte-email` con los datos del corte. La
--  función arma el correo y lo manda a los dueños.
--
--  * Destinatarios: membresía OWNER ACTIVA de la empresa del equipo, con
--    acceso a la ubicación del equipo, y sin el aviso SHIFT_REPORT apagado en
--    notification_preferences. El POS no puede elegir a quién se manda.
--  * SHIFT_REPORT aparece solo en Owner > Avisos (canal email): cada dueño
--    puede apagarlo. No pasa por notification_outbox: el correo lleva
--    importes y nombres, y solo existe para quien lo pidió.
--  * Idempotencia: corte_mail_requests.id = el trabajo del POS (uno por corte)
--    y (company_id, closure_uuid) único: un corte se manda una sola vez.
--  * Límite: 120 cortes por hora por empresa (un reenvío de pendientes
--    grande se reparte en varias horas).
--
--  Solo service_role. Idempotente.
-- ============================================================================
begin;

insert into public.notification_kinds (kind, descripcion, roles, canales, vigencia) values
  ('SHIFT_REPORT', 'Corte de caja detallado por correo', array['OWNER'], array['email'], interval '24 hours')
on conflict (kind) do update set descripcion = excluded.descripcion;

create table if not exists public.corte_mail_requests (
  id uuid primary key,
  device_id uuid not null references public.devices(id),
  company_id uuid not null references public.negocios(id),
  location_id uuid,
  closure_uuid uuid not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT')),
  recipients int,
  provider_ids text[],
  created_at timestamptz not null default now(),
  reserved_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (company_id, closure_uuid)
);
create index if not exists ix_corte_mail_company_created on public.corte_mail_requests (company_id, created_at);
alter table public.corte_mail_requests enable row level security;
revoke all on public.corte_mail_requests from public, anon, authenticated;

/* Reserva el envío y devuelve a quién mandarlo.
   {ok, sent}                 ya salió: no se manda otra vez.
   {ok, sent:false, destinos} adelante.
   {ok:false, code}           DENIED | CONFLICT | BUSY | RATE_LIMIT | NO_RECIPIENTS */
create or replace function public.corte_mail_reserve(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; r public.corte_mail_requests%rowtype;
        k uuid := public.wx_uuid(p->>'id'); cu uuid := public.wx_uuid(p->>'closure_uuid'); v_dest text[];
begin
  select * into d from public.devices where id = public.wx_uuid(p->>'device_id') and status = 'ACTIVE' and kind in ('POS_PRIMARY', 'POS_SECONDARY');
  if d.id is null or k is null or cu is null
     or not exists (select 1 from public.negocios where id = d.company_id and status = 'ACTIVE')
     or not exists (select 1 from public.sucursales where id = d.location_id and status = 'ACTIVE') then
    return jsonb_build_object('ok', false, 'code', 'DENIED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('corte-email:' || d.company_id::text, 0));

  select * into r from public.corte_mail_requests where company_id = d.company_id and closure_uuid = cu for update;
  if found then
    if r.id <> k then
      -- El mismo corte con otro trabajo: ya salió o va saliendo; nunca dos correos.
      if r.status = 'SENT' then return jsonb_build_object('ok', true, 'sent', true, 'recipients', r.recipients); end if;
      return jsonb_build_object('ok', false, 'code', 'CONFLICT');
    end if;
    if r.status = 'SENT' then return jsonb_build_object('ok', true, 'sent', true, 'recipients', r.recipients); end if;
    if r.reserved_at > now() - interval '60 seconds' then return jsonb_build_object('ok', false, 'code', 'BUSY'); end if;
  else
    if (select count(*) from public.corte_mail_requests where company_id = d.company_id and created_at > now() - interval '1 hour') >= 120 then
      return jsonb_build_object('ok', false, 'code', 'RATE_LIMIT');
    end if;
  end if;

  select array_agg(distinct u.email) into v_dest
    from public.company_memberships cm
    join auth.users u on u.id = cm.user_id
   where cm.company_id = d.company_id and cm.status = 'ACTIVE' and cm.role = 'OWNER'
     and (cm.location_ids is null or d.location_id = any (cm.location_ids))
     and u.email is not null and u.email <> ''
     and not exists (select 1 from public.notification_preferences np
                      where np.user_id = cm.user_id and np.company_id = d.company_id
                        and np.kind = 'SHIFT_REPORT' and np.canal = 'email' and not np.activo);
  if v_dest is null or cardinality(v_dest) = 0 then return jsonb_build_object('ok', false, 'code', 'NO_RECIPIENTS'); end if;

  if r.id is null then
    insert into public.corte_mail_requests (id, device_id, company_id, location_id, closure_uuid)
    values (k, d.id, d.company_id, d.location_id, cu);
  else
    update public.corte_mail_requests set reserved_at = now() where id = k;
  end if;
  return jsonb_build_object('ok', true, 'sent', false, 'destinos', to_jsonb(v_dest[1:10]));
end $$;

create or replace function public.corte_mail_complete(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.corte_mail_requests
     set status = 'SENT', sent_at = now(),
         recipients = greatest(0, coalesce((p->>'recipients')::int, 0)),
         provider_ids = (select array_agg(left(x.v, 100)) from jsonb_array_elements_text(coalesce(p->'provider_ids', '[]'::jsonb)) as x(v))
   where id = public.wx_uuid(p->>'id') and device_id = public.wx_uuid(p->>'device_id');
  return jsonb_build_object('ok', found);
end $$;

revoke all on function public.corte_mail_reserve(jsonb), public.corte_mail_complete(jsonb) from public, anon, authenticated;
grant execute on function public.corte_mail_reserve(jsonb), public.corte_mail_complete(jsonb) to service_role;

commit;
