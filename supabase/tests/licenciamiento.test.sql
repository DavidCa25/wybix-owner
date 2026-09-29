-- ============================================================================
--  PRUEBAS DEL LICENCIAMIENTO v2 (Postgres 17, sobre base-produccion.sql +
--  la migración). Las corre scripts/probar-licenciamiento.mjs.
--  Cada comprobación deja una fila en t_res; la corrida falla si alguna es false.
-- ============================================================================
create table if not exists t_res (n serial, id text, ok boolean, msg text, det text);
grant all on t_res to public;
grant usage on sequence t_res_n_seq to public;
create or replace function t_check(p_id text, p_ok boolean, p_msg text, p_det text default null) returns void
language sql as $$ insert into t_res (id, ok, msg, det) values (p_id, coalesce(p_ok, false), p_msg, p_det) $$;

-- Ejecuta p_sql como p_rol y dice si lo NEGÓ por privilegios.
create or replace function t_negado(p_sql text, p_rol text) returns boolean language plpgsql as $$
begin
  execute format('set local role %I', p_rol);
  begin
    execute p_sql;
  exception when insufficient_privilege then
    execute 'reset role';
    return true;
  end;
  execute 'reset role';
  return false;
end $$;

-- --------------------------------------------------------------- S · esquema
select t_check('S01', (select max_registers from licenses where license_key = 'WYBX-MULT-0002') = 0
                  and (select max_registers from licenses where license_key = 'WYBX-MULT-0003') = 9999,
  'PARTE A no toca max_registers: la web y el license-check anteriores lo siguen leyendo y escribiendo igual (0 / 9999)');
select t_check('S01', (select bool_and((license_runtime(id)->>'registers_max') is null) from licenses where plan = 'multi')
                  and (select bool_and((license_runtime(id)->>'registers_max')::int = 1) from licenses where plan = 'mono'),
  'las cajas salen de la EDICIÓN: MultiCaja ilimitadas (null), MonoCaja 1');
select t_check('S02', (select count(*) from license_verticals where license_id in (select id from licenses where license_key like 'WYBX-M%')) = 0,
  'las licencias anteriores NO reciben giros automáticamente (ni los tres ni ninguno)');
select t_check('S02', (select count(*) from license_review_queue where 'SIN_GIRO' = any(reasons) and 'SIN_CLASIFICAR' = any(reasons)) = 4,
  'y quedan en la cola de revisión: sin clasificar y sin giro');
select t_check('S03', (select first_activated_at from licenses where license_key = 'WYBX-MONO-0001') = '2026-07-10 10:00-06'
                  and (select included_until from licenses where license_key = 'WYBX-MONO-0001') = '2027-07-10 10:00-06',
  'el primer año de una licencia ya activada corre desde su primera activación registrada');
select t_check('S03', (select first_activated_at from licenses where license_key = 'WYBX-MONO-0004') is null
                  and not exists (select 1 from license_subscriptions s join licenses l on l.id = s.license_id where l.license_key = 'WYBX-MONO-0004'),
  'una licencia comprada pero nunca activada todavía no empieza su año');
select t_check('S04', (select count(*) from license_purchases where kind = 'LEGACY') = 4, 'la compra original queda como historial');
select t_check('S05', (select list_price from license_catalog where code = 'EDITION_MONO') = 2499
                  and (select list_price from license_catalog where code = 'EDITION_MULTI') = 3999
                  and (select count(*) from license_catalog where code in ('SUBSCRIPTION_MONTHLY', 'SUBSCRIPTION_ANNUAL', 'SCREENS_EXTENDED', 'SCREENS_UNLIMITED',
                                                                             'VERTICAL_COMMERCE', 'VERTICAL_HOSPITALITY', 'VERTICAL_SERVICES') and list_price is null) = 7,
  'catálogo: $2,499 y $3,999 vigentes; mensual, anual, giro adicional y ampliaciones de pantallas sin precio (TBD)');
select t_check('S05', (select count(*) from license_catalog where list_price is not null) = 11
                  and (select string_agg(code || '=' || list_price, ',' order by code) from license_catalog where kind = 'EXTRA')
                      = 'EXTRA_APP_MOBILE=600.00,EXTRA_CFDI_100=250.00,EXTRA_CFDI_1000=1490.00,EXTRA_CFDI_3000=3990.00,EXTRA_CFDI_500=890.00,EXTRA_CFDI_5000=5900.00,EXTRA_ONBOARDING=300.00'
                  and (select list_price = 690 and reference_price = 890 from license_catalog where code = 'SUPPORT_PRIORITY')
                  and (select (grants->>'rate')::numeric = 0.16 from license_catalog where code = 'TAX_IVA_MX'),
  'los complementos que la web ya vendía viven en el catálogo con sus precios vigentes (y el IVA)');
select t_check('S05', (select bool_and(edition is not null) from license_catalog where kind = 'EDITION')
                  and (select bool_and(vertical is not null) from license_catalog where kind = 'VERTICAL')
                  and (select count(*) from license_catalog where billing is null and kind in ('EDITION', 'SUBSCRIPTION', 'EXTRA')) = 0,
  'cada producto dice su edición, su giro y su periodo de cobro en columnas propias');
select t_check('S06', ('2026-10-01 00:00-06'::timestamptz + interval '12 months') = '2027-10-01 00:00-06'
                  and ('2028-02-29 12:00-06'::timestamptz + interval '12 months')::date = '2029-02-28',
  'el primer año es calendario: 2026-10-01 -> 2027-10-01 (y un 29 de febrero cae en 28)');

-- --------------------------------------------------------------- A · activación
select t_check('A01', (license_activate('wybx-mono-0004', 'PC-A', 'Caja'))->>'ok' = 'true', 'primera activación de una MonoCaja');
select t_check('A01', (select first_activated_at is not null and included_until = first_activated_at + interval '12 months'
                         and support_until = (first_activated_at + interval '12 months')::date
                         from licenses where license_key = 'WYBX-MONO-0004'),
  'la primera activación fija first_activated_at, el primer año y el soporte incluido desde ESE momento');
select t_check('A02', (license_activate('WYBX-MONO-0004', 'PC-A'))->>'first' = 'false'
                  and (select count(*) from license_activations a join licenses l on l.id = a.license_id where l.license_key = 'WYBX-MONO-0004') = 1
                  and (select count(*) from license_subscriptions s join licenses l on l.id = s.license_id where l.license_key = 'WYBX-MONO-0004' and kind = 'INCLUDED') = 1,
  'activar otra vez la misma computadora es idempotente: ni otra activación ni otro año');
select t_check('A03', (license_activate('WYBX-MONO-0004', 'PC-B'))->>'code' = 'LIMIT_REACHED', 'MonoCaja: una segunda computadora se rechaza');
create temp table t_tmp (k text primary key, v jsonb);
insert into t_tmp values ('rel', license_release((select id from licenses where license_key = 'WYBX-MONO-0004'), 'PC-A', 'cliente'));
insert into t_tmp values ('actB', license_activate('WYBX-MONO-0004', 'PC-B'));
select t_check('A04', (select v->>'released' from t_tmp where k = 'rel') = 'true'
                  and (select v->>'ok' from t_tmp where k = 'actB') = 'true'
                  and not (select active from license_activations a join licenses l on l.id = a.license_id where l.license_key = 'WYBX-MONO-0004' and machine_id = 'PC-A'),
  'cambio de PC: liberar A permite activar B; A deja de estar autorizada');
select t_check('A04', (license_release((select id from licenses where license_key = 'WYBX-MONO-0004'), 'PC-B', 'cliente'))->>'ok' = 'true'
                  and (license_activate('WYBX-MONO-0004', 'PC-A'))->>'ok' = 'true'
                  and (license_release((select id from licenses where license_key = 'WYBX-MONO-0004'), 'PC-A', 'cliente'))->>'ok' = 'true'
                  and (license_activate('WYBX-MONO-0004', 'PC-B'))->>'ok' = 'true',
  'sin límite artificial de cambios: A -> B -> A -> B');
select t_check('A04', (select count(*) from license_events e join licenses l on l.id = e.license_id
                        where l.license_key = 'WYBX-MONO-0004' and type in ('DEVICE_BOUND', 'DEVICE_UNBOUND')) >= 6
                  and (select released_by from license_activations a join licenses l on l.id = a.license_id
                        where l.license_key = 'WYBX-MONO-0004' and machine_id = 'PC-A') = 'cliente',
  'cada vincular y desvincular queda auditado');
select t_check('A05', (select bool_and((license_activate('WYBX-MULT-0003', 'CAJA-' || g))->>'ok' = 'true') from generate_series(1, 12) g),
  'MultiCaja: 12 cajas activas, sin límite');
select t_check('A06', (license_activate('NO-EXISTE', 'PC-X'))->>'code' = 'NOT_FOUND', 'una clave inventada no activa nada');
update licenses set status = 'suspendida' where license_key = 'WYBX-MULT-0002';
select t_check('A06', (license_activate('WYBX-MULT-0002', 'PC-CAFE-3'))->>'code' = 'SUSPENDED'
                  and (license_for_machine('PC-CAFE-1'))->>'code' = 'SUSPENDED',
  'una licencia suspendida no activa ni refresca');
update licenses set status = 'activa' where license_key = 'WYBX-MULT-0002';
select t_check('A07', (license_for_machine('PC-CAFE-1'))->'runtime'->>'edition' = 'multi'
                  and (license_for_machine('PC-DESCONOCIDA'))->>'code' = 'NOT_ACTIVATED',
  'refrescar por computadora: la activada recibe su licencia; una desconocida, nada');
select t_check('A08', not ((license_for_machine('PC-CAFE-1'))->'runtime' ?| array['support_tier', 'support_until', 'included_code_changes',
                                                                        'used_code_changes', 'remaining_code_changes', 'list_price', 'price_paid']),
  'lo que viaja al POS es solo runtime: ni soporte, ni adaptaciones, ni precios');

select t_check('A10', (select (r->'entitlements') ? 'sales' and not (r->'entitlements') ? 'hospitality' and not (r->'entitlements') ? 'services'
                         and r->'verticals' = '[]'::jsonb and r->'screens' = '{}'::jsonb
                         from (select license_for_machine('PC-CAFE-1')->'runtime' r) x),
  'una licencia anterior sin giro: solo lo de la edición (vender, cobrar, clientes), ninguna pantalla');
select license_add_vertical((select id from licenses where license_key = 'WYBX-MULT-0002'), 'HOSPITALITY', '{"price_paid":0,"provider":"MANUAL","ref":"CLASIF-2"}', 'admin');
select t_check('A10', (select (r->'entitlements') ? 'hospitality.kds' and not (r->'entitlements') ? 'services.agenda'
                         and (r->'screens'->>'HOSPITALITY')::int = 3 and not (r->'entitlements') ? 'multibranch'
                         from (select license_for_machine('PC-CAFE-1')->'runtime' r) x),
  'al asignarle un giro de forma explícita: sus entitlements y 3 pantallas, resueltos desde el catálogo');

-- --------------------------------------------------------------- U · upgrades
insert into t_tmp values ('up', license_upgrade_to_multi((select id from licenses where license_key = 'WYBX-MONO-0001'),
                        '{"list_price":1500,"discount_pct":10,"price_paid":1350,"provider":"MANUAL","ref":"UP-1","discount_reason":"cliente fundador"}', 'admin'));
select t_check('U01', (select v->>'ok' from t_tmp where k = 'up') = 'true'
                  and (select plan = 'multi' and max_registers = 0 and (license_runtime(id)->>'registers_max') is null from licenses where license_key = 'WYBX-MONO-0001'),
  'MonoCaja -> MultiCaja: la MISMA licencia (sin otra clave ni reinstalar)');
select t_check('U01', (license_activate('WYBX-MONO-0001', 'PC-UNO-2'))->>'ok' = 'true', 'ya como MultiCaja, la segunda caja se activa');
select t_check('U02', (select list_price = 1500 and discount_pct = 10 and price_paid = 1350 and discount_reason = 'cliente fundador'
                         from license_purchases p join licenses l on l.id = p.license_id where l.license_key = 'WYBX-MONO-0001' and p.kind = 'UPGRADE_EDITION')
                  and exists (select 1 from license_events e join licenses l on l.id = e.license_id where l.license_key = 'WYBX-MONO-0001' and type = 'DISCOUNT_APPLIED')
                  and exists (select 1 from license_events e join licenses l on l.id = e.license_id where l.license_key = 'WYBX-MONO-0001' and type = 'MONO_TO_MULTI')
                  and exists (select 1 from license_purchases p join licenses l on l.id = p.license_id where l.license_key = 'WYBX-MONO-0001' and p.kind = 'LEGACY'),
  'historial: qué tenía, qué compró, precio de lista, descuento, precio pagado y motivo; la compra original sigue ahí');
-- Una licencia nueva, de un solo giro, para probar el híbrido.
insert into licenses (id, license_key, plan, customer_name, max_registers) values ('00000000-0000-0000-0000-000000000010', 'WYBX-NUEV-0010', 'mono', 'Taller Nuevo', 1);
insert into license_verticals (license_id, vertical, source) values ('00000000-0000-0000-0000-000000000010', 'SERVICES', 'INITIAL');
insert into t_tmp values ('vert', license_add_vertical('00000000-0000-0000-0000-000000000010', 'COMMERCE', '{"price_paid":0,"provider":"MANUAL","ref":"V-1"}', 'admin'));
select t_check('U03', (select v->>'ok' from t_tmp where k = 'vert') = 'true'
                  and (select array_agg(vertical order by vertical) from license_verticals where license_id = '00000000-0000-0000-0000-000000000010') = array['COMMERCE', 'SERVICES'],
  'Servicios -> Servicios + Comercio (taller que vende refacciones): la misma licencia');
select t_check('U03', (license_add_vertical('00000000-0000-0000-0000-000000000010', 'COMMERCE'))->>'unchanged' = 'true',
  'agregar un giro que ya tiene no duplica nada');
insert into t_tmp values ('tier', license_set_screen_tier('00000000-0000-0000-0000-000000000010', 'SERVICES', 'EXTENDED', '{}', 'admin'));
select t_check('U04', (select v->>'ok' from t_tmp where k = 'tier') = 'true'
                  and (select screen_tier from license_verticals where license_id = '00000000-0000-0000-0000-000000000010' and vertical = 'SERVICES') = 'EXTENDED'
                  and (select screen_tier from license_verticals where license_id = '00000000-0000-0000-0000-000000000010' and vertical = 'COMMERCE') = 'BASE'
                  and exists (select 1 from license_events where license_id = '00000000-0000-0000-0000-000000000010' and type = 'SCREEN_QUOTA_CHANGED'),
  'ampliar pantallas de UN giro (3 -> 10) no cambia los demás, y queda en el historial');
select t_check('U04', (select (license_runtime('00000000-0000-0000-0000-000000000010')->'screens') = '{"COMMERCE":3,"SERVICES":10}'::jsonb
                         and not (license_runtime('00000000-0000-0000-0000-000000000010')->'entitlements') ? 'hospitality'),
  'híbrido Servicios + Comercio: 10 pantallas de Servicios, 3 de Comercio, y nada de Restaurantes');
select t_check('U05', (license_set_screen_tier('00000000-0000-0000-0000-000000000010', 'HOSPITALITY', 'EXTENDED'))->>'code' = 'NO_VERTICAL',
  'no se amplían pantallas de un giro que la licencia no tiene');

-- --------------------------------------------------------------- R · renovación
-- La licencia 0010 nunca se activó: no tiene periodo. Una renovación manual
-- vencida para simular la gracia, y luego renovar.
insert into license_subscriptions (license_id, kind, period_start, period_end, created_by)
values ('00000000-0000-0000-0000-000000000010', 'MANUAL', now() - interval '400 days', now() - interval '35 days', 'prueba');
insert into t_tmp values ('r1', license_renew('00000000-0000-0000-0000-000000000010', 'MONTHLY', '{"provider":"MANUAL","ref":"R-1","list_price":null,"price_paid":null}', 'admin'));
select t_check('R01', (select v->>'ok' from t_tmp where k = 'r1') = 'true'
                  and license_paid_until('00000000-0000-0000-0000-000000000010') between now() + interval '27 days' and now() + interval '32 days',
  'renovar vencido: el periodo empieza hoy (no se cobra el tiempo sin servicio)');
insert into t_tmp values ('r2', license_renew('00000000-0000-0000-0000-000000000010', 'ANNUAL', '{"provider":"MANUAL","ref":"R-2"}', 'admin'));
select t_check('R02', (select v->>'ok' from t_tmp where k = 'r2') = 'true'
                  and license_paid_until('00000000-0000-0000-0000-000000000010') between now() + interval '1 month' + interval '12 months' - interval '2 days'
                                                                                       and now() + interval '1 month' + interval '12 months' + interval '2 days',
  'renovar vigente: el anual se suma al final del periodo actual');
select t_check('R03', (license_renew('00000000-0000-0000-0000-000000000010', 'ANNUAL', '{"provider":"MANUAL","ref":"R-2"}', 'admin'))->>'unchanged' = 'true',
  'el mismo pago no renueva dos veces');
select t_check('R04', (select count(*) from license_events where license_id = '00000000-0000-0000-0000-000000000010' and type = 'SUBSCRIPTION_RENEWED') = 2,
  'cada renovación queda en el historial');

-- --------------------------------------------------------------- P · soporte
select license_register_code_change('00000000-0000-0000-0000-000000000010', 'CUSTOMIZATION', 'Formato de ticket', 'Logo y leyenda', 'soporte');
select license_register_code_change('00000000-0000-0000-0000-000000000010', 'CUSTOMIZATION', 'Campo de placas', null, 'soporte');
select license_register_code_change('00000000-0000-0000-0000-000000000010', 'BUG_FIX', 'La venta no cerraba', 'Error de Wybix', 'soporte');
select license_register_code_change('00000000-0000-0000-0000-000000000010', 'IMPLEMENTATION', 'Carga inicial de catálogo', 'Importar Excel', 'soporte');
select t_check('P01', (select used_code_changes = 2 and remaining_code_changes = 1 and included_code_changes = 3
                         from license_support_summary where license_id = '00000000-0000-0000-0000-000000000010'),
  'tres adaptaciones incluidas: dos usadas, una restante; ni la corrección de un error de Wybix ni la implementación cuentan');
select t_check('P02', (license_register_code_change('00000000-0000-0000-0000-000000000010', 'REGALO', 'x', null, 'soporte'))->>'code' = 'BAD_REQUEST'
                  and exists (select 1 from license_events where license_id = '00000000-0000-0000-0000-000000000010' and type = 'BUG_FIX_REGISTERED')
                  and exists (select 1 from license_events where license_id = '00000000-0000-0000-0000-000000000010' and type = 'IMPLEMENTATION_REGISTERED'),
  'solo existen tres tipos (adaptación, corrección, implementación) y cada registro queda en el historial');
select t_check('P03', not (license_runtime('00000000-0000-0000-0000-000000000010') ?| array['included_code_changes', 'used_code_changes', 'remaining_code_changes', 'support_tier']),
  'las adaptaciones (incluidas, usadas, restantes) son solo comerciales: no están en el runtime del certificado');

-- --------------------------------------------------------------- K · cotizar (la validación de cobro)
select t_check('K01', (select (q->>'ok')::boolean and (q->>'subtotal')::numeric = 2499 and (q->>'tax')::numeric = 399.84 and (q->>'total')::numeric = 2898.84
                         from (select license_quote('{"edition":"EDITION_MONO","vertical":"COMMERCE"}') q) x),
  'MonoCaja + Comercios: $2,499 + IVA = $2,898.84, calculado desde el catálogo');
select t_check('K01', (select (q->>'total')::numeric = round((3999 + 250 * 2 + 690) * 1.16, 2) and jsonb_array_length(q->'lines') = 3
                         from (select license_quote('{"edition":"EDITION_MULTI","vertical":"SERVICES","items":[{"code":"EXTRA_CFDI_100","qty":2},{"code":"SUPPORT_PRIORITY"}]}') q) x),
  'MultiCaja + timbres ×2 + soporte prioritario: suma del catálogo con IVA');
select t_check('K02', (license_quote('{"edition":"EDITION_MONO","vertical":"COMMERCE","items":[{"code":"SUBSCRIPTION_ANNUAL"}]}'))->>'code' = 'NOT_SOLD_HERE'
                  and (license_quote('{"edition":"EDITION_MONO","vertical":"COMMERCE","items":[{"code":"SCREENS_UNLIMITED"}]}'))->>'code' = 'NOT_SOLD_HERE',
  'suscripción anual y pantallas ilimitadas (sin precio) no se pueden cobrar en un pedido');
insert into license_catalog (code, kind, label, list_price, billing) values ('EXTRA_T_TBD', 'EXTRA', 'Producto sin precio', null, 'ONE_TIME');
update license_catalog set active = false where code = 'EXTRA_ONBOARDING';
select t_check('K02', (license_quote('{"items":[{"code":"EXTRA_T_TBD"}]}'))->>'code' = 'PRICE_TBD'
                  and (license_quote('{"items":[{"code":"EXTRA_ONBOARDING"}]}'))->>'code' = 'INACTIVE'
                  and (license_quote('{"items":[{"code":"NO_EXISTE"}]}'))->>'code' = 'UNKNOWN_CODE'
                  and (license_quote('{"edition":"EDITION_MONO","vertical":"COMMERCE","items":[{"code":"EXTRA_CFDI_100","qty":0}]}'))->>'code' = 'BAD_QTY'
                  and (license_quote('{"edition":"EDITION_MONO"}'))->>'code' = 'BAD_VERTICAL'
                  and (license_quote('{"edition":"EDITION_MONO","vertical":"TIENDA"}'))->>'code' = 'BAD_VERTICAL',
  'precio por definir, inactivo, desconocido, cantidad inválida o giro faltante: no se cotiza');
-- Un producto del catálogo no se borra (tiene historial): se desactiva.
update license_catalog set active = false where code = 'EXTRA_T_TBD';
update license_catalog set active = true where code = 'EXTRA_ONBOARDING';
select t_check('K03', (select (q->>'total')::numeric = 2898.84 from (select license_quote('{"edition":"EDITION_MONO","vertical":"COMMERCE","price":1,"total":1,"lines":[{"code":"EDITION_MONO","unit_price":1}]}') q) x),
  'lo que el cliente mande como precio o total se ignora: manda el catálogo');

-- --------------------------------------------------------------- C · emitir desde un pedido pagado
insert into t_tmp values ('c1', license_create_from_order('{"provider":"PAYPAL","order_ref":"ORD-C1","license_key":"WYBIX-TEST-C001-0001","edition":"EDITION_MONO","vertical":"HOSPITALITY",
  "items":[{"code":"SUPPORT_PRIORITY"},{"code":"EXTRA_CFDI_100","qty":2}],"amount_paid":4279.24,"customer":{"name":"Ana","email":"ana@example.com","business":"Café Ana"},"cajas":1}'));
select t_check('C01', (select v->>'ok' = 'true' and v->>'existing' = 'false' from t_tmp where k = 'c1')
                  and (select plan = 'mono' and max_registers = 1 and origin = 'PRODUCTION' and support_tier = 'PRIORITY' and paypal_order_id = 'ORD-C1'
                         from licenses where license_key = 'WYBIX-TEST-C001-0001')
                  and (select array_agg(vertical) = array['HOSPITALITY'] and bool_and(source = 'INITIAL') from license_verticals v join licenses l on l.id = v.license_id where l.license_key = 'WYBIX-TEST-C001-0001'),
  'pedido pagado: la licencia nace con su edición, su ÚNICO giro, soporte prioritario y origen PRODUCTION');
select t_check('C01', (select count(*) = 3 and sum(price_paid) = 3689 and bool_or(kind = 'INITIAL' and catalog_code = 'EDITION_MONO' and list_price = 2499)
                         from license_purchases p join licenses l on l.id = p.license_id where l.license_key = 'WYBIX-TEST-C001-0001'),
  'cada línea queda en el historial de compras con su precio de lista del catálogo');
insert into t_tmp values ('c2', license_create_from_order('{"provider":"PAYPAL","order_ref":"ORD-C1","license_key":"WYBIX-OTRA-CLAV-0002","edition":"EDITION_MONO","vertical":"HOSPITALITY","amount_paid":4279.24}'));
select t_check('C02', (select v->>'existing' = 'true' and v->>'license_key' = 'WYBIX-TEST-C001-0001' from t_tmp where k = 'c2')
                  and (select count(*) from licenses where paypal_order_id = 'ORD-C1') = 1,
  'el mismo pago otra vez devuelve la MISMA licencia (idempotente)');
insert into t_tmp values ('c3', license_create_from_order('{"provider":"PAYPAL","order_ref":"ORD-C3","license_key":"WYBIX-TEST-C003-0003","edition":"EDITION_MULTI","vertical":"COMMERCE","amount_paid":2898.84}'));
select t_check('C03', (select v->>'code' = 'AMOUNT_MISMATCH' and (v->>'expected')::numeric = 4638.84 from t_tmp where k = 'c3')
                  and not exists (select 1 from licenses where license_key = 'WYBIX-TEST-C003-0003'),
  'pagar MonoCaja y pedir MultiCaja: se rechaza y no se crea nada');
insert into t_tmp values ('c4', license_create_from_order('{"provider":"PAYPAL","order_ref":"ORD-C4","license_key":"WYBIX-TEST-C004-0004","edition":"EDITION_MULTI","vertical":"SERVICES","amount_paid":4638.84}'));
select t_check('C04', (select plan = 'multi' and max_registers = 0 from licenses where license_key = 'WYBIX-TEST-C004-0004')
                  and (select bool_and((license_activate('WYBIX-TEST-C004-0004', 'C4-PC-' || g))->>'ok' = 'true') from generate_series(1, 5) g),
  'MultiCaja emitida en la transición: max_registers con el contrato anterior (0) y cajas ilimitadas');
insert into t_tmp values ('c5', license_create_from_order('{"provider":"PAYPAL","order_ref":"ORD-C5","amount_paid":290,"items":[{"code":"EXTRA_CFDI_100"}]}'));
select t_check('C05', (select v->>'ok' = 'true' and v->'license_id' = 'null'::jsonb from t_tmp where k = 'c5'),
  'un pedido solo de timbres se valida contra el catálogo y no crea licencia');
-- La web ANTERIOR creó una licencia con este pago (9999, sin giro); la nueva recibe el mismo pago.
insert into licenses (license_key, plan, customer_name, max_registers, paypal_order_id) values ('WYBIX-VIEJ-A000-0006', 'multi', 'Web anterior', 9999, 'ORD-C6');
insert into t_tmp values ('c6', license_create_from_order('{"provider":"PAYPAL","order_ref":"ORD-C6","license_key":"WYBIX-NUEV-A000-0006","edition":"EDITION_MULTI","vertical":"COMMERCE","amount_paid":4638.84}'));
select t_check('C06', (select v->>'existing' = 'true' and v->>'license_key' = 'WYBIX-VIEJ-A000-0006' from t_tmp where k = 'c6'),
  'un pago que ya emitió la web anterior no emite otra licencia');

-- --------------------------------------------------------------- T · prueba de UN giro
insert into device_trials (machine_id, started_at, expires_at) values ('PC-T1', now() - interval '2 days', now() + interval '28 days'),
                                                                      ('PC-T2', now() - interval '40 days', now() - interval '10 days');
select t_check('T01', (select g->'verticals' = '[]'::jsonb and g->'screens' = '{}'::jsonb and (g->'entitlements') ? 'sales'
                         and not (g->'entitlements') ?| array['commerce', 'hospitality', 'services'] and (g->>'registers_max')::int = 1
                         from (select license_trial_grants(null) g) x),
  'prueba sin giro elegido todavía: MonoCaja, ningún giro, ninguna pantalla');
insert into t_tmp values ('t1', license_trial_select_vertical('PC-T1', 'hospitality'));
select t_check('T02', (select v->>'ok' = 'true' from t_tmp where k = 't1')
                  and (select vertical = 'HOSPITALITY' and vertical_changes = 0 from device_trials where machine_id = 'PC-T1')
                  and (select g->'verticals' = '["HOSPITALITY"]'::jsonb and g->'screens' = '{"HOSPITALITY":3}'::jsonb
                            and (g->'entitlements') ? 'hospitality.kds' and not (g->'entitlements') ?| array['commerce', 'services', 'services.agenda']
                         from (select license_trial_grants('HOSPITALITY') g) x),
  'el alta elige Restaurantes: 30 días de MonoCaja + ese giro + 3 Pantallas Operativas de ese giro, sin los otros dos');
insert into t_tmp values ('t3', license_trial_select_vertical('PC-T1', 'SERVICES'));
select t_check('T03', (select v->>'previous' = 'HOSPITALITY' from t_tmp where k = 't3')
                  and (select vertical = 'SERVICES' and vertical_changes = 1 and expires_at > now() + interval '27 days' from device_trials where machine_id = 'PC-T1')
                  and exists (select 1 from license_events where type = 'TRIAL_VERTICAL_CHANGED' and data->>'machine_id' = 'PC-T1'),
  'cambiar el giro de evaluación: uno a la vez, sin mover las fechas, y queda en el historial');
select t_check('T04', (license_trial_select_vertical('PC-T2', 'COMMERCE'))->>'code' = 'TRIAL_EXPIRED'
                  and (license_trial_select_vertical('PC-NADA', 'COMMERCE'))->>'code' = 'NO_TRIAL'
                  and (license_trial_select_vertical('PC-T1', 'TODOS'))->>'code' = 'BAD_VERTICAL',
  'prueba vencida, inexistente o giro inválido: no se cambia nada');

-- --------------------------------------------------------------- O · refrescar no toca lo pagado
insert into t_tmp values ('o_antes', jsonb_build_object('paid', license_paid_until((select id from licenses where license_key = 'WYBX-MULT-0002')),
                                                        'subs', (select count(*) from license_subscriptions s join licenses l on l.id = s.license_id where l.license_key = 'WYBX-MULT-0002')));
select license_for_machine('PC-CAFE-1'), license_for_machine('PC-CAFE-1'), license_for_machine('PC-CAFE-1');
select t_check('O01', (select (v->>'paid')::timestamptz = license_paid_until((select id from licenses where license_key = 'WYBX-MULT-0002'))
                              and (v->>'subs')::int = (select count(*) from license_subscriptions s join licenses l on l.id = s.license_id where l.license_key = 'WYBX-MULT-0002')
                         from t_tmp where k = 'o_antes'),
  'validar o descargar el certificado (license_for_machine) NO modifica paid_until ni crea periodos');

-- --------------------------------------------------------------- H · precios con historial
select t_check('H01', (select count(*) from license_catalog_price_history where source = 'SEED') = 21
                  and (select count(*) from license_catalog_price_history h join license_catalog c on c.code = h.catalog_code
                        where h.source = 'SEED' and h.new_price is not distinct from c.list_price) >= 20,
  'cada producto tiene su precio inicial en el historial (el catálogo sembrado por la migración)');
insert into t_tmp values ('h_orden', license_create_from_order('{"provider":"PAYPAL","order_ref":"ORD-H1","license_key":"WYBIX-HIST-0000-0001","edition":"EDITION_MONO","vertical":"COMMERCE",
  "items":[{"code":"EXTRA_CFDI_100"}],"amount_paid":3188.84}'));
insert into t_tmp values ('h_cambio', license_catalog_update('EXTRA_CFDI_100', '{"list_price": 275}', 'ajuste del proveedor de timbres', 'admin:qa'));
select t_check('H02', (select v->>'ok' = 'true' and (v->'before'->>'list_price')::numeric = 250 and (v->'after'->>'list_price')::numeric = 275 from t_tmp where k = 'h_cambio')
                  and (select list_price from license_catalog where code = 'EXTRA_CFDI_100') = 275,
  'un administrador cambia un precio con una FUNCIÓN (sin migración ni código)');
select t_check('H03', (select old_price = 250 and new_price = 275 and changed_by = 'admin:qa' and reason = 'ajuste del proveedor de timbres'
                              and source = 'FUNCTION' and currency = 'MXN' and changed_at is not null
                         from license_catalog_price_history where catalog_code = 'EXTRA_CFDI_100' order by id desc limit 1),
  'historial: precio anterior, nuevo, moneda, cuándo, quién y por qué');
select t_check('H03', (select valid_to is not null from license_catalog_price_periods where catalog_code = 'EXTRA_CFDI_100' and list_price = 250 order by valid_from limit 1)
                  and (select valid_to is null from license_catalog_price_periods where catalog_code = 'EXTRA_CFDI_100' and list_price = 275),
  'y el periodo de cada precio: desde cuándo y hasta cuándo');
select t_check('H04', (select price_paid = 250 and list_price = 250 from license_purchases p join licenses l on l.id = p.license_id
                        where l.license_key = 'WYBIX-HIST-0000-0001' and p.catalog_code = 'EXTRA_CFDI_100')
                  and (select price_paid = 2499 from license_purchases p join licenses l on l.id = p.license_id
                        where l.license_key = 'WYBIX-HIST-0000-0001' and p.catalog_code = 'EDITION_MONO'),
  'cambiar el precio de lista NO reescribe compras pasadas: la compra conserva 250 (lista y pagado)');
select t_check('H04', (select (q->'lines'->1->>'unit_price')::numeric = 275 from (select license_quote('{"edition":"EDITION_MONO","vertical":"COMMERCE","items":[{"code":"EXTRA_CFDI_100"}]}') q) x),
  'las operaciones NUEVAS se cotizan con el precio nuevo');
select t_check('H05', (license_catalog_update('EXTRA_CFDI_100', '{"list_price": 1}', '', 'admin'))->>'code' = 'BAD_REQUEST'
                  and (license_catalog_update('EXTRA_CFDI_100', '{"list_price": -5}', 'precio negativo', 'admin'))->>'code' = 'BAD_REQUEST'
                  and (license_catalog_update('TAX_IVA_MX', '{"active": false}', 'quitar el IVA', 'admin'))->>'code' = 'BAD_REQUEST'
                  and (license_catalog_update('NO_EXISTE', '{"list_price": 1}', 'producto inventado', 'admin'))->>'code' = 'NOT_FOUND'
                  and (select list_price from license_catalog where code = 'EXTRA_CFDI_100') = 275,
  'sin motivo, precio negativo, el impuesto o un producto inexistente: no se cambia nada');
select license_catalog_update('EXTRA_CFDI_100', '{"list_price": 250}', 'vuelve al precio vigente (prueba)', 'admin:qa');
update license_catalog set reference_price = 999 where code = 'EXTRA_APP_MOBILE';
select t_check('H06', (select source = 'DIRECT' and reason = 'cambio directo, sin motivo' and new_reference_price = 999
                         from license_catalog_price_history where catalog_code = 'EXTRA_APP_MOBILE' order by id desc limit 1),
  'un cambio hecho por fuera de la función (migración o a mano) también queda en el historial, marcado DIRECT');
update license_catalog set reference_price = null where code = 'EXTRA_APP_MOBILE';
select t_check('H07', t_negado($q$update public.license_catalog set list_price = 1 where code = 'EDITION_MONO'$q$, 'anon')
                  and t_negado($q$update public.license_catalog set list_price = 1 where code = 'EDITION_MONO'$q$, 'authenticated')
                  and t_negado($q$select public.license_catalog_update('EDITION_MONO', '{"list_price": 1}', 'hack de un cliente', 'yo')$q$, 'authenticated')
                  and t_negado($q$select public.license_catalog_update('EDITION_MONO', '{"list_price": 1}', 'hack anónimo', 'yo')$q$, 'anon')
                  and t_negado('select * from public.license_catalog_price_history', 'anon')
                  and (select list_price from license_catalog where code = 'EDITION_MONO') = 2499,
  'ni anon ni un cliente autenticado cambian precios ni ven el historial; solo el backend privilegiado');
select t_check('H08', (select count(*) from license_catalog where code in ('SUBSCRIPTION_MONTHLY', 'SUBSCRIPTION_ANNUAL', 'SCREENS_EXTENDED', 'SCREENS_UNLIMITED',
                          'VERTICAL_COMMERCE', 'VERTICAL_HOSPITALITY', 'VERTICAL_SERVICES', 'ADDON_MULTIBRANCH') and list_price is null) = 8
                  and (select list_price from license_catalog where code = 'EDITION_MULTI') = 3999,
  'ningún precio nuevo: mensual, anual, giros, pantallas y MultiSucursal siguen sin precio; $2,499 / $3,999 intactos');

-- --------------------------------------------------------------- Q · licencias de pruebas
insert into licenses (id, license_key, plan, customer_name, max_registers, origin) values
  ('00000000-0000-0000-0000-000000000031', 'WYBIX-QAQA-0000-0031', 'mono', 'VM QA', 1, 'QA'),
  ('00000000-0000-0000-0000-000000000032', 'WYBIX-PROD-0000-0032', 'mono', 'Cliente real', 1, 'PRODUCTION');
insert into t_tmp values ('qa1', license_qa_grant('00000000-0000-0000-0000-000000000031', '{"verticals":["COMMERCE","HOSPITALITY"],"screen_tier":"UNLIMITED","edition":"multi","paid_until":"2027-12-31"}', 'suite E2E', 'admin'));
select t_check('QA1', (select v->>'ok' = 'true' from t_tmp where k = 'qa1')
                  and (select r->'screens' = '{"COMMERCE":null,"HOSPITALITY":null}'::jsonb and r->>'edition' = 'multi' and r->>'origin' = 'QA'
                            and (r->>'paid_until')::timestamptz >= '2027-12-31'
                         from (select license_runtime('00000000-0000-0000-0000-000000000031') r) x)
                  and not exists (select 1 from license_purchases where license_id = '00000000-0000-0000-0000-000000000031'),
  'licencia QA: permisos EXPLÍCITOS (giros, MultiCaja, pantallas ilimitadas, periodo) sin compras, y el runtime dice QA');
select t_check('QA2', (license_qa_grant('00000000-0000-0000-0000-000000000032', '{"verticals":["SERVICES"],"screen_tier":"UNLIMITED"}', 'regalar', 'admin'))->>'code' = 'NOT_QA'
                  and not exists (select 1 from license_verticals where license_id = '00000000-0000-0000-0000-000000000032'),
  'esos mismos permisos a una licencia comercial (PRODUCTION): rechazo');
select t_check('QA3', not exists (select 1 from license_commercial_licenses where id = '00000000-0000-0000-0000-000000000031')
                  and exists (select 1 from license_commercial_licenses where id = '00000000-0000-0000-0000-000000000032')
                  and not exists (select 1 from license_commercial_licenses where origin is distinct from 'PRODUCTION')
                  and not exists (select 1 from license_commercial_purchases p join licenses l on l.id = p.license_id where l.origin is distinct from 'PRODUCTION'),
  'las métricas comerciales (clientes, compras) solo ven PRODUCTION: QA/TEST/INTERNAL no son clientes pagados');
select t_check('QA4', t_negado('select * from public.license_commercial_licenses', 'anon')
                  and t_negado($q$select public.license_qa_grant('00000000-0000-0000-0000-000000000031', '{}', 'x', 'y')$q$, 'authenticated'),
  'permisos QA y métricas: solo el backend');

-- --------------------------------------------------------------- X · seguridad
select t_check('X01', t_negado('select * from public.licenses', 'anon') and t_negado('select * from public.licenses', 'authenticated'),
  'anon y authenticated no leen licencias');
select t_check('X02', t_negado($q$update public.licenses set plan = 'multi', max_registers = null$q$, 'authenticated')
                  and t_negado($q$insert into public.license_verticals (license_id, vertical) values ('00000000-0000-0000-0000-000000000004', 'HOSPITALITY')$q$, 'authenticated')
                  and t_negado($q$insert into public.license_subscriptions (license_id, kind, period_start, period_end) values ('00000000-0000-0000-0000-000000000004', 'MANUAL', now(), now() + interval '9 years')$q$, 'authenticated')
                  and t_negado($q$update public.license_verticals set screen_tier = 'UNLIMITED'$q$, 'anon')
                  and t_negado($q$insert into public.license_purchases (license_id, kind, discount_pct) values ('00000000-0000-0000-0000-000000000004', 'INITIAL', 100)$q$, 'authenticated'),
  'un usuario web no cambia edición, no agrega giros, no extiende fechas, no amplía pantallas, no fabrica descuentos');
select t_check('X03', t_negado($q$select public.license_activate('WYBX-MULT-0003', 'HACK')$q$, 'anon')
                  and t_negado($q$select public.license_renew('00000000-0000-0000-0000-000000000004', 'ANNUAL', '{}', 'x')$q$, 'authenticated')
                  and t_negado($q$select public.license_upgrade_to_multi('00000000-0000-0000-0000-000000000004', '{}', 'x')$q$, 'anon'),
  'las funciones de licencia solo las ejecuta el backend (service_role)');
select t_check('X04', not has_table_privilege('anon', 'public.licenses', 'TRUNCATE')
                  and not has_table_privilege('authenticated', 'public.device_trials', 'TRUNCATE'),
  'sin TRUNCATE para anon/authenticated (RLS no lo cubre)');
select t_check('X05', not t_negado('select code, list_price from public.license_catalog', 'anon'),
  'el catálogo activo sí es público (precios de lista)');
set role anon;
select t_check('X05', (select count(*) from public.license_catalog where not active) = 0, 'anon solo ve productos activos');
reset role;
select t_check('X07', t_negado($q$select public.license_create_from_order('{"provider":"PAYPAL","order_ref":"HACK","license_key":"WYBIX-HACK-HACK-HACK","edition":"EDITION_MULTI","vertical":"COMMERCE","amount_paid":99999}')$q$, 'anon')
                  and t_negado($q$select public.license_quote('{}')$q$, 'authenticated')
                  and t_negado($q$select public.license_trial_select_vertical('PC-T1', 'COMMERCE')$q$, 'anon')
                  and t_negado('select * from public.license_review_queue', 'anon'),
  'emitir, cotizar, cambiar el giro de prueba y la cola de revisión: solo el backend');
select t_check('X06', t_negado('select * from public.license_support_summary', 'authenticated')
                  and t_negado('select * from public.license_events', 'anon'),
  'soporte e historial no son públicos');

select string_agg(format('%s|%s|%s', case when ok then 'ok' else 'FALLA' end, id, msg), E'\n' order by n) as resultado from t_res;
