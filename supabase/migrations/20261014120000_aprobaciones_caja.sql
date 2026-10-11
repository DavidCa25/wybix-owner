-- ============================================================================
--  ROLES V2 · LA CAJA TAMBIÉN PIDE AUTORIZACIÓN A DISTANCIA
--
--  La autorización a distancia nació para las tablets de POS Mobile. Desde
--  Roles v2 la caja de escritorio la usa igual: un Operador pide un retiro, una
--  devolución, un ajuste o una promoción fuera de límite, y el dueño o un admin
--  la aprueba desde Owner (con AAL2, como siempre). El PIN del encargado en la
--  caja sigue siendo la otra vía, sin Internet.
--
--  Cambia una sola cosa de aprobacion_solicitar: con un equipo POS_PRIMARY o
--  POS_SECONDARY no se exige personal de feria (location_staff); quien pide es
--  la persona con sesión en esa caja. Lo demás -hash del payload, un solo uso,
--  mismo equipo, vencimiento, auditoría- queda igual.
-- ============================================================================

insert into public.approval_policies (action, etiqueta) values
  ('DEVOLUCION', 'hacer una devolución'), ('MODIFICAR_VENTA', 'modificar una venta'),
  ('ABRIR_CAJON', 'abrir el cajón sin venta'), ('COMPRA', 'registrar una compra'),
  ('PAGO_PROVEEDOR', 'pagar a un proveedor'), ('PROMOCION', 'guardar una promoción fuera de límite')
on conflict (action) do update set etiqueta = excluded.etiqueta;

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
  -- La CAJA de escritorio (POS_PRIMARY / POS_SECONDARY) no tiene personal de
  -- feria: quien pide es la persona con sesión en esa caja, y la caja ya está
  -- autenticada con su credencial. Basta con que diga quién es.
  if d.kind in ('POS_PRIMARY', 'POS_SECONDARY') then
    if nullif(btrim(coalesce(p->'requested_by'->>'name', '')), '') is null then
      return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
    end if;
  elsif v_emp is null or not exists (select 1 from public.location_staff ls join public.employees e on e.id = ls.employee_id
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


update public.notification_kinds set descripcion = 'Una caja o una tablet pide autorización a distancia'
 where kind = 'APPROVAL_REQUESTED';
