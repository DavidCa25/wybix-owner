-- ============================================================================
--  PANEL ADMIN: UNA SOLA PUERTA POR PETICIÓN (admin_gate)
-- ----------------------------------------------------------------------------
--  Antes cada petición del panel hacía tres viajes en serie antes de la
--  consulta: Auth (getUser), admin_whoami y admin_rate_hit. Ahora la Edge
--  Function verifica la firma del JWT localmente (llaves ES256 del proyecto) y
--  hace UN viaje aquí, que reúne lo que el JWT no puede decir por sí solo:
--
--    sesión   sigue viva en auth.sessions (cerrar sesión la invalida YA,
--             aunque el JWT no haya vencido) y es aal2
--    rol      fila activa en platform_admins
--    límite   misma ventana que admin_rate_hit
--
--  Devuelve { ok: true, role } o { ok: false, code }. Solo service_role.
--  Idempotente. Requiere 20261122120000_admin_plataforma.
-- ============================================================================

create or replace function public.admin_gate(
  p_user uuid, p_session uuid, p_limit int default 120, p_window_s int default 60)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare v_role text;
begin
  if p_session is null or not exists (
       select 1 from auth.sessions s
        where s.id = p_session and s.user_id = p_user
          and s.aal::text = 'aal2'
          and (s.not_after is null or s.not_after > now())) then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED');
  end if;

  select a.role into v_role from public.platform_admins a where a.user_id = p_user and a.active;
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_ADMIN');
  end if;

  if not public.admin_rate_hit(p_user, p_limit, p_window_s) then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMIT', 'role', v_role);
  end if;

  return jsonb_build_object('ok', true, 'role', v_role);
end $$;

revoke all on function public.admin_gate(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_gate(uuid, uuid, integer, integer) to service_role;
