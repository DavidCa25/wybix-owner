-- ============================================================================
--  PRUEBAS DE LA FASE 3 EN LA NUBE
--  Corre después de fase1.test.sql y fase2.test.sql sobre la misma base, de
--  fase3-antes.sql y de aplicar DOS veces las migraciones de la Fase 3.
--  Mismo protocolo: t_check deja filas en t_res; al final, ok|id|msg o FALLA|...
-- ============================================================================
set timezone = 'America/Mexico_City';

-- ---------------------------------------------------------------- PUSH · 0.5
create or replace function t_alerta() returns uuid language sql as $$
  insert into public.alertas (sucursal_id, tipo, titulo, mensaje)
  values ((select id from public.sucursales where nombre = 'Centro' limit 1), 'REFUND', 'Devolución', 'Prueba')
  returning id $$;

select t_check('F3-PUSH01',
  not exists (select 1 from pg_trigger where tgrelid = 'public.alertas'::regclass and not tgisinternal
              and (tgname = 'alerta-push' or encode(tgargs, 'escape') like '%x-webhook-secret%')),
  'el trigger del panel con el secreto escrito ya no existe; ningún trigger de alertas lleva el secreto en su definición');
select t_check('F3-PUSH02',
  (select count(*) from pg_trigger where tgrelid = 'public.alertas'::regclass and tgname = 'wx_alerta_push') = 1,
  'hay exactamente un trigger de push (la migración se aplicó dos veces)');

-- Sin configuración en Vault: la alerta se guarda y NO se llama a nadie.
delete from vault.t_secretos; delete from net.t_llamadas;
select t_alerta();
select t_check('F3-PUSH03', (select count(*) from net.t_llamadas) = 0,
  'sin URL ni secreto en Vault: la alerta se guarda y no se envía nada (falla cerrado)');

-- Secreto corto o URL sin https: tampoco.
insert into vault.t_secretos values ('wybix_alerta_push_url', 'https://proyecto.supabase.co/functions/v1/send-alert-push'),
                                    ('wybix_webhook_secret', 'corto');
select t_alerta();
update vault.t_secretos set decrypted_secret = repeat('s', 40) where name = 'wybix_webhook_secret';
update vault.t_secretos set decrypted_secret = 'http://proyecto/functions/v1/send-alert-push' where name = 'wybix_alerta_push_url';
select t_alerta();
select t_check('F3-PUSH04', (select count(*) from net.t_llamadas) = 0,
  'secreto de menos de 32 caracteres o URL sin https: no se envía');

-- Configurado: una llamada por alerta, con la cabecera desde Vault.
update vault.t_secretos set decrypted_secret = 'https://proyecto.supabase.co/functions/v1/send-alert-push' where name = 'wybix_alerta_push_url';
create temp table t_ultima as select t_alerta() as id;
select t_check('F3-PUSH05',
  (select count(*) from net.t_llamadas) = 1
  and (select headers->>'x-webhook-secret' from net.t_llamadas) = repeat('s', 40)
  and (select url from net.t_llamadas) = 'https://proyecto.supabase.co/functions/v1/send-alert-push'
  and (select body->'record'->>'id' from net.t_llamadas) = (select id::text from t_ultima)
  and (select body->>'table' from net.t_llamadas) = 'alertas',
  'con Vault configurado: una llamada por alerta, con la cabecera tomada de Vault y el registro insertado');

-- pg_net falla: la alerta se guarda igual.
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
                                         headers jsonb default '{}', timeout_milliseconds int default 2000)
returns bigint language plpgsql as $$ begin raise exception 'pg_net caído'; end $$;
create temp table t_antes as select count(*) as n from public.alertas;
select t_alerta();
select t_check('F3-PUSH06', (select count(*) from public.alertas) = (select n + 1 from t_antes),
  'si pg_net falla, la alerta se guarda igual (el push nunca tumba la inserción)');

select t_check('F3-PUSH07',
  not has_function_privilege('anon', 'public.wx_alerta_push()', 'execute')
  and not has_function_privilege('authenticated', 'public.wx_alerta_push()', 'execute'),
  'nadie desde la API puede ejecutar la función del trigger');

-- ---------------------------------------------------------------- MFA · 3
-- t_q con nivel de sesión: como t_q de la Fase 1, pero el JWT lleva `aal`.
create or replace function t_qa(p_user uuid, p_aal text, p_sql text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  set local role authenticated;
  begin execute p_sql into r;
  exception when others then reset role; return 'ERR:' || sqlstate; end;
  reset role;
  return r;
end $$;
create or replace function t_duena() returns uuid language sql as $$ select 'a0000000-0000-0000-0000-00000000000a'::uuid $$;
create or replace function t_estado_feria() returns text language sql as $$
  select event_status from public.sucursales where id = (t_s('feria', 'location_id'))::uuid $$;
create temp table t_feria0 as select t_estado_feria() as s;

-- Sin factor: MFA_ENROLL_REQUIRED y no cambia nada.
delete from auth.mfa_factors where user_id = t_duena();
select t_check('F3-MFA01',
  t_qa(t_duena(), 'aal1', format('select owner_codigo_tablet(%L, %L)->>''code''', t_s('centro', 'company_id'), t_s('feria', 'location_id'))) = 'MFA_ENROLL_REQUIRED'
  and t_qa(t_duena(), 'aal1', format('select owner_evento_estado(%L, %L, ''OPEN'')->>''code''', t_s('centro', 'company_id'), t_s('feria', 'location_id'))) = 'MFA_ENROLL_REQUIRED'
  and t_estado_feria() = (select s from t_feria0),
  'la dueña SIN segundo factor no administra (MFA_ENROLL_REQUIRED) y el evento no cambia');

-- Un factor sin verificar no cuenta.
insert into auth.mfa_factors (user_id, status) values (t_duena(), 'unverified');
select t_check('F3-MFA02',
  t_qa(t_duena(), 'aal1', format('select owner_codigo_tablet(%L, %L)->>''code''', t_s('centro', 'company_id'), t_s('feria', 'location_id'))) = 'MFA_ENROLL_REQUIRED',
  'un factor TOTP a medio enrolar (sin verificar) no cuenta');

-- Factor verificado, sesión AAL1: MFA_REQUIRED.
update auth.mfa_factors set status = 'verified' where user_id = t_duena();
select t_check('F3-MFA03',
  t_qa(t_duena(), 'aal1', format('select owner_codigo_tablet(%L, %L)->>''code''', t_s('centro', 'company_id'), t_s('feria', 'location_id'))) = 'MFA_REQUIRED'
  and t_qa(t_duena(), 'aal1', format('select owner_revocar_dispositivo(%L, gen_random_uuid())->>''code''', t_s('centro', 'company_id'))) = 'MFA_REQUIRED'
  and t_estado_feria() = (select s from t_feria0),
  'con factor pero sesión AAL1: MFA_REQUIRED en cada operación administrativa');

-- AAL2: pasa.
select t_set('feria3', (t_qa(t_duena(), 'aal2', format('select owner_crear_evento(%L, jsonb_build_object(''nombre'', ''Feria Fase 3'', ''home_location_id'', %L, ''codigo'', ''FF3''))::text',
  t_s('centro', 'company_id'), t_s('centro', 'location_id'))))::jsonb);
select t_check('F3-MFA04',
  (t_s('feria3', 'ok'))::boolean
  and t_qa(t_duena(), 'aal2', format('select owner_evento_estado(%L, %L, ''OPEN'')->>''ok''', t_s('centro', 'company_id'), t_s('feria3', 'location_id'))) = 'true'
  and t_qa(t_duena(), 'aal2', format('select owner_asignar_personal(%L, %L, %L, ''CASHIER'')->>''ok''', t_s('centro', 'company_id'), t_s('feria3', 'location_id'), t_get('lupita_emp')#>>'{}')) = 'true'
  and t_qa(t_duena(), 'aal2', format('select coalesce(owner_codigo_tablet(%L, %L)->>''code'', ''ok'')', t_s('centro', 'company_id'), t_s('feria3', 'location_id'))) not like 'MFA%',
  'con sesión AAL2 la dueña crea un evento, lo abre y le asigna personal (el código de tablet ya solo lo frenan las licencias, no el MFA)');

-- La autoridad sigue siendo el rol: AAL2 no convierte a nadie en dueño.
insert into auth.mfa_factors (user_id, status) values ('e0000000-0000-0000-0000-00000000000e', 'verified');
select t_check('F3-MFA05',
  coalesce(t_qa('e0000000-0000-0000-0000-00000000000e', 'aal2',
           format('select owner_codigo_tablet(%L, %L)->>''code''', t_s('centro', 'company_id'), t_s('feria', 'location_id'))), '') in ('DENIED', 'ERR:42501'),
  'alguien SIN membresía de dueño/admin, aun con AAL2, sigue sin poder');

-- Defensa en profundidad: wx_actor_admin exige AAL2 del MISMO usuario aunque lo llame otro camino.
do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'e0000000-0000-0000-0000-00000000000e', 'aal', 'aal2')::text, true);
  perform t_set('actor_ajeno', coalesce(public.wx_actor_admin(jsonb_build_object('user_id', t_duena(), 'company_id', t_s('centro', 'company_id'))), 'null'::jsonb));
  perform set_config('request.jwt.claims', json_build_object('sub', t_duena(), 'aal', 'aal1')::text, true);
  perform t_set('actor_aal1', coalesce(public.wx_actor_admin(jsonb_build_object('user_id', t_duena(), 'company_id', t_s('centro', 'company_id'))), 'null'::jsonb));
  perform set_config('request.jwt.claims', '', true);
  perform t_set('actor_equipo', coalesce(public.wx_actor_admin(jsonb_build_object('device_id', t_s('centro', 'device_id'))), 'null'::jsonb));
end $$;
select t_check('F3-MFA06',
  t_get('actor_ajeno') = 'null'::jsonb and t_get('actor_aal1') = 'null'::jsonb and t_get('actor_equipo')->>'kind' = 'DEVICE',
  'wx_actor_admin: la sesión AAL2 de OTRA persona no sirve, AAL1 no sirve, y el POS principal (dispositivo) no cambia');

select t_check('F3-MFA07',
  t_qa(t_duena(), 'aal2', 'select (mfa_consumir_codigo(gen_random_uuid(), ''x''))::text') = 'ERR:42501'
  and t_qa(t_duena(), 'aal2', format('select wx_mfa_bloqueo(%L)::text', t_duena())) = 'ERR:42501'
  and t_qa(t_duena(), 'aal2', 'select count(*)::text from mfa_recovery_codes') = 'ERR:42501',
  'desde la app no se consumen códigos, no se consulta el bloqueo ajeno ni se leen los hashes');

select t_check('F3-MFA08',
  t_qa(t_duena(), 'aal1', format('select (resumen_empresa(%L) is not null)::text', t_s('centro', 'company_id'))) = 'true',
  'las LECTURAS del dueño siguen en AAL1 (el tablero abre sin pedir el código)');

-- Códigos de recuperación.
select t_check('F3-MFA09', t_qa(t_duena(), 'aal1', 'select mfa_generar_codigos()->>''code''') = 'MFA_REQUIRED',
  'generar códigos de recuperación exige AAL2');
select t_set('codigos', (t_qa(t_duena(), 'aal2', 'select mfa_generar_codigos()::text'))::jsonb);
select t_check('F3-MFA10',
  jsonb_array_length(t_get('codigos')->'codigos') = 10
  and (select count(distinct x) from jsonb_array_elements_text(t_get('codigos')->'codigos') x) = 10
  and (select bool_and(x ~ '^[0-9A-F]{5}-[0-9A-F]{5}$') from jsonb_array_elements_text(t_get('codigos')->'codigos') x)
  and (select count(*) from mfa_recovery_codes where user_id = t_duena()) = 10
  and not exists (select 1 from mfa_recovery_codes where code_hash in (select x from jsonb_array_elements_text(t_get('codigos')->'codigos') x)),
  '10 códigos distintos, formato XXXXX-XXXXX; en la base solo hay hashes');

select t_check('F3-MFA11',
  mfa_consumir_codigo(t_duena(), lower(replace(t_get('codigos')->'codigos'->>0, '-', ' ')))->>'ok' = 'true'
  and mfa_consumir_codigo(t_duena(), t_get('codigos')->'codigos'->>0)->>'code' = 'INVALID_CODE',
  'un código sirve una sola vez (en minúsculas o con espacios también)');

select mfa_consumir_codigo(t_duena(), 'AAAAA-BBBBB') from generate_series(1, 4);
select t_check('F3-MFA12',
  mfa_consumir_codigo(t_duena(), t_get('codigos')->'codigos'->>1)->>'code' = 'RATE_LIMITED'
  and (select used_at is null from mfa_recovery_codes where user_id = t_duena() and code_hash = wx_mfa_hash(t_duena(), t_get('codigos')->'codigos'->>1)),
  'tras 5 intentos fallidos en 15 min, ni el código correcto pasa (y no se gasta)');

delete from mfa_recovery_attempts where user_id = t_duena();
select t_set('codigos2', (t_qa(t_duena(), 'aal2', 'select mfa_generar_codigos()::text'))::jsonb);
select t_check('F3-MFA13',
  mfa_consumir_codigo(t_duena(), t_get('codigos')->'codigos'->>2)->>'code' = 'INVALID_CODE'
  and mfa_consumir_codigo(t_duena(), t_get('codigos2')->'codigos'->>0)->>'ok' = 'true',
  'generar códigos nuevos invalida los anteriores');

select t_check('F3-MFA14',
  (select count(*) from cloud_audit where actor_id = t_duena()::text and action = 'MFA_RECOVERY_USE' and result = 'OK') >= 2
  and (select count(*) from cloud_audit where actor_id = t_duena()::text and action = 'MFA_RECOVERY_USE' and result = 'RATE_LIMITED') >= 1
  and (select count(*) from cloud_audit where actor_id = t_duena()::text and action = 'MFA_RECOVERY_GENERATE' and result = 'DENIED') >= 1
  and not exists (select 1 from cloud_audit c, jsonb_array_elements_text(t_get('codigos2')->'codigos') x where c.detail::text like '%' || x || '%'),
  'la auditoría registra generación, uso, rechazo y bloqueo, sin ningún código en claro');

select t_set('registro', jsonb_build_object('ok', t_qa(t_duena(), 'aal2', 'select mfa_registrar(''ENROLLED'')->>''ok'''),
                                             'malo', t_qa(t_duena(), 'aal2', 'select mfa_registrar(''LO_QUE_SEA'')->>''code''')));
select t_check('F3-MFA15',
  (t_qa(t_duena(), 'aal2', 'select mfa_estado()::text'))::jsonb @> '{"factores": 1, "aal": "aal2", "codigos_restantes": 9}'
  and t_s('registro', 'ok') = 'true' and t_s('registro', 'malo') = 'BAD_REQUEST'
  and (select detail->>'factores_verificados' from cloud_audit where action = 'MFA_ENROLLED' order by id desc limit 1) = '1',
  'estado para la app y registro de eventos con lo que ve la base (no lo que dice la app)');

-- ------------------------------------------------------ NOTIFICACIONES · 4-6
-- Escenario: la dueña (OWNER, todas las ubicaciones) con 2 teléfonos (uno dado
-- de baja), una encargada VIEWER y un admin restringido a OTRA ubicación.
create or replace function t_emp() returns uuid language sql as $$ select (t_s('centro', 'company_id'))::uuid $$;
create or replace function t_centro() returns uuid language sql as $$ select (t_s('centro', 'location_id'))::uuid $$;
delete from notification_deliveries; update notification_outbox set status = 'SKIPPED' where status = 'PENDING';
insert into auth.users (id, email) values ('c1000000-0000-0000-0000-0000000000c1', 'viewer@idonut.mx'), ('c2000000-0000-0000-0000-0000000000c2', 'admin-norte@idonut.mx')
  on conflict (id) do nothing;
insert into company_memberships (company_id, user_id, role, status, origin, location_ids) values
  (t_emp(), 'c1000000-0000-0000-0000-0000000000c1', 'VIEWER', 'ACTIVE', 'TEST', null),
  (t_emp(), 'c2000000-0000-0000-0000-0000000000c2', 'ADMIN', 'ACTIVE', 'TEST', array[gen_random_uuid()])
  on conflict (company_id, user_id) do nothing;
delete from push_tokens where owner_id in (t_duena(), 'c1000000-0000-0000-0000-0000000000c1', 'c2000000-0000-0000-0000-0000000000c2');
insert into push_tokens (owner_id, token, platform) values (t_duena(), 'ExponentPushToken[duena-a]', 'android'),
  (t_duena(), 'ExponentPushToken[duena-b]', 'ios'), ('c1000000-0000-0000-0000-0000000000c1', 'ExponentPushToken[viewer]', 'android'),
  ('c2000000-0000-0000-0000-0000000000c2', 'ExponentPushToken[admin-norte]', 'android');
update push_tokens set disabled_at = now() where token = 'ExponentPushToken[duena-b]';

create temp table t_ref (k text primary key, v uuid);
insert into t_ref values ('corte_dif', gen_random_uuid()), ('corte_ok', gen_random_uuid()), ('viejo', gen_random_uuid());
insert into notification_outbox (company_id, location_id, kind, ref_uuid, payload) values
  (t_emp(), t_centro(), 'SHIFT_CLOSED', (select v from t_ref where k = 'corte_dif'),
   jsonb_build_object('register', 'Caja 1', 'closed_by', 'Lupita Martínez', 'difference', -150.50, 'cash_expected', 1275, 'cash_counted', 1124.50)),
  (t_emp(), t_centro(), 'SHIFT_CLOSED', (select v from t_ref where k = 'corte_ok'), jsonb_build_object('register', 'Caja 2', 'closed_by', 'Marta', 'difference', 0));
insert into notification_outbox (company_id, location_id, kind, ref_uuid, payload, created_at) values
  (t_emp(), t_centro(), 'SHIFT_CLOSED', (select v from t_ref where k = 'viejo'), '{}', now() - interval '3 days');

select t_set('plan1', to_jsonb(notif_planear(100)));
create or replace function t_entregas(p_k text) returns table (canal text, destino text, titulo text, cuerpo text, status text)
language sql as $$ select d.canal, d.destino, d.titulo, d.cuerpo, d.status from notification_deliveries d join notification_outbox o on o.id = d.outbox_id
                     where o.ref_uuid = (select v from t_ref where k = p_k) order by d.canal, d.destino $$;

select t_check('F3-NOT01',
  (select array_agg(canal || ':' || destino) from t_entregas('corte_dif'))
    = array['email:duena@idonut.mx', 'email:socio@ambas.mx', 'push:ExponentPushToken[duena-a]']
  and (select status from notification_outbox where ref_uuid = (select v from t_ref where k = 'corte_dif')) = 'PLANNED',
  'un corte llega a OWNER/ADMIN con acceso a esa ubicación (push solo a tokens activos, y correo); ni VIEWER ni un admin de otra ubicación',
  (select string_agg(canal || ':' || destino, ', ') from t_entregas('corte_dif')));
select t_check('F3-NOT02',
  (select bool_and(titulo = 'Corte con diferencia') from t_entregas('corte_dif'))
  and (select bool_and(titulo = 'Corte cerrado') from t_entregas('corte_ok'))
  and not exists (select 1 from notification_deliveries where cuerpo ~ '[0-9]{2,}|\$|Lupita|Marta'),
  'el texto dice qué pasó y dónde, sin importes ni nombres de personas',
  (select cuerpo from t_entregas('corte_dif') limit 1));
select t_check('F3-NOT03',
  (select status from notification_outbox where ref_uuid = (select v from t_ref where k = 'viejo')) = 'SKIPPED'
  and not exists (select 1 from t_entregas('viejo')),
  'un aviso más viejo que su vigencia (24 h) no se manda');

create temp table t_n as select count(*) as n from notification_deliveries;
insert into notification_outbox (company_id, location_id, kind, ref_uuid, payload)
  values (t_emp(), t_centro(), 'SHIFT_CLOSED', (select v from t_ref where k = 'corte_dif'), '{}') on conflict (kind, ref_uuid) do nothing;
update notification_outbox set status = 'PENDING' where ref_uuid = (select v from t_ref where k = 'corte_dif');
select notif_planear(100);
select t_check('F3-NOT04', (select count(*) from notification_deliveries) = (select n from t_n),
  'idempotente: el mismo hecho dos veces o replanear no duplica ninguna entrega');

-- Preferencias: la dueña apaga el push de cortes.
insert into notification_preferences (user_id, company_id, kind, canal, activo) values (t_duena(), t_emp(), 'SHIFT_CLOSED', 'push', false);
insert into t_ref values ('corte_pref', gen_random_uuid());
insert into notification_outbox (company_id, location_id, kind, ref_uuid, payload)
  values (t_emp(), t_centro(), 'SHIFT_CLOSED', (select v from t_ref where k = 'corte_pref'), jsonb_build_object('difference', 0));
select notif_planear(100);
select t_check('F3-NOT05', (select array_agg(canal) from t_entregas('corte_pref') where destino like '%duena%') = array['email'],
  'con el push de cortes apagado, ese aviso solo llega por correo');
delete from notification_preferences where user_id = t_duena();

-- Tomar, arrendar, reintentar.
create temp table t_lote as select * from notif_tomar('push', 50);
select t_check('F3-NOT06',
  (select count(*) from t_lote) >= 1 and (select bool_and(status = 'SENDING' and attempts = 1) from t_lote)
  and (select count(*) from notif_tomar('push', 50)) = 0,
  'tomar arrienda las entregas: un segundo proceso no toma las mismas');
update notification_deliveries set lease_until = now() - interval '1 second' where id = (select min(id) from t_lote);
create temp table t_retoma as select * from notif_tomar('push', 50);
select t_check('F3-NOT07', (select count(*) from t_retoma) = 1
  and (select attempts from notification_deliveries where id = (select min(id) from t_lote)) = 2,
  'si el proceso muere, al vencer el arrendamiento la entrega se vuelve a tomar (y cuenta el intento)');

select t_set('r08', to_jsonb(notif_resultado((select min(id) from t_lote), false, null, 'HTTP 503')));
select t_check('F3-NOT08',
  t_get('r08') #>> '{}' = 'RETRY'
  and (select status = 'PENDING' and next_attempt_at between now() + interval '4 minutes' and now() + interval '6 minutes'
         from notification_deliveries where id = (select min(id) from t_lote)),
  'falla transitoria: vuelve a la cola con espera creciente (2.º intento -> 5 min)');
update notification_deliveries set attempts = 6, status = 'SENDING' where id = (select min(id) from t_lote);
select t_set('r09', to_jsonb(notif_resultado((select min(id) from t_lote), false, null, 'HTTP 503')));
select t_check('F3-NOT09',
  t_get('r09') #>> '{}' = 'DEAD'
  and exists (select 1 from cloud_audit where action = 'NOTIFICATION_DEAD' and detail->>'delivery_id' = (select min(id) from t_lote)::text),
  'tras 6 intentos queda DEAD y se audita');

insert into t_ref values ('corte_tok', gen_random_uuid());
insert into notification_outbox (company_id, location_id, kind, ref_uuid, payload) values (t_emp(), t_centro(), 'SHIFT_CLOSED', (select v from t_ref where k = 'corte_tok'), '{}');
select notif_planear(100);
create temp table t_lote2 as select * from notif_tomar('push', 50);
select t_set('r10', to_jsonb(notif_resultado((select id from t_lote2 limit 1), false, null, 'DeviceNotRegistered', false, true)));
select t_check('F3-NOT10',
  t_get('r10') #>> '{}' = 'DEAD'
  and (select disabled_at is not null from push_tokens where token = 'ExponentPushToken[duena-a]'),
  'un token que Expo da por inválido se desactiva y la entrega no se reintenta');
update push_tokens set disabled_at = null where token = 'ExponentPushToken[duena-a]';

-- Recibos.
insert into t_ref values ('corte_rec', gen_random_uuid());
insert into notification_outbox (company_id, location_id, kind, ref_uuid, payload) values (t_emp(), t_centro(), 'SHIFT_CLOSED', (select v from t_ref where k = 'corte_rec'), '{}');
select notif_planear(100);
create temp table t_lote3 as select * from notif_tomar('push', 50);
select notif_resultado(id, true, 'ticket-' || id) from t_lote3;
select t_check('F3-NOT11',
  (select count(*) from notif_por_recibo(100, interval '0')) >= 1
  and (select count(*) from notif_por_recibo(100)) = 0,
  'un push aceptado espera su recibo (no se revisa antes de 15 min)');
select notif_recibo(id, true) from t_lote3;
select t_check('F3-NOT12', (select bool_and(status = 'DELIVERED') from notification_deliveries where id in (select id from t_lote3)),
  'recibo correcto: DELIVERED');

-- Fuentes nuevas de eventos.
select wx_audit('USER', t_duena()::text, t_emp(), 'DEVICE_REVOKED', 'OK', jsonb_build_object('device_id', t_s('centro', 'device_id')));
insert into t_ref values ('rechazo', gen_random_uuid());
select wx_audit('DEVICE', t_s('centro', 'device_id'), t_emp(), 'SYNC_EVENT', 'DENIED', jsonb_build_object('event_uuid', (select v from t_ref where k = 'rechazo'), 'aggregate', 'SALE'));
select wx_audit('USER', t_duena()::text, t_emp(), 'SYNC_EVENT', 'DENIED', jsonb_build_object('event_uuid', gen_random_uuid()));
select t_check('F3-NOT13',
  exists (select 1 from notification_outbox where kind = 'DEVICE_REVOKED' and ref_uuid = (t_s('centro', 'device_id'))::uuid and location_id = t_centro())
  and exists (select 1 from notification_outbox where kind = 'SYNC_REJECTED' and ref_uuid = (select v from t_ref where k = 'rechazo'))
  and (select count(*) from notification_outbox where kind = 'SYNC_REJECTED') = 1,
  'dar de baja un equipo y un rechazo de la nube a un equipo generan su aviso (y solo los de equipos)');

select t_check('F3-NOT14',
  t_qa(t_duena(), 'aal2', 'select notif_planear(1)::text') = 'ERR:42501'
  and t_qa(t_duena(), 'aal2', 'select count(*)::text from notification_deliveries') = 'ERR:42501'
  and t_qa(t_duena(), 'aal2', 'select count(*)::text from notification_kinds') = '5'
  and t_qa(t_duena(), 'aal2', format('select count(*)::text from (select 1 from notif_tomar(%L, 1)) x', 'push')) = 'ERR:42501',
  'desde la app: no se planea, no se toma ni se leen entregas; los tipos sí se pueden leer');
select t_check('F3-NOT15',
  t_qa(t_duena(), 'aal1', format('insert into notification_preferences (user_id, company_id, kind, canal, activo) values (%L, %L, ''DEVICE_REVOKED'', ''email'', false) returning ''ok''', t_duena(), t_emp())) = 'ok'
  and t_qa('c2000000-0000-0000-0000-0000000000c2', 'aal1', format('insert into notification_preferences (user_id, company_id, kind, canal, activo) values (%L, %L, ''DEVICE_REVOKED'', ''email'', true) returning ''ok''', t_duena(), t_emp())) like 'ERR:%'
  and t_qa('f0000000-0000-0000-0000-00000000000f', 'aal1', format('insert into notification_preferences (user_id, company_id, kind, canal, activo) values (%L, %L, ''DEVICE_REVOKED'', ''email'', false) returning ''ok''', 'f0000000-0000-0000-0000-00000000000f', t_emp())) like 'ERR:%',
  'cada quien cambia SUS preferencias y solo en empresas donde es miembro');

-- Vencidas: una entrega que espera más de 48 h (canal sin configurar) ya no sale.
insert into t_ref values ('corte_viejo_mail', gen_random_uuid());
insert into notification_outbox (company_id, location_id, kind, ref_uuid, payload) values (t_emp(), t_centro(), 'SHIFT_CLOSED', (select v from t_ref where k = 'corte_viejo_mail'), '{}');
select notif_planear(100);
update notification_deliveries set created_at = now() - interval '49 hours'
 where outbox_id = (select id from notification_outbox where ref_uuid = (select v from t_ref where k = 'corte_viejo_mail')) and canal = 'email';
select t_set('vencidas', to_jsonb(notif_vencer(48)));
select t_check('F3-NOT16',
  (t_get('vencidas')#>>'{}')::int >= 1
  and (select bool_and(status = 'SKIPPED' and last_error = 'VENCIDA') from notification_deliveries
        where outbox_id = (select id from notification_outbox where ref_uuid = (select v from t_ref where k = 'corte_viejo_mail')) and canal = 'email')
  and (select count(*) from notif_tomar('email', 100) t where t.outbox_id = (select id from notification_outbox where ref_uuid = (select v from t_ref where k = 'corte_viejo_mail'))) = 0,
  'un correo que esperó más de 48 h (p. ej. sin proveedor configurado) se descarta en vez de mandarse tarde');

-- -------------------------------------------- AUTORIZACIÓN A DISTANCIA · 7
create or replace function t_tab() returns uuid language sql as $$ select (t_s('t1', 'device_id'))::uuid $$;
update devices set status = 'ACTIVE', revoked_at = null where id = t_tab();      -- la tablet de la feria, activa
create or replace function t_lupita() returns jsonb language sql as $$ select jsonb_build_object('uuid', t_s('cajera', 'uuid'), 'name', 'lupita', 'role', 'CASHIER') $$;
create or replace function t_pedir(p_id uuid, p_action text, p_payload jsonb, p_device uuid default null) returns jsonb language sql as $$
  select aprobacion_solicitar(jsonb_build_object('device_id', coalesce(p_device, t_tab()), 'id', p_id, 'action', p_action, 'requested_by', t_lupita(), 'payload', p_payload)) $$;
insert into t_ref values ('ap1', gen_random_uuid()), ('ap2', gen_random_uuid()), ('ap3', gen_random_uuid()), ('ap4', gen_random_uuid());
create or replace function t_ap(k text) returns uuid language sql as $$ select v from t_ref where k = $1 $$;

select t_set('ap1', t_pedir(t_ap('ap1'), 'MERMA', '{"producto": "Dona glaseada", "cantidad": "3", "razon": "Se cayeron"}'));
select t_set('ap1b', t_pedir(t_ap('ap1'), 'MERMA', '{"producto": "Dona glaseada", "cantidad": "3", "razon": "Se cayeron"}'));
select t_check('F3-APR01',
  t_s('ap1', 'status') = 'PENDING' and t_s('ap1b', 'status') = 'PENDING'
  and (select count(*) from approval_requests where id = t_ap('ap1')) = 1
  and exists (select 1 from notification_outbox where kind = 'APPROVAL_REQUESTED' and ref_uuid = t_ap('ap1')),
  'la tablet pide autorización: queda PENDING, reintentar es idempotente y sale el aviso push');
select t_check('F3-APR02',
  t_pedir(t_ap('ap1'), 'MERMA', '{"producto": "Dona glaseada", "cantidad": "30", "razon": "Se cayeron"}')->>'code' = 'CONFLICT'
  and t_pedir(gen_random_uuid(), 'DEVOLUCION', '{}')->>'code' = 'NOT_REMOTE'
  and aprobacion_solicitar(jsonb_build_object('device_id', t_tab(), 'id', gen_random_uuid(), 'action', 'MERMA',
        'requested_by', jsonb_build_object('uuid', gen_random_uuid(), 'name', 'intruso'), 'payload', '{}'::jsonb))->>'code' = 'DENIED',
  'mismo id con OTRO contenido: conflicto; acción no permitida a distancia; y quien pide tiene que trabajar en esa ubicación');

-- Owner: sin AAL2 no decide; con AAL2 y el hash de lo que vio, sí.
select t_check('F3-APR03',
  t_qa(t_duena(), 'aal1', format('select owner_decidir_aprobacion(%L, ''APPROVED'', %L)->>''code''', t_ap('ap1'), (select payload_hash from approval_requests where id = t_ap('ap1')))) = 'MFA_REQUIRED'
  and t_qa(t_duena(), 'aal2', format('select owner_decidir_aprobacion(%L, ''APPROVED'', ''hash-de-otra-cosa'')->>''code''', t_ap('ap1'))) = 'PAYLOAD_CHANGED'
  and t_qa('c1000000-0000-0000-0000-0000000000c1', 'aal2', format('select owner_decidir_aprobacion(%L, ''APPROVED'', %L)->>''code''', t_ap('ap1'), (select payload_hash from approval_requests where id = t_ap('ap1')))) in ('DENIED', 'MFA_ENROLL_REQUIRED')
  and (select status from approval_requests where id = t_ap('ap1')) = 'PENDING',
  'decidir exige AAL2, el hash de lo que se mostró y un rol de la regla (VIEWER no); nada cambia mientras tanto');
select t_set('dec1', (t_qa(t_duena(), 'aal2', format('select owner_decidir_aprobacion(%L, ''APPROVED'', %L)::text', t_ap('ap1'), (select payload_hash from approval_requests where id = t_ap('ap1')))))::jsonb);
select t_set('dec1b', (t_qa(t_duena(), 'aal2', format('select owner_decidir_aprobacion(%L, ''REJECTED'', %L)::text', t_ap('ap1'), (select payload_hash from approval_requests where id = t_ap('ap1')))))::jsonb);
select t_check('F3-APR04',
  t_s('dec1', 'status') = 'APPROVED' and t_s('dec1', 'decided_name') = 'duena' and t_s('dec1b', 'code') = 'ALREADY_DECIDED',
  'la dueña aprueba; una segunda decisión (aun de rechazo) ya no cambia nada');

-- Consumir: solo la misma tablet, con el mismo payload, una vez.
select t_set('c_otro', aprobacion_consumir(jsonb_build_object('device_id', (t_s('centro', 'device_id'))::uuid, 'id', t_ap('ap1'),
  'payload', '{"producto": "Dona glaseada", "cantidad": "3", "razon": "Se cayeron"}'::jsonb)));
select t_set('c_cambio', aprobacion_consumir(jsonb_build_object('device_id', t_tab(), 'id', t_ap('ap1'),
  'payload', '{"producto": "Dona glaseada", "cantidad": "30", "razon": "Se cayeron"}'::jsonb)));
select t_set('c_ok', aprobacion_consumir(jsonb_build_object('device_id', t_tab(), 'id', t_ap('ap1'),
  'payload', '{"razon": "Se cayeron", "cantidad": "3", "producto": "Dona glaseada"}'::jsonb)));
select t_set('c_otra_vez', aprobacion_consumir(jsonb_build_object('device_id', t_tab(), 'id', t_ap('ap1'),
  'payload', '{"producto": "Dona glaseada", "cantidad": "3", "razon": "Se cayeron"}'::jsonb)));
select t_check('F3-APR05',
  t_s('c_otro', 'code') = 'NOT_FOUND' and t_s('c_cambio', 'code') = 'PAYLOAD_CHANGED'
  and t_s('c_ok', 'status') = 'CONSUMED' and t_get('c_ok')->'approver'->>'name' = 'duena' and t_get('c_ok')->'approver'->>'uuid' = t_ap('ap1')::text
  and t_s('c_otra_vez', 'code') = 'NOT_APPROVED',
  'consumir: otro equipo no puede, un payload cambiado no pasa, el mismo (en cualquier orden de llaves) sí, y solo una vez');

-- Expira; cancelar; rechazo.
select t_pedir(t_ap('ap2'), 'RETIRO', '{"monto": "500.00", "razon": "Resguardo"}');
update approval_requests set expires_at = now() - interval '1 second' where id = t_ap('ap2');
select t_set('ap2_dec', (t_qa(t_duena(), 'aal2', format('select owner_decidir_aprobacion(%L, ''APPROVED'', %L)::text', t_ap('ap2'), (select payload_hash from approval_requests where id = t_ap('ap2')))))::jsonb);
select t_check('F3-APR06', t_s('ap2_dec', 'code') = 'ALREADY_DECIDED' and t_s('ap2_dec', 'status') = 'EXPIRED',
  'una solicitud vencida (10 min) ya no se puede aprobar');
select t_pedir(t_ap('ap3'), 'EGRESO', '{"monto": "80.00", "razon": "Hielo"}');
select t_set('ap3_c', aprobacion_cancelar(jsonb_build_object('device_id', t_tab(), 'id', t_ap('ap3'))));
select t_pedir(t_ap('ap4'), 'AJUSTE', '{"producto": "Vaso", "cantidad": "-2"}');
select t_qa(t_duena(), 'aal2', format('select owner_decidir_aprobacion(%L, ''REJECTED'', %L, ''No cuadra'')::text', t_ap('ap4'), (select payload_hash from approval_requests where id = t_ap('ap4'))));
select t_check('F3-APR07',
  t_s('ap3_c', 'status') = 'CANCELLED'
  and aprobacion_estado(jsonb_build_object('device_id', t_tab(), 'id', t_ap('ap4')))->>'status' = 'REJECTED'
  and aprobacion_estado(jsonb_build_object('device_id', t_tab(), 'id', t_ap('ap4')))->>'decision_note' = 'No cuadra'
  and aprobacion_consumir(jsonb_build_object('device_id', t_tab(), 'id', t_ap('ap4'), 'payload', '{"producto": "Vaso", "cantidad": "-2"}'::jsonb))->>'code' = 'NOT_APPROVED',
  'la tablet puede cancelar lo suyo; un rechazo llega con su motivo y no se puede consumir');

-- Lo que ve la dueña y lo que no.
select t_check('F3-APR08',
  (select jsonb_array_length((t_qa(t_duena(), 'aal1', format('select owner_aprobaciones(%L)::text', t_emp())))::jsonb)) >= 4
  and t_qa('f0000000-0000-0000-0000-00000000000f', 'aal2', format('select owner_aprobaciones(%L)::text', t_emp())) = 'ERR:42501'
  and t_qa(t_duena(), 'aal2', 'select count(*)::text from approval_requests') = 'ERR:42501'
  and t_qa(t_duena(), 'aal2', format('select aprobacion_consumir(%L::jsonb)::text', '{}')) = 'ERR:42501',
  'la dueña ve la lista (incluso en AAL1); alguien de otra empresa no; nadie consume ni lee la tabla desde la app');

-- Verificación cruzada al sincronizar.
insert into sync_events (event_uuid, company_id, location_id, device_id, aggregate_type, aggregate_uuid, aggregate_version, event_type, payload, result)
values (gen_random_uuid(), t_emp(), (t_s('feria', 'location_id'))::uuid, t_tab(), 'INVENTORY_MOVEMENT', gen_random_uuid(), 1, 'INVENTORY_MOVEMENT_RECORDED',
        jsonb_build_object('authorized_by', jsonb_build_object('uuid', t_ap('ap1'), 'name', 'duena', 'remote', true)), 'APPLIED'),
       (gen_random_uuid(), t_emp(), (t_s('feria', 'location_id'))::uuid, t_tab(), 'INVENTORY_MOVEMENT', gen_random_uuid(), 2, 'INVENTORY_MOVEMENT_RECORDED',
        jsonb_build_object('authorized_by', jsonb_build_object('uuid', t_ap('ap4'), 'name', 'duena', 'remote', true)), 'APPLIED');
select t_check('F3-APR09',
  (select count(*) from cloud_audit where action = 'APPROVAL_MISMATCH' and detail->>'approval_id' = t_ap('ap4')::text) = 1
  and (select count(*) from cloud_audit where action = 'APPROVAL_MISMATCH' and detail->>'approval_id' = t_ap('ap1')::text) = 0,
  'un evento que dice "autorizado a distancia" sin una aprobación CONSUMIDA de esa tablet queda auditado y pendiente');
insert into sync_events (event_uuid, company_id, location_id, device_id, aggregate_type, aggregate_uuid, aggregate_version, event_type, payload, result)
values (gen_random_uuid(), t_emp(), (t_s('feria', 'location_id'))::uuid, t_tab(), 'INVENTORY_MOVEMENT', gen_random_uuid(), 3, 'INVENTORY_MOVEMENT_RECORDED',
        jsonb_build_object('authorized_by', jsonb_build_object('uuid', t_ap('ap1'), 'name', 'duena', 'remote', true)), 'APPLIED'),
       (gen_random_uuid(), t_emp(), (t_s('feria', 'location_id'))::uuid, t_tab(), 'CASH_MOVEMENT', gen_random_uuid(), 4, 'CASH_MOVEMENT_RECORDED',
        jsonb_build_object('authorized_by', jsonb_build_object('uuid', t_ap('ap1'), 'name', 'duena', 'remote', true)), 'APPLIED');
select t_check('F3-APR11',
  (select count(*) from cloud_audit where action = 'APPROVAL_MISMATCH' and detail->>'approval_id' = t_ap('ap1')::text) = 2,
  'una aprobación respalda UN evento y de su mismo tipo: reusarla o usar una de merma para un retiro queda auditado');

select t_check('F3-APR10',
  exists (select 1 from cloud_audit where action = 'APPROVAL_DECIDE' and result = 'APPROVED' and detail->>'aal' = 'aal2')
  and exists (select 1 from cloud_audit where action = 'APPROVAL_CONSUME' and result = 'OK')
  and exists (select 1 from cloud_audit where action = 'APPROVAL_CONSUME' and result = 'DENIED' and detail->>'motivo' = 'PAYLOAD_CHANGED')
  and (select cuerpo from notification_deliveries d join notification_outbox o on o.id = d.outbox_id where o.ref_uuid = t_ap('ap1') limit 1) is null,
  'auditoría de solicitud, decisión (con el AAL) y consumo');

-- --------------------------------------------------- FECHA DE NEGOCIO · 8
create or replace function t_venta_sync(p_fecha text, p_occ timestamptz) returns uuid language sql as $$
  insert into sync_events (event_uuid, company_id, location_id, device_id, aggregate_type, aggregate_uuid, aggregate_version, event_type, occurred_at, payload, result)
  values (gen_random_uuid(), t_emp(), (t_s('feria', 'location_id'))::uuid, t_tab(), 'SALE', gen_random_uuid(), 1, 'SALE_RECORDED', p_occ,
          jsonb_build_object('business_date', p_fecha), 'APPLIED') returning event_uuid $$;
update sucursales set timezone = 'America/Mexico_City' where id = (t_s('feria', 'location_id'))::uuid;
update devices set clock_skew_seconds = 0 where id = t_tab();
create temp table t_fv (k text, ev uuid);
insert into t_fv select 'normal', t_venta_sync('2026-11-01', '2026-11-01T20:00:00Z');                 -- 14:00 en León
insert into t_fv select 'medianoche', t_venta_sync('2026-11-01', '2026-11-02T06:10:00Z');             -- 00:10 del 2, turno del 1
update devices set clock_skew_seconds = 86400 where id = t_tab();                                    -- tablet un día atrasada
insert into t_fv select 'corregida', t_venta_sync('2026-11-02', '2026-11-01T20:00:00Z');              -- su turno ya usó la hora de Wybix
update devices set clock_skew_seconds = 0 where id = t_tab();
insert into t_fv select 'rara', t_venta_sync('2026-10-25', '2026-11-01T20:00:00Z');                   -- una semana antes: no cuadra
select t_check('F3-FEC01',
  not exists (select 1 from cloud_audit c join t_fv f on c.detail->>'event_uuid' = f.ev::text where c.action = 'BUSINESS_DATE_SUSPECT' and f.k in ('normal', 'medianoche', 'corregida'))
  and exists (select 1 from cloud_audit c join t_fv f on c.detail->>'event_uuid' = f.ev::text where c.action = 'BUSINESS_DATE_SUSPECT' and f.k = 'rara')
  and exists (select 1 from reconciliation_items r join t_fv f on r.ref = f.ev::text where r.kind = 'BUSINESS_DATE_SUSPECT' and f.k = 'rara'),
  'la nube acepta la venta del mismo día, la que cruzó la medianoche y la de una tablet con reloj corregido; marca la que no cuadra (sin tocarla)');

-- El permiso consumido no permite alterar la operación al sincronizar.
create temp table t_apr_seguro (id uuid, ev uuid, producto uuid, movimiento uuid);
insert into t_apr_seguro values (gen_random_uuid(), gen_random_uuid(), (t_get('A')#>>'{}')::uuid, gen_random_uuid());
insert into approval_requests(id,company_id,location_id,device_id,action,requested_by,payload,payload_hash,status,expires_at,consumed_at)
select id,t_emp(),(t_s('feria','location_id'))::uuid,t_tab(),'MERMA',t_lupita(),
 jsonb_build_object('product_uuid',producto,'cantidad','3','razon','Se cayeron'),'test','CONSUMED',now()+interval '10 minutes',now() from t_apr_seguro;
create function pg_temp.t_evento_apr(cantidad text, tipo text default 'WASTE') returns jsonb language sql as $$
 select t_ev2('INVENTORY_MOVEMENT_RECORDED','INVENTORY_MOVEMENT',movimiento,90,
 jsonb_build_object('movement',jsonb_build_object('uuid',movimiento,'product_uuid',producto,'type',tipo,'quantity',cantidad,'reason','Se cayeron'),
 'employee',t_lupita(),'authorized_by',jsonb_build_object('uuid',id,'remote',true))) from t_apr_seguro $$;
create temp table t_ledger_antes as select count(*) n from inventory_ledger;
select t_set('apr_cambio',sync_ingest(jsonb_build_object('device_id',t_tab(),'envelope','{}'::jsonb,'events',jsonb_build_array(pg_temp.t_evento_apr('30')))));
select t_set('apr_tipo',sync_ingest(jsonb_build_object('device_id',t_tab(),'envelope','{}'::jsonb,'events',jsonb_build_array(pg_temp.t_evento_apr('3','ADJUSTMENT')))));
select t_check('F3-APR12',t_get('apr_cambio')->'results'->0->>'result' = 'REJECTED'
 and t_get('apr_tipo')->'results'->0->>'result' = 'REJECTED'
 and (select count(*) from inventory_ledger)=(select n from t_ledger_antes),
 'payload o acción alterados se rechazan ANTES de mover inventario');
select t_set('apr_bien',sync_ingest(jsonb_build_object('device_id',t_tab(),'envelope','{}'::jsonb,'events',jsonb_build_array(pg_temp.t_evento_apr('3')))));
select t_set('apr_replay',sync_ingest(jsonb_build_object('device_id',t_tab(),'envelope','{}'::jsonb,'events',jsonb_build_array(pg_temp.t_evento_apr('3')))));
select t_check('F3-APR13',t_get('apr_bien')->'results'->0->>'result' = 'APPLIED'
 and t_get('apr_replay')->'results'->0->>'result' = 'REJECTED'
 and (select count(*) from inventory_ledger)=(select n+1 from t_ledger_antes),
 'operación aprobada aplica una vez; otro evento no puede consumir el mismo permiso');

-- Conciliación aislada: el motivo se impone en SQL y el ajuste es un hecho.
create temp table t_conc_loc as
 with nueva as (insert into sucursales(negocio_id,nombre,tipo,home_location_id,event_status)
 values(t_emp(),'Evento prueba conciliación','EVENT',(t_s('centro','location_id'))::uuid,'CLOSED') returning id) select id from nueva;
insert into inventory_ledger(movement_uuid,company_id,location_id,product_uuid,type,quantity,ref_type,occurred_at)
select gen_random_uuid(),t_emp(),id,(t_get('A')#>>'{}')::uuid,'TRANSFER_IN',4,'TEST',now() from t_conc_loc;
create function pg_temp.t_conc(forzar boolean, motivo text) returns jsonb language sql as $$
 select t_qa(t_duena(),'aal2',format('select owner_evento_estado(%L,%L,''RECONCILED'',%L,%L)',t_emp(),(select id from t_conc_loc),forzar,motivo))::jsonb $$;
select t_set('conc_resto',pg_temp.t_conc(false,null));
select t_set('conc_motivo',pg_temp.t_conc(true,'   '));
select t_check('F3-REC01',t_s('conc_resto','code')='STOCK_NOT_ZERO'
 and t_get('conc_resto')->'stock'->0 ? 'causes'
 and t_get('conc_resto')->'stock'->0 ? 'product_name'
 and t_s('conc_motivo','code')='REASON_REQUIRED'
 and (select qty from location_stock where location_id=(select id from t_conc_loc))=4,
 'desglose por producto y causa; motivo vacío rechazado sin ajustar stock');
select t_set('conc_ok',pg_temp.t_conc(true,'Conteo físico: sobrante no retornado'));
select t_check('F3-REC02',t_get('conc_ok')->>'ok'='true'
 and (select qty from location_stock where location_id=(select id from t_conc_loc))=0
 and (select reconciliation->'stock'->0->>'qty' from sucursales where id=(select id from t_conc_loc))='4.00'
 and (select count(*) from inventory_ledger where location_id=(select id from t_conc_loc) and ref_type='RECONCILIATION')=1
 and pg_temp.t_conc(true,'Otra vez')->>'code'='BAD_TRANSITION',
 'conciliar registra un ajuste en el evento, conserva diferencia y evita repetirlo');

select 'ok|' || id || '|' || msg || coalesce(' · ' || det, '') from t_res where ok and id like 'F3-%' order by n;
select 'FALLA|' || id || '|' || msg || coalesce(' · ' || det, '') from t_res where not ok and id like 'F3-%' order by n;
