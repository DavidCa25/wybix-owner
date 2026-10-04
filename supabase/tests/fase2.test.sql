-- ============================================================================
--  PRUEBAS DE LA FASE 2 EN LA NUBE: EVENT, POS MOBILE, INVENTARIO, DERECHOS
--  Corre DESPUÉS de fase1.test.sql sobre la misma base (I Do Nut con Centro,
--  Norte y su dueña ya existen) y de aplicar la migración de la Fase 2.
-- ============================================================================
-- business_date en la hora de la sucursal, como el POS (ver fase1.test.sql).
set timezone = 'America/Mexico_City';
create or replace function t_ev2(p_type text, p_agg text, p_agg_uuid uuid, p_seq bigint, p_payload jsonb, p_at timestamptz default now(), p_event uuid default gen_random_uuid())
returns jsonb language sql as $$
  select jsonb_build_object('event_uuid', p_event, 'event_type', p_type, 'aggregate_type', p_agg, 'aggregate_uuid', p_agg_uuid,
                            'aggregate_version', p_seq, 'local_seq', p_seq, 'occurred_at', p_at, 'payload_version', 1, 'payload', p_payload)
$$;
create or replace function t_stock(p_loc uuid, p_prod uuid) returns numeric language sql as $$
  select coalesce((select qty from location_stock where location_id = p_loc and product_uuid = p_prod), 0)
$$;

select t_set('A', '"a1a1a1a1-0000-4000-8000-0000000000a1"');      -- Producto A (dona)
select t_set('L', '"a1a1a1a1-0000-4000-8000-0000000000b2"');      -- Leche
select t_set('feria_vieja', to_jsonb((select id from sucursales where nombre = 'Feria del Libro')));

-- ============================================================== F2-MIG
select t_check('F2-MIG01', (select event_status from sucursales where nombre = 'Feria del Libro') = 'PLANNED',
  'el EVENT creado en la Fase 1 queda PLANNED (y activo) al migrar');
select t_check('F2-MIG02', (select count(*) from sales_facts) > 0 and (select count(*) from devices) > 0,
  'la migración no toca ventas ni equipos existentes');

-- ============================================================== F2-LIC derechos
select t_check('F2-LIC01', (company_entitlements((t_s('centro', 'company_id'))::uuid)->>'enforced')::boolean
                  and (company_entitlements((t_s('centro', 'company_id'))::uuid)->>'temporary_locations')::boolean = false,
  'los derechos ya se aplican; I Do Nut aún no tiene eventos ni tablets');
select t_check('F2-LIC02', t_q('a0000000-0000-0000-0000-00000000000a', format('select (owner_crear_evento(%L, jsonb_build_object(''nombre'', ''Feria León 2026'', ''home_location_id'', %L))->>''code'')',
                  t_s('centro', 'company_id'), t_s('centro', 'location_id'))) = 'NO_ENTITLEMENT_TEMPORARY_LOCATIONS',
  'sin temporary_locations no se crea un EVENT');
select t_check('F2-LIC03', pos_create_location(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a', 'company_id', t_s('centro', 'company_id'),
                  'nombre', 'Sur', 'tipo', 'BRANCH'))->>'code' = 'LIMIT_LOCATIONS',
  'locations_max: dos licencias = dos sucursales; una tercera BRANCH se rechaza');
select t_set('sinlic', pos_bootstrap('{"instance_uuid":"e0000000-0000-0000-0000-0000000000e1","device_uuid":"e0000000-0000-0000-0000-00000000e0d1","nombre_negocio":"Sin Licencia"}'));
select t_check('F2-LIC04', pos_create_location(jsonb_build_object('device_id', t_s('sinlic', 'device_id'), 'nombre', 'Otra', 'tipo', 'BRANCH'))->>'code' = 'NO_LICENSE',
  'empresa sin licencia ligada: no crea sucursales nuevas (antes hay que conciliar)');
-- Se contrata el complemento de eventos y tablet (sin precio en el catálogo).
update licenses set addons = array_append(coalesce(addons, '{}'), 'MOBILE_POS') where license_key = 'WYBX-IDN-CENT';
select t_check('F2-LIC05', (company_entitlements((t_s('centro', 'company_id'))::uuid)->>'mobile_pos_max')::int = 1
                  and (company_entitlements((t_s('centro', 'company_id'))::uuid)->>'temporary_locations')::boolean
                  and (select list_price from license_catalog where code = 'ADDON_MOBILE_POS') is null,
  'con ADDON_MOBILE_POS: eventos y 1 tablet (el precio sigue por definir)');

-- ============================================================== F2-EVT
select t_set('feria', t_q('a0000000-0000-0000-0000-00000000000a', format('select owner_crear_evento(%L, jsonb_build_object(''nombre'', ''Feria León 2026'', ''home_location_id'', %L, ''starts_at'', ''2026-11-01'', ''ends_at'', ''2026-11-10'', ''codigo'', ''FL26''))::text',
                  t_s('centro', 'company_id'), t_s('centro', 'location_id')))::jsonb);
select t_check('F2-EVT01', (t_s('feria', 'ok'))::boolean and t_s('feria', 'event_status') = 'PLANNED'
                  and (select home_location_id from sucursales where id = (t_s('feria', 'location_id'))::uuid) = (t_s('centro', 'location_id'))::uuid
                  and (select timezone from sucursales where id = (t_s('feria', 'location_id'))::uuid) = 'America/Mexico_City',
  'la dueña crea "Feria León 2026" (EVENT, base Centro, PLANNED, zona horaria de Centro)');
select t_check('F2-EVT02', t_q('a0000000-0000-0000-0000-00000000000a', format('select owner_crear_evento(%L, jsonb_build_object(''nombre'', ''X''))->>''code''', t_s('centro', 'company_id'))) = 'HOME_REQUIRED',
  'un EVENT sin sucursal base no se crea');
select t_check('F2-EVT03', t_q('e0000000-0000-0000-0000-00000000000e', format('select owner_crear_evento(%L, jsonb_build_object(''nombre'', ''X'', ''home_location_id'', %L))->>''code''',
                  t_s('centro', 'company_id'), t_s('centro', 'location_id'))) = 'DENIED',
  'un VIEWER (encargado de Centro) no crea eventos');
select t_check('F2-EVT04', (select count(*) from sucursales where negocio_id = (t_s('centro', 'company_id'))::uuid and tipo = 'BRANCH' and status in ('ACTIVE', 'PENDING')) = 2,
  'un EVENT no cuenta como sucursal');

-- ============================================================== F2-PUB catálogo y personal
select t_set('catalogo1', jsonb_build_object(
  'products', jsonb_build_array(
     jsonb_build_object('uuid', t_get('A')#>>'{}', 'nombre', 'Dona glaseada', 'price', '25.00', 'cost', '6.5000', 'inventory_mode', 'DIRECT', 'sellable', true, 'active', true, 'modifier_groups', '[]'::jsonb),
     jsonb_build_object('uuid', t_get('L')#>>'{}', 'nombre', 'Leche', 'price', '0', 'cost', '0.0250', 'inventory_mode', 'DIRECT', 'sellable', false, 'active', true, 'modifier_groups', '[]'::jsonb)),
  'recipes', '[]'::jsonb, 'modifier_groups', '[]'::jsonb, 'categories', '[]'::jsonb));
select t_set('pub1', pos_publicar(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'catalog', t_get('catalogo1'), 'staff', jsonb_build_array(
  jsonb_build_object('uuid', t_s('cajera', 'uuid'), 'name', 'lupita', 'branch_role', 'cajero', 'pin_hash', 'H-lupita', 'pin_sal', 'S1', 'pin_algo', 'scrypt:16384:8:1:32'),
  jsonb_build_object('uuid', t_s('encargada', 'uuid'), 'name', 'marta', 'branch_role', 'supervisor', 'pin_hash', 'H-marta', 'pin_sal', 'S2', 'pin_algo', 'scrypt:16384:8:1:32')))));
select t_check('F2-PUB01', (t_s('pub1', 'catalog_version'))::int = 1 and (t_s('pub1', 'staff'))::int = 2, 'Centro publica catálogo (v1) y personal con PIN');
select t_check('F2-PUB02', (pos_publicar(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'catalog', t_get('catalogo1')))->>'catalog_version')::int = 1,
  'publicar lo mismo no crea otra versión');
select t_check('F2-PUB03', pos_publicar(jsonb_build_object('device_id', t_s('centro2', 'device_id'), 'catalog', t_get('catalogo1')))->>'code' = 'DENIED',
  'solo la caja principal publica');
select t_check('F2-PUB04', t_q('a0000000-0000-0000-0000-00000000000a', 'select pin_hash from employees limit 1') = 'ERR:42501'
                  and t_q('a0000000-0000-0000-0000-00000000000a', format('select (owner_empleados(%L)->0) ? ''tiene_pin''', t_s('centro', 'company_id'))) = 'true'
                  and t_q('a0000000-0000-0000-0000-00000000000a', format('select owner_empleados(%L)::text like ''%%H-lupita%%''', t_s('centro', 'company_id'))) = 'false',
  'los hashes de PIN nunca son legibles desde la app (solo "tiene PIN")');
select t_set('lupita_emp', to_jsonb((select id from employees where pos_user_uuid = (t_s('cajera', 'uuid'))::uuid)));
select t_set('marta_emp', to_jsonb((select id from employees where pos_user_uuid = (t_s('encargada', 'uuid'))::uuid)));
select t_q('a0000000-0000-0000-0000-00000000000a', format('select owner_asignar_personal(%L, %L, %L, ''CASHIER'')::text', t_s('centro', 'company_id'), t_s('feria', 'location_id'), t_get('lupita_emp')#>>'{}'));
select t_q('a0000000-0000-0000-0000-00000000000a', format('select owner_asignar_personal(%L, %L, %L, ''SUPERVISOR'')::text', t_s('centro', 'company_id'), t_s('feria', 'location_id'), t_get('marta_emp')#>>'{}'));
select t_check('F2-PUB06', (select count(*) from location_staff where location_id = (t_s('feria', 'location_id'))::uuid) = 2
                  and (select role from location_staff ls join employees e on e.id = ls.employee_id where e.display_name = 'marta' and ls.location_id = (t_s('feria', 'location_id'))::uuid) = 'SUPERVISOR',
  'el personal y su rol se asignan POR EVENTO');
select t_check('F2-PUB07', t_q('b0000000-0000-0000-0000-00000000000b', format('select owner_asignar_personal(%L, %L, %L, ''ADMIN'')::text', t_s('centro', 'company_id'), t_s('feria', 'location_id'), t_get('lupita_emp')#>>'{}')) like '%DENIED%',
  'otra persona sin membresía no asigna personal');

-- ============================================================== F2-ENR tablet
select t_set('codigo_t1', t_q('a0000000-0000-0000-0000-00000000000a', format('select owner_codigo_tablet(%L, %L, ''Caja Feria'')::text', t_s('centro', 'company_id'), t_s('feria', 'location_id')))::jsonb);
select t_check('F2-ENR01', (t_s('codigo_t1', 'ok'))::boolean and t_get('codigo_t1')->'register'->>'code' = 'F1', 'código de tablet con su caja F1');
select t_set('t1', pos_enroll(jsonb_build_object('code', t_s('codigo_t1', 'code'), 'device_uuid', 'f1000000-0000-4000-8000-00000000000a', 'kind', 'MOBILE_POS', 'app_version', '0.1.0')));
select t_check('F2-ENR02', (t_s('t1', 'ok'))::boolean and (select kind from devices where id = (t_s('t1', 'device_id'))::uuid) = 'MOBILE_POS'
                  and (select register_id from devices where id = (t_s('t1', 'device_id'))::uuid) is not null and t_s('t1', 'install_secret') is null,
  'la tablet se enrola: Company -> EVENT -> Register -> Device (MOBILE_POS)');
select t_check('F2-ENR03', t_q('a0000000-0000-0000-0000-00000000000a', format('select owner_codigo_tablet(%L, %L)->>''code''', t_s('centro', 'company_id'), t_s('feria', 'location_id'))) = 'LIMIT_MOBILE_POS',
  'cupo de tablets alcanzado: no se emite otro código');
select t_check('F2-ENR04', pos_enroll(jsonb_build_object('install_secret', t_s('centro', 'install_secret'), 'instance_uuid', 'c0000000-0000-0000-0000-0000000000c1',
                  'device_uuid', gen_random_uuid(), 'kind', 'MOBILE_POS'))->>'code' = 'DENIED',
  'una tablet no entra con la llave de instalación de una sucursal');
select t_check('F2-ENR05', t_q('a0000000-0000-0000-0000-00000000000a', format('select owner_codigo_tablet(%L, %L)->>''code''', t_s('centro', 'company_id'), t_s('norte', 'location_id'))) = 'DENIED',
  'no se enrolan tablets en una BRANCH (POS Mobile solo opera EVENT)');

-- ============================================================== F2-SNP snapshot
select pos_registrar_llave(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'public_key', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'));
select t_set('snap1', mobile_snapshot(jsonb_build_object('device_id', t_s('t1', 'device_id'))));
select t_check('F2-SNP01', (t_get('snap1')->'catalog'->>'catalog_version')::int = 1 and jsonb_array_length(t_get('snap1')->'staff') = 2
                  and t_get('snap1')->'location'->>'tipo' = 'EVENT' and t_get('snap1')->'register'->>'code' = 'F1'
                  and t_get('snap1')->'releases'->>'min_supported_version' = '0.1.0'
                  and jsonb_array_length(t_get('snap1')->'trusted_keys') = 1,
  'el snapshot trae catálogo de Centro, personal del evento con su PIN, caja, llaves de confianza y versión mínima');
select t_check('F2-SNP02', (select bool_and(s->>'role' in ('CASHIER', 'SUPERVISOR')) from jsonb_array_elements(t_get('snap1')->'staff') s)
                  and t_get('snap1')::text not like '%Sin Licencia%',
  'solo personal asignado a ESTE evento, nada de otras empresas');
select t_check('F2-SNP03', mobile_snapshot(jsonb_build_object('device_id', t_s('centro', 'device_id')))->>'code' = 'DEVICE_REVOKED',
  'el snapshot de tablet es solo para tablets');

-- ============================================================== F2-TRF y F2-INV: el flujo de I Do Nut
select t_set('trf1', jsonb_build_object('uuid', gen_random_uuid()));
select t_set('r_envio', sync_ingest(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'envelope', jsonb_build_object('server_fingerprint', 'FP-CENTRO'),
  'events', jsonb_build_array(t_ev2('TRANSFER_SENT', 'TRANSFER', (t_s('trf1', 'uuid'))::uuid, 900, jsonb_build_object(
     'transfer_uuid', t_s('trf1', 'uuid'), 'kind', 'OUT', 'status', 'SENT', 'event_location_uuid', t_s('feria', 'location_id'), 'event_name', 'Feria León 2026',
     'lines', jsonb_build_array(jsonb_build_object('product_uuid', t_get('A')#>>'{}', 'product_name', 'Dona glaseada', 'qty_sent', '40.00'))))))));
select t_check('F2-TRF01', t_get('r_envio')->'results'->0->>'result' = 'APPLIED'
                  and (select status from stock_transfers where transfer_uuid = (t_s('trf1', 'uuid'))::uuid) = 'SENT'
                  and t_stock((t_s('centro', 'location_id'))::uuid, (t_get('A')#>>'{}')::uuid) = -40,
  'Centro envía 40 a la feria: TRANSFER_OUT en Centro, transferencia SENT');
select t_check('F2-TRF02', (select jsonb_array_length(mobile_snapshot(jsonb_build_object('device_id', t_s('t1', 'device_id')))->'transfers')) = 1,
  'la tablet ve la transferencia pendiente en su snapshot');
-- Tablet: recibe 40, vende 32 (31 efectivo + 1 tarjeta), merma de leche, sin Internet; sincroniza después.
select t_set('lote_t1', (select jsonb_agg(e) from (
  select t_ev2('TRANSFER_RECEIVED', 'TRANSFER', (t_s('trf1', 'uuid'))::uuid, 1, jsonb_build_object('transfer_uuid', t_s('trf1', 'uuid'), 'from_location_uuid', t_s('centro', 'location_id'),
           'lines', jsonb_build_array(jsonb_build_object('product_uuid', t_get('A')#>>'{}', 'qty_sent', '40.00', 'qty_received', '40.00', 'difference', '0.00')),
           'movements', jsonb_build_array(jsonb_build_object('uuid', gen_random_uuid(), 'product_uuid', t_get('A')#>>'{}', 'type', 'TRANSFER_IN', 'quantity', '40.00')))) e
  union all
  select t_ev2('SALE_RECORDED', 'SALE', v, 1 + n, jsonb_build_object('sale_uuid', v, 'folio', 'F1-' || lpad(n::text, 6, '0'), 'business_date', current_date,
           'total', case when n = 8 then '25.00' else (q * 25)::text end, 'paid_amount', '0', 'balance', '0.00', 'refunded_total', '0.00',
           'payment_method', case when n = 8 then 'TARJETA' else 'EFECTIVO' end, 'catalog_version', 1,
           'register', jsonb_build_object('uuid', t_get('snap1')->'register'->>'uuid', 'code', 'F1', 'name', 'Caja Feria'),
           'user', jsonb_build_object('uuid', t_s('cajera', 'uuid'), 'name', 'lupita'),
           'lines', jsonb_build_array(jsonb_build_object('line_no', 1, 'product_uuid', t_get('A')#>>'{}', 'product_name', 'Dona glaseada', 'quantity', q::text, 'unit_price', '25.00', 'unit_cost', '6.5000')),
           'movements', jsonb_build_array(jsonb_build_object('uuid', gen_random_uuid(), 'product_uuid', t_get('A')#>>'{}', 'type', 'SALE', 'quantity', q::text))))
    from (select n, gen_random_uuid() v, case when n = 8 then 1 else (case when n <= 6 then 5 else 1 end) end q from generate_series(1, 8) n) x
  union all
  select t_ev2('INVENTORY_MOVEMENT_RECORDED', 'INVENTORY_MOVEMENT', m, 20, jsonb_build_object('movement', jsonb_build_object('uuid', m, 'product_uuid', t_get('L')#>>'{}',
           'type', 'WASTE', 'quantity', '100.00', 'reason', 'Se cortó'))) from (select gen_random_uuid() m) y) z));
select t_set('r_t1', sync_ingest(jsonb_build_object('device_id', t_s('t1', 'device_id'), 'envelope', jsonb_build_object('company_uuid', t_s('centro', 'company_id'),
  'location_uuid', t_s('feria', 'location_id'), 'device_now', now()), 'events', t_get('lote_t1'))));
select t_check('F2-INV01', (select bool_and(x->>'result' = 'APPLIED') from jsonb_array_elements(t_get('r_t1')->'results') x),
  'el lote de la tablet se aplica completo', (select string_agg(distinct x->>'result' || coalesce(':' || (x->>'error'), ''), ',') from jsonb_array_elements(t_get('r_t1')->'results') x));
select t_check('F2-INV02', t_stock((t_s('feria', 'location_id'))::uuid, (t_get('A')#>>'{}')::uuid) = 8
                  and t_stock((t_s('feria', 'location_id'))::uuid, (t_get('L')#>>'{}')::uuid) = -100,
  'EVENT = 40 - 32 = 8 (la merma de leche también es un hecho)');
select t_check('F2-INV03', (select status from stock_transfers where transfer_uuid = (t_s('trf1', 'uuid'))::uuid) = 'RECEIVED'
                  and (select count(*) from sale_line_facts where location_id = (t_s('feria', 'location_id'))::uuid) = 8,
  'la transferencia queda RECIBIDA y las ventas con sus líneas');
select t_set('suma_feria', to_jsonb((select sum(total) from sales_facts where location_id = (t_s('feria', 'location_id'))::uuid)));
select t_set('r_t1b', sync_ingest(jsonb_build_object('device_id', t_s('t1', 'device_id'), 'events', t_get('lote_t1'))));
select t_check('F2-INV04', (select bool_and(x->>'result' = 'DUPLICATE') from jsonb_array_elements(t_get('r_t1b')->'results') x)
                  and t_stock((t_s('feria', 'location_id'))::uuid, (t_get('A')#>>'{}')::uuid) = 8
                  and (select sum(total) from sales_facts where location_id = (t_s('feria', 'location_id'))::uuid) = (t_get('suma_feria'))::numeric,
  'el mismo lote otra vez: DUPLICATE y ningún total cambia');
select t_check('F2-INV05', (select count(*) from reconciliation_items where kind = 'STOCK_NEGATIVE' and ref like t_s('feria', 'location_id') || '%') = 1,
  'stock negativo (leche) no rechaza nada: queda alerta para conciliar');

-- Retorno: la feria regresa 8; Centro los recibe.
select t_set('ret', jsonb_build_object('uuid', gen_random_uuid()));
select t_check('F2-EVT05', evento_cambiar_estado(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a', 'company_id', t_s('centro', 'company_id'),
                  'location_id', t_s('feria', 'location_id'), 'status', 'OPEN'))->>'event_status' = 'OPEN', 'la feria abre');
select t_set('r_ret', sync_ingest(jsonb_build_object('device_id', t_s('t1', 'device_id'), 'events', jsonb_build_array(
  t_ev2('RETURN_SENT', 'TRANSFER', (t_s('ret', 'uuid'))::uuid, 30, jsonb_build_object('transfer_uuid', t_s('ret', 'uuid'), 'kind', 'RETURN',
     'lines', jsonb_build_array(jsonb_build_object('product_uuid', t_get('A')#>>'{}', 'product_name', 'Dona glaseada', 'qty_sent', '8.00')),
     'movements', jsonb_build_array(jsonb_build_object('uuid', gen_random_uuid(), 'product_uuid', t_get('A')#>>'{}', 'type', 'RETURN_TRANSFER_OUT', 'quantity', '8.00'))))))));
select t_check('F2-TRF03', t_stock((t_s('feria', 'location_id'))::uuid, (t_get('A')#>>'{}')::uuid) = 0
                  and jsonb_array_length(pos_transfer_inbox(jsonb_build_object('device_id', t_s('centro', 'device_id')))->'returns') = 1,
  'RETURN_TRANSFER_OUT 8: EVENT = 0; Centro tiene un retorno por recibir');
select t_check('F2-EVT06', evento_cambiar_estado(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a', 'company_id', t_s('centro', 'company_id'),
                  'location_id', t_s('feria', 'location_id'), 'status', 'CLOSED'))->>'ok' = 'true'
                  and evento_cambiar_estado(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a', 'company_id', t_s('centro', 'company_id'),
                  'location_id', t_s('feria', 'location_id'), 'status', 'RECONCILED'))->>'code' = 'TRANSFERS_IN_TRANSIT',
  'no se concilia con mercancía en tránsito');
select t_set('r_recib', sync_ingest(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'envelope', jsonb_build_object('server_fingerprint', 'FP-CENTRO'),
  'events', jsonb_build_array(t_ev2('RETURN_RECEIVED', 'TRANSFER', (t_s('ret', 'uuid'))::uuid, 901, jsonb_build_object('transfer_uuid', t_s('ret', 'uuid'),
     'kind', 'RETURN_IN', 'status', 'RECEIVED', 'event_location_uuid', t_s('feria', 'location_id'),
     'lines', jsonb_build_array(jsonb_build_object('product_uuid', t_get('A')#>>'{}', 'qty_sent', '8.00', 'qty_received', '8.00'))))))));
select t_check('F2-TRF04', t_stock((t_s('centro', 'location_id'))::uuid, (t_get('A')#>>'{}')::uuid) = -32
                  and (select status from stock_transfers where transfer_uuid = (t_s('ret', 'uuid'))::uuid) = 'RECEIVED',
  'Centro recibe RETURN_TRANSFER_IN 8 (ledger de Centro: -40 + 8 = -32 sobre su stock propio)');
select t_check('F2-EVT07', evento_cambiar_estado(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a', 'company_id', t_s('centro', 'company_id'),
                  'location_id', t_s('feria', 'location_id'), 'status', 'RECONCILED'))->>'code' = 'STOCK_NOT_ZERO',
  'tampoco con inventario distinto de cero (la leche mermada quedó en -100)');
select t_set('conc', evento_cambiar_estado(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a', 'company_id', t_s('centro', 'company_id'),
                  'location_id', t_s('feria', 'location_id'), 'status', 'RECONCILED', 'forzar', true, 'motivo', 'Leche de la feria no se transfirió: se compró allá')));
select t_check('F2-EVT08', t_s('conc', 'event_status') = 'RECONCILED'
                  and (select reconciliation->>'motivo' from sucursales where id = (t_s('feria', 'location_id'))::uuid) like 'Leche%',
  'se concilia con motivo y el faltante queda registrado, no escondido');

-- ============================================================== F2-SEC seguridad
select t_set('otra', pos_bootstrap('{"instance_uuid":"e0000000-0000-0000-0000-0000000000e9","device_uuid":"e0000000-0000-0000-0000-00000000e0d9","nombre_negocio":"Birrieria XYZ"}'));
select t_check('F2-SEC01', sync_ingest(jsonb_build_object('device_id', t_s('t1', 'device_id'), 'envelope', jsonb_build_object('company_uuid', t_s('otra', 'company_id')),
                  'events', '[]'::jsonb))->>'code' = 'ENVELOPE_MISMATCH'
                  and sync_ingest(jsonb_build_object('device_id', t_s('t1', 'device_id'), 'envelope', jsonb_build_object('location_uuid', t_s('otra', 'location_id')),
                  'events', '[]'::jsonb))->>'code' = 'ENVELOPE_MISMATCH',
  'tablet de I Do Nut publicando como Birriería XYZ (empresa o ubicación): DENEGADO');
select t_set('r_sec', sync_ingest(jsonb_build_object('device_id', t_s('t1', 'device_id'), 'events', jsonb_build_array(
  t_ev2('TRANSFER_SENT', 'TRANSFER', gen_random_uuid(), 40, jsonb_build_object('lines', '[]'::jsonb)),
  t_ev2('INVENTORY_MOVEMENT_RECORDED', 'INVENTORY_MOVEMENT', gen_random_uuid(), 41, jsonb_build_object('movement', jsonb_build_object('uuid', gen_random_uuid(), 'product_uuid', t_get('A')#>>'{}', 'type', 'TRANSFER_OUT', 'quantity', '5'))),
  t_ev2('TRANSFER_RECEIVED', 'TRANSFER', (t_s('ret', 'uuid'))::uuid, 42, jsonb_build_object('lines', '[]'::jsonb, 'movements', '[]'::jsonb))))));
select t_check('F2-SEC02', (select bool_and(x->>'result' = 'REJECTED') from jsonb_array_elements(t_get('r_sec')->'results') x),
  'la tablet no puede emitir envíos de sucursal, movimientos ajenos a un evento ni "recibir" un retorno', t_get('r_sec')::text);
select t_set('trf_mod', jsonb_build_object('uuid', gen_random_uuid()));
select sync_ingest(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'envelope', jsonb_build_object('server_fingerprint', 'FP-CENTRO'), 'events', jsonb_build_array(
  t_ev2('TRANSFER_SENT', 'TRANSFER', (t_s('trf_mod', 'uuid'))::uuid, 902, jsonb_build_object('kind', 'OUT', 'status', 'SENT', 'event_location_uuid', t_get('feria_vieja')#>>'{}',
     'lines', jsonb_build_array(jsonb_build_object('product_uuid', t_get('A')#>>'{}', 'qty_sent', '10.00')))))));
select t_check('F2-SEC03', (select count(*) from stock_transfers where transfer_uuid = (t_s('trf_mod', 'uuid'))::uuid) = 1,
  'Centro puede mandar a otra feria de su empresa');
select t_check('F2-SEC04', t_q('f0000000-0000-0000-0000-00000000000f', 'select count(*) from stock_transfers') = '0'
                  and t_q('f0000000-0000-0000-0000-00000000000f', 'select count(*) from inventory_ledger') = '0'
                  and t_q('f0000000-0000-0000-0000-00000000000f', 'select count(*) from location_stock') = '0'
                  and t_q('ab000000-0000-0000-0000-0000000000ab', format('select count(*) from inventory_ledger where location_id = %L', t_s('feria', 'location_id'))) <> '0',
  'RLS: sin membresía no se ve inventario ni transferencias; el socio de I Do Nut sí');
select t_check('F2-SEC05', t_q('a0000000-0000-0000-0000-00000000000a', 'select mobile_snapshot(''{}'')::text') = 'ERR:42501'
                  and t_q('a0000000-0000-0000-0000-00000000000a', 'select pos_publicar(''{}'')::text') = 'ERR:42501',
  'snapshot, publicación e ingesta solo por el backend');
select t_check('F2-SEC06', t_q('b0000000-0000-0000-0000-00000000000b', format('select estado_dispositivos(%L)::text', t_s('centro', 'company_id'))) = 'ERR:42501',
  'el estado de equipos de I Do Nut no lo ve otra persona');

-- ============================================================== F2-REV revocación con cuarentena
select t_check('F2-REV01', t_q('a0000000-0000-0000-0000-00000000000a', format('select owner_revocar_dispositivo(%L, %L)->>''ok''', t_s('centro', 'company_id'), t_s('t1', 'device_id'))) = 'true',
  'la dueña da de baja la tablet');
select t_set('r_rev', sync_ingest(jsonb_build_object('device_id', t_s('t1', 'device_id'), 'envelope', jsonb_build_object('device_now', now()), 'events', jsonb_build_array(
  t_ev2('SALE_RECORDED', 'SALE', gen_random_uuid(), 50, jsonb_build_object('folio', 'F1-000050', 'business_date', current_date, 'total', '25.00', 'refunded_total', '0'), now() - interval '2 hours'),
  t_ev2('SALE_RECORDED', 'SALE', gen_random_uuid(), 51, jsonb_build_object('folio', 'F1-000051', 'business_date', current_date, 'total', '25.00', 'refunded_total', '0'), now() + interval '1 minute')))));
select t_check('F2-REV02', t_get('r_rev')->'results'->0->>'result' = 'APPLIED' and t_get('r_rev')->'results'->1->>'result' = 'QUARANTINED'
                  and exists (select 1 from reconciliation_items where kind = 'EVENT_QUARANTINED'),
  'lo hecho ANTES de la baja se acepta; lo POSTERIOR queda en cuarentena (no se pierde)');
select t_check('F2-REV03', mobile_snapshot(jsonb_build_object('device_id', t_s('t1', 'device_id')))->>'code' = 'DEVICE_REVOKED'
                  and mobile_inbox(jsonb_build_object('device_id', t_s('t1', 'device_id')))->>'code' = 'DEVICE_REVOKED',
  'la tablet revocada ya no descarga maestros ni hechos');
select t_check('F2-REV04', (company_entitlements((t_s('centro', 'company_id'))::uuid)->>'mobile_pos_used')::int = 0,
  'el cupo se libera al dar de baja');

-- ============================================================== F2-INB dos tablets
update licenses set addons = array_append(coalesce(addons, '{}'), 'MOBILE_POS') where license_key = 'WYBX-IDN-NORT';
select t_set('feria2', pos_create_location(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a', 'company_id', t_s('centro', 'company_id'),
  'nombre', 'Expo Norte', 'tipo', 'EVENT', 'home_location_id', t_s('norte', 'location_id'))));
select t_set('ta', pos_enroll(jsonb_build_object('code', evento_codigo_tablet(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a', 'company_id', t_s('centro', 'company_id'), 'location_id', t_s('feria2', 'location_id')))->>'code',
  'device_uuid', gen_random_uuid(), 'kind', 'MOBILE_POS')));
select t_set('tb', pos_enroll(jsonb_build_object('code', evento_codigo_tablet(jsonb_build_object('user_id', 'a0000000-0000-0000-0000-00000000000a', 'company_id', t_s('centro', 'company_id'), 'location_id', t_s('feria2', 'location_id')))->>'code',
  'device_uuid', gen_random_uuid(), 'kind', 'MOBILE_POS')));
select t_check('F2-INB01', (t_s('ta', 'ok'))::boolean and (t_s('tb', 'ok'))::boolean
                  and (select count(distinct register_id) from devices where id in ((t_s('ta', 'device_id'))::uuid, (t_s('tb', 'device_id'))::uuid)) = 2,
  'dos tablets en el mismo evento, cada una con su caja (F1, F2)');
select sync_ingest(jsonb_build_object('device_id', t_s('ta', 'device_id'), 'events', jsonb_build_array(
  t_ev2('SALE_RECORDED', 'SALE', gen_random_uuid(), 1, jsonb_build_object('folio', 'F1-000001', 'business_date', current_date, 'total', '50.00', 'refunded_total', '0',
     'movements', jsonb_build_array(jsonb_build_object('uuid', gen_random_uuid(), 'product_uuid', t_get('A')#>>'{}', 'type', 'SALE', 'quantity', '2.00')))))));
select t_set('inb', mobile_inbox(jsonb_build_object('device_id', t_s('tb', 'device_id'), 'cursor', 0)));
select t_check('F2-INB02', jsonb_array_length(t_get('inb')->'events') = 1 and (t_get('inb')->'events'->0->>'origin_device') = t_s('ta', 'device_id')
                  and jsonb_array_length(mobile_inbox(jsonb_build_object('device_id', t_s('tb', 'device_id'), 'cursor', (t_get('inb')->>'cursor')::bigint))->'events') = 0
                  and jsonb_array_length(mobile_inbox(jsonb_build_object('device_id', t_s('ta', 'device_id'), 'cursor', 0))->'events') = 0,
  'la tablet B baja la venta de A (y no la suya), por cursor, una vez');

-- ============================================================== F2-CLN clones
select t_set('r_clon', sync_ingest(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'envelope', jsonb_build_object('server_fingerprint', 'FP-OTRO-SERVIDOR'), 'events', '[]'::jsonb)));
select t_check('F2-CLN01', t_s('r_clon', 'code') = 'CLONE_SUSPECTED' and exists (select 1 from reconciliation_items where kind = 'CLONE_SUSPECTED' and status = 'OPEN'),
  'una base de Centro restaurada en OTRO servidor no sincroniza en silencio');
select t_q('a0000000-0000-0000-0000-00000000000a', format('select owner_resolver_clon(%L, %L, ''REBIND'')::text', t_s('centro', 'company_id'), t_s('centro', 'location_id')));
select t_check('F2-CLN02', (sync_ingest(jsonb_build_object('device_id', t_s('centro', 'device_id'), 'envelope', jsonb_build_object('server_fingerprint', 'FP-OTRO-SERVIDOR'), 'events', '[]'::jsonb))->>'ok')::boolean,
  'la dueña confirma "moví el servidor" y vuelve a sincronizar');

-- ============================================================== F2-CON conciliación
select t_set('auto', conciliar_automatico());
select t_check('F2-CON01', (t_get('auto')->'pendientes') ? 'LICENSE_UNLINKED' and (t_get('auto')->'pendientes') ? 'OWNER_APP_UNVERIFIED',
  'la conciliación automática NO adivina: la licencia sin evidencia y la app sin invitación siguen pendientes');
select t_set('cl1', conciliar_licencia(jsonb_build_object('license_id', '40000000-0000-0000-0000-000000000002', 'company_id', '20000000-0000-0000-0000-000000000002', 'actor', 'soporte')));
select t_set('cl2', conciliar_licencia(jsonb_build_object('license_id', '40000000-0000-0000-0000-000000000002', 'company_id', '20000000-0000-0000-0000-000000000002',
                        'actor', 'soporte', 'evidencia', 'Factura PayPal 7X1 a nombre del cliente')));
select t_check('F2-CON02', t_s('cl1', 'code') = 'EVIDENCE_REQUIRED' and (t_s('cl2', 'ok'))::boolean
                  and not exists (select 1 from reconciliation_items where kind = 'LICENSE_UNLINKED' and ref = '40000000-0000-0000-0000-000000000002' and status = 'OPEN'),
  'la conciliación manual exige evidencia y deja rastro');
select t_check('F2-CON03', (conciliar_owner_app(jsonb_build_object('item_id', (select id from reconciliation_items where kind = 'OWNER_APP_UNVERIFIED' limit 1), 'decision', 'DENY', 'actor', 'soporte'))->>'ok')::boolean
                  and not exists (select 1 from company_memberships where user_id = '10000000-0000-0000-0000-00000000000b'),
  'una app sin invitación se rechaza sin dar acceso');

-- ============================================================== F2-OWN resumen con la feria
select t_set('idn2', t_q('a0000000-0000-0000-0000-00000000000a', format('select resumen_empresa(%L)::text', t_s('centro', 'company_id')))::jsonb);
select t_check('F2-OWN01', (select (u->'ventas'->>'neto')::numeric from jsonb_array_elements(t_get('idn2')->'ubicaciones') u where u->>'nombre' = 'Feria León 2026') = 825
                  and (select u->>'ultima_sincronizacion' from jsonb_array_elements(t_get('idn2')->'ubicaciones') u where u->>'nombre' = 'Feria León 2026') is not null
                  and (select u->>'event_status' from jsonb_array_elements(t_get('idn2')->'ubicaciones') u where u->>'nombre' = 'Feria León 2026') = 'RECONCILED',
  'la dueña ve la feria (ventas, estado y cuándo llegó lo último) junto a Centro y Norte');
select t_check('F2-OWN02', (select count(*) from jsonb_array_elements(t_q('a0000000-0000-0000-0000-00000000000a', format('select estado_dispositivos(%L)::text', t_s('centro', 'company_id')))::jsonb) d
                  where d->>'kind' = 'MOBILE_POS') = 3,
  'estado de equipos: las tablets con versión, último contacto y sincronización');

select 'ok|' || id || '|' || msg || coalesce(' · ' || det, '') from t_res where ok and id like 'F2-%' order by n;
select 'FALLA|' || id || '|' || msg || coalesce(' · ' || det, '') from t_res where not ok and id like 'F2-%' order by n;
