-- ============================================================================
--  PRUEBAS DEL PANEL DE ADMINISTRACIÓN (20261122120000_admin_plataforma.sql)
--  Sobre la cadena completa de migraciones. Las corre scripts/probar-admin.mjs.
--  Cada comprobación imprime `ok|ID|mensaje` o `FALLA|ID|mensaje`.
-- ============================================================================
create or replace function pg_temp.t(p_id text, p_ok boolean, p_msg text) returns text
language sql as $$ select case when coalesce(p_ok, false) then 'ok' else 'FALLA' end || '|' || p_id || '|' || p_msg $$;

create or replace function pg_temp.t_admin() returns setof text language plpgsql as $$
declare
  v_owner uuid := gen_random_uuid(); v_op uuid := gen_random_uuid();
  r jsonb; v_lic uuid; v_key text; v_neg uuid; v_suc1 uuid; v_suc2 uuid; n int;
begin
  insert into auth.users (id, email) values (v_owner, 'owner@prueba.mx'), (v_op, 'op@prueba.mx');
  insert into public.platform_admins (user_id, role, created_by) values (v_owner, 'OWNER', 'prueba');

  -- ------------------------------------------------------------ privilegios
  return next pg_temp.t('AD-01', not has_table_privilege('anon', 'public.platform_admins', 'select')
                             and not has_table_privilege('authenticated', 'public.admin_audit', 'select')
                             and not has_table_privilege('authenticated', 'public.admin_rate', 'insert'),
                        'anon/authenticated sin acceso a las tablas del panel');
  return next pg_temp.t('AD-02', not has_function_privilege('authenticated', 'public.license_set_status(uuid, text, text, text)', 'execute')
                             and not has_function_privilege('anon', 'public.license_issue_manual(jsonb)', 'execute')
                             and not has_function_privilege('authenticated', 'public.admin_q_overview()', 'execute')
                             and has_function_privilege('service_role', 'public.admin_q_overview()', 'execute'),
                        'solo service_role ejecuta comandos y consultas');

  -- ------------------------------------------------------------ identidad
  return next pg_temp.t('AD-03', public.admin_whoami(v_owner)->>'role' = 'OWNER' and public.admin_whoami(v_op) is null,
                        'admin_whoami: OWNER sí, usuario sin fila no');
  r := public.platform_admin_set('op@prueba.mx', 'OPERATOR', true, v_owner);
  return next pg_temp.t('AD-04', (r->>'ok')::boolean and public.admin_whoami(v_op)->>'role' = 'OPERATOR', 'alta de OPERATOR por correo');
  r := public.platform_admin_set('owner@prueba.mx', 'VIEWER', true, v_owner);
  return next pg_temp.t('AD-05', r->>'code' = 'SELF', 'nadie se quita su propio OWNER');
  r := public.platform_admin_set('sin-cuenta-' || gen_random_uuid() || '@prueba.mx', 'VIEWER', true, v_owner);
  return next pg_temp.t('AD-06', r->>'code' = 'NOT_FOUND', 'correo sin cuenta: NOT_FOUND');

  -- ------------------------------------------------------------ auditoría y límite
  perform public.admin_audit_log(v_owner, 'OWNER', 'prueba', 'licencia:x', 'motivo', '{}', null, true, '1.2.3.4', 'ua');
  begin
    update public.admin_audit set ok = false;
    return next pg_temp.t('AD-07', false, 'admin_audit es de solo inserción');
  exception when insufficient_privilege then
    return next pg_temp.t('AD-07', true, 'admin_audit es de solo inserción');
  end;
  perform public.admin_rate_hit(v_op, 3, 60); perform public.admin_rate_hit(v_op, 3, 60); perform public.admin_rate_hit(v_op, 3, 60);
  return next pg_temp.t('AD-08', public.admin_rate_hit(v_op, 3, 60) = false, 'el cuarto intento con límite 3 se niega');

  -- ------------------------------------------------------------ emitir a mano
  r := public.license_issue_manual(jsonb_build_object('edition', 'EDITION_MULTI', 'vertical', 'COMMERCE', 'origin', 'PRODUCTION',
        'payment', jsonb_build_object('provider', 'COURTESY'), 'customer', jsonb_build_object('name', 'Taller Prueba'),
        'reason', 'cortesía de lanzamiento', 'actor', 'admin:' || v_owner));
  v_lic := (r->>'license_id')::uuid; v_key := r->>'license_key';
  return next pg_temp.t('AD-10', (r->>'ok')::boolean and v_key ~ '^WYBIX-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$',
                        'cortesía: emite con clave WYBIX-XXXX-XXXX-XXXX');
  return next pg_temp.t('AD-11', exists (select 1 from public.license_purchases where license_id = v_lic and price_paid = 0
                                           and payment_provider = 'COURTESY' and discount_reason = 'cortesía de lanzamiento'),
                        'cortesía: compra en 0 con el motivo como descuento');
  return next pg_temp.t('AD-12', exists (select 1 from public.license_events where license_id = v_lic and type = 'LICENSE_CREATED'
                                           and actor = 'admin:' || v_owner),
                        'el evento lleva la firma del administrador');
  r := public.license_issue_manual(jsonb_build_object('edition', 'EDITION_MONO', 'vertical', 'COMMERCE',
        'payment', jsonb_build_object('provider', 'TRANSFER', 'ref', 'SPEI-1', 'amount', 1000),
        'customer', jsonb_build_object('business', 'Abarrotes'), 'reason', 'pago por transferencia', 'actor', 'admin:x'));
  return next pg_temp.t('AD-13', (public.license_issue_manual(jsonb_build_object('edition', 'EDITION_MONO', 'vertical', 'COMMERCE',
        'payment', jsonb_build_object('provider', 'TRANSFER', 'ref', 'SPEI-1', 'amount', 1000),
        'customer', jsonb_build_object('business', 'Abarrotes'), 'reason', 'pago por transferencia', 'actor', 'admin:x'))->>'existing')::boolean,
                        'misma referencia de pago: no emite otra');
  r := public.license_issue_manual(jsonb_build_object('edition', 'EDITION_MONO', 'vertical', 'COMMERCE',
        'payment', jsonb_build_object('provider', 'TRANSFER'), 'customer', jsonb_build_object('name', 'X'), 'reason', 'sin referencia', 'actor', 'a'));
  return next pg_temp.t('AD-14', r->>'code' = 'BAD_REQUEST', 'transferencia sin referencia: BAD_REQUEST');
  r := public.license_issue_manual(jsonb_build_object('edition', 'EDITION_MONO', 'vertical', 'COMMERCE',
        'payment', jsonb_build_object('provider', 'COURTESY'), 'customer', jsonb_build_object('name', 'X'), 'reason', 'no', 'actor', 'a'));
  return next pg_temp.t('AD-15', r->>'code' = 'BAD_REQUEST', 'motivo corto: BAD_REQUEST');

  -- ------------------------------------------------------------ estado
  perform public.license_activate(v_key, 'MAQUINA-0001', 'Caja 1');
  perform public.license_activate(v_key, 'MAQUINA-0002', 'Caja 2');
  r := public.license_set_status(v_lic, 'suspendida', 'falta de pago', 'admin:x');
  return next pg_temp.t('AD-20', (r->>'ok')::boolean and public.license_for_machine('MAQUINA-0001')->>'code' = 'SUSPENDED',
                        'suspendida: el POS recibe SUSPENDED al refrescar');
  r := public.license_set_status(v_lic, 'activa', 'pagó el adeudo', 'admin:x');
  return next pg_temp.t('AD-21', (public.license_for_machine('MAQUINA-0001')->>'ok')::boolean, 'reactivada: vuelve a validar');
  return next pg_temp.t('AD-22', (public.license_set_status(v_lic, 'activa', 'otra vez igual', 'admin:x')->>'unchanged')::boolean,
                        'mismo estado: sin cambio');
  return next pg_temp.t('AD-23', (select count(*) from public.license_events where license_id = v_lic and type = 'STATUS_CHANGED') = 2,
                        'cada cambio de estado deja evento');

  -- ------------------------------------------------------------ edición y titular
  r := public.license_downgrade_to_mono(v_lic, 'cliente pidió bajar', 'admin:x');
  return next pg_temp.t('AD-24', r->>'code' = 'DEVICES_OVER_LIMIT' and (r->>'active')::int = 2, 'bajar a MonoCaja con 2 cajas: se niega');
  perform public.license_release(v_lic, 'MAQUINA-0002', 'admin:x');
  r := public.license_downgrade_to_mono(v_lic, 'cliente pidió bajar', 'admin:x');
  return next pg_temp.t('AD-25', (r->>'ok')::boolean and (select plan from public.licenses where id = v_lic) = 'mono',
                        'con una caja: baja a MonoCaja');
  r := public.license_update_customer(v_lic, '{"email":"Nuevo@Correo.mx","phone":"5512345678"}', 'cambio de correo', 'admin:x');
  return next pg_temp.t('AD-26', (r->>'ok')::boolean and (select customer_email from public.licenses where id = v_lic) = 'nuevo@correo.mx'
                             and (select customer_name from public.licenses where id = v_lic) = 'Taller Prueba',
                        'titular: cambia solo lo enviado');
  return next pg_temp.t('AD-27', public.license_update_customer(v_lic, '{"email":"malo"}', 'cambio de correo', 'admin:x')->>'code' = 'BAD_REQUEST',
                        'correo inválido: BAD_REQUEST');
  perform public.license_set_origin(v_lic, 'INTERNAL', 'es de la casa', 'admin:x');
  perform public.license_set_addon(v_lic, 'MULTIBRANCH', true, 'multisucursal de cortesía', 'admin:x');
  return next pg_temp.t('AD-28', (select origin = 'INTERNAL' and 'MULTIBRANCH' = any (addons) from public.licenses where id = v_lic),
                        'origen y complemento');
  return next pg_temp.t('AD-29', public.license_set_addon(v_lic, 'OTRO', true, 'no existe ese', 'admin:x')->>'code' = 'BAD_REQUEST',
                        'complemento desconocido: BAD_REQUEST');

  -- ------------------------------------------------------------ pruebas y releases
  insert into public.device_trials (machine_id, business_name, expires_at, status)
  values ('PRUEBA-0001', 'Prueba', now() - interval '2 days', 'expired');
  r := public.device_trial_extend('PRUEBA-0001', 7, 'cliente pidió más días', 'admin:x');
  return next pg_temp.t('AD-30', (r->>'ok')::boolean and (select status = 'active' and expires_at > now() + interval '6 days'
                                                            from public.device_trials where machine_id = 'PRUEBA-0001'),
                        'prueba vencida: se reabre desde hoy');
  return next pg_temp.t('AD-31', public.device_trial_extend('PRUEBA-0001', 200, 'demasiados días', 'admin:x')->>'code' = 'BAD_REQUEST',
                        'más de 90 días: BAD_REQUEST');
  r := public.app_release_upsert('pos-mobile', 'production', '9.0.0', '9.1.0', null, 'admin:x');
  return next pg_temp.t('AD-32', r->>'code' = 'BAD_REQUEST', 'mínima mayor que la última: se niega');
  perform public.app_release_upsert('pos-mobile', 'production', '9.0.0', '8.0.0', 'notas', 'admin:x');
  return next pg_temp.t('AD-33', public.app_release_upsert('pos-mobile', 'production', '1.0.0', '1.0.0', null, 'admin:x')->>'code' = 'DOWNGRADE',
                        'no se publica una versión menor');

  -- ------------------------------------------------------------ menú en línea
  insert into public.negocios (nombre) values ('Negocio Admin') returning id into v_neg;
  insert into public.sucursales (negocio_id, nombre, device_key) values (v_neg, 'A', 'dk-admin-a-' || gen_random_uuid()) returning id into v_suc1;
  insert into public.sucursales (negocio_id, nombre, device_key) values (v_neg, 'B', 'dk-admin-b-' || gen_random_uuid()) returning id into v_suc2;
  insert into public.menu_publicaciones (location_id, company_id, slug, activo) values (v_suc1, v_neg, 'admin-uno', true), (v_suc2, v_neg, 'admin-dos', true);
  return next pg_temp.t('AD-40', public.menu_admin_update(v_suc1, '{"slug":"admin-dos"}', 'cambio de slug', 'admin:x')->>'code' = 'SLUG_TAKEN',
                        'slug ocupado: SLUG_TAKEN');
  r := public.menu_admin_update(v_suc1, '{"activo":false}', 'contenido inapropiado', 'admin:x');
  return next pg_temp.t('AD-41', (r->>'ok')::boolean and not (select activo from public.menu_publicaciones where location_id = v_suc1),
                        'despublicar un menú');
  r := public.owner_app_quota_set(v_neg, 3, 'compró 2 apps extra', 'admin:x');
  return next pg_temp.t('AD-42', (r->>'ok')::boolean and (select total_apps from public.negocio_app_quota where negocio_id = v_neg::text) = 3,
                        'cupo de apps');

  -- ------------------------------------------------------------ consultas
  return next pg_temp.t('AD-50', (public.admin_q_overview()->'licencias'->>'activas')::int >= 1, 'tablero con contadores');
  r := public.admin_q_licencias(right(v_key, 4), null, null, 10, 0);
  return next pg_temp.t('AD-51', (r->>'total')::int >= 1 and r->'rows'->0->>'license_key' = v_key, 'buscar por parte de la clave');
  r := public.admin_q_licencia(v_lic);
  return next pg_temp.t('AD-52', r->'license'->>'license_key' = v_key and jsonb_array_length(r->'equipos') = 2
                             and jsonb_array_length(r->'eventos') > 3,
                        'detalle con equipos y bitácora');
  return next pg_temp.t('AD-53', public.admin_q_licencia(gen_random_uuid()) is null, 'licencia inexistente: null');
  r := public.admin_q_negocio(v_neg);
  return next pg_temp.t('AD-54', jsonb_array_length(r->'sucursales') = 2 and (r->>'apps_cupo')::int = 3, 'detalle de negocio');
  return next pg_temp.t('AD-55', jsonb_typeof(public.admin_q_comercial(12)->'por_mes') = 'array'
                             and jsonb_typeof(public.admin_q_plataforma()->'releases') = 'array'
                             and jsonb_typeof(public.admin_q_catalogo()->'productos') = 'array'
                             and jsonb_typeof(public.admin_q_revision()) = 'array'
                             and jsonb_typeof(public.admin_q_adaptaciones(true)) = 'array'
                             and jsonb_typeof(public.admin_q_pruebas(null, false, 10)) = 'array'
                             and jsonb_typeof(public.admin_q_auditoria(10, null, null)) = 'array'
                             and (select count(*) from jsonb_array_elements(public.admin_q_admins())) = 2,
                        'todas las consultas responden');

  -- ------------------------------------------------------------ puerta (20261123120000_admin_gate)
  declare v_s2 uuid := gen_random_uuid(); v_s1 uuid := gen_random_uuid(); v_sv uuid := gen_random_uuid(); v_nadie uuid := gen_random_uuid();
  begin
    insert into auth.users (id, email) values (v_nadie, 'nadie-' || v_nadie || '@prueba.mx');
    insert into auth.sessions (id, user_id, aal, not_after) values
      (v_s2, v_owner, 'aal2', null), (v_s1, v_owner, 'aal1', null), (v_sv, v_owner, 'aal2', now() - interval '1 minute');
    insert into auth.sessions (user_id, aal) values (v_nadie, 'aal2');
    r := public.admin_gate(v_owner, v_s2, 120, 60);
    return next pg_temp.t('AD-60', (r->>'ok')::boolean and r->>'role' = 'OWNER', 'admin_gate: sesión aal2 viva de un OWNER pasa con su rol');
    return next pg_temp.t('AD-61', public.admin_gate(v_owner, gen_random_uuid(), 120, 60)->>'code' = 'UNAUTHORIZED'
                               and public.admin_gate(v_owner, null, 120, 60)->>'code' = 'UNAUTHORIZED',
                          'sesión cerrada o sin session_id: UNAUTHORIZED');
    return next pg_temp.t('AD-62', public.admin_gate(v_owner, v_s1, 120, 60)->>'code' = 'UNAUTHORIZED'
                               and public.admin_gate(v_owner, v_sv, 120, 60)->>'code' = 'UNAUTHORIZED'
                               and public.admin_gate(v_op, v_s2, 120, 60)->>'code' = 'UNAUTHORIZED',
                          'sesión aal1, vencida o de otro usuario: UNAUTHORIZED');
    return next pg_temp.t('AD-63', public.admin_gate(v_nadie, (select id from auth.sessions where user_id = v_nadie), 120, 60)->>'code' = 'NOT_ADMIN',
                          'usuario sin fila en platform_admins: NOT_ADMIN');
    delete from public.admin_rate where actor_id = v_owner;
    perform public.admin_gate(v_owner, v_s2, 2, 60); perform public.admin_gate(v_owner, v_s2, 2, 60);
    return next pg_temp.t('AD-64', public.admin_gate(v_owner, v_s2, 2, 60)->>'code' = 'RATE_LIMIT', 'admin_gate aplica el límite por minuto');
    return next pg_temp.t('AD-65', not has_function_privilege('authenticated', 'public.admin_gate(uuid, uuid, integer, integer)', 'execute')
                               and not has_function_privilege('anon', 'public.admin_gate(uuid, uuid, integer, integer)', 'execute')
                               and has_function_privilege('service_role', 'public.admin_gate(uuid, uuid, integer, integer)', 'execute'),
                          'admin_gate solo para service_role');
  end;
  return;
end $$;

begin;
select * from pg_temp.t_admin();
rollback;
