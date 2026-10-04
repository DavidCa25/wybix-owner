-- ============================================================================
--  FASE 3 · ETAPA 8 · FECHA DE NEGOCIO: la nube detecta lo que no cuadra
--
--  La tablet fija la fecha de negocio al abrir el turno (con la hora del
--  servidor si la conoce) y cada venta hereda la de su turno. La nube no
--  reescribe ventas: compara y AVISA.
--
--  Para cada venta sincronizada: hora real = occurred_at (crudo de la tablet)
--  + desfase que la nube midió de ESE equipo, en la zona de la ubicación.
--  Lo esperado: fecha de negocio = ese día, o el anterior (turno que cruzó la
--  medianoche). Otra cosa -> cloud_audit BUSINESS_DATE_SUSPECT + pendiente.
-- ============================================================================
create or replace function public.wx_fecha_verificar_venta() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_fecha date; v_real timestamptz; v_dia date; v_tz text; v_skew int;
begin
  if new.event_type <> 'SALE_RECORDED' or new.result <> 'APPLIED' or new.occurred_at is null then return new; end if;
  v_fecha := nullif(new.payload->>'business_date', '')::date;
  if v_fecha is null then return new; end if;
  select coalesce(s.timezone, 'America/Mexico_City') into v_tz from public.sucursales s where s.id = new.location_id;
  select coalesce(d.clock_skew_seconds, 0) into v_skew from public.devices d where d.id = new.device_id;
  v_real := new.occurred_at + make_interval(secs => coalesce(v_skew, 0));
  v_dia := (v_real at time zone coalesce(v_tz, 'America/Mexico_City'))::date;
  if v_fecha not in (v_dia, v_dia - 1) then
    perform public.wx_audit('DEVICE', new.device_id::text, new.company_id, 'BUSINESS_DATE_SUSPECT', 'WARN',
      jsonb_build_object('event_uuid', new.event_uuid, 'business_date', v_fecha, 'dia_real', v_dia, 'desfase_s', v_skew));
    perform public.wx_pendiente('BUSINESS_DATE_SUSPECT', new.event_uuid::text, new.company_id,
      jsonb_build_object('event_uuid', new.event_uuid, 'business_date', v_fecha, 'dia_real', v_dia, 'device_id', new.device_id));
  end if;
  return new;
exception when others then
  raise warning 'fecha de negocio: no se pudo verificar (%)', sqlstate;
  return new;
end $$;
revoke all on function public.wx_fecha_verificar_venta() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.wx_fecha_verificar_venta() from anon, authenticated; end if;
end $$;
drop trigger if exists wx_fecha_verificar on public.sync_events;
create trigger wx_fecha_verificar after insert on public.sync_events for each row
  when (new.event_type = 'SALE_RECORDED') execute function public.wx_fecha_verificar_venta();
