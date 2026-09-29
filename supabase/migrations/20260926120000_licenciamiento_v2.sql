-- ============================================================================
--  LICENCIAMIENTO v2: catálogo, giros, suscripción, soporte e historial
-- ----------------------------------------------------------------------------
--  EVOLUCIONA lo que ya existe; no crea una segunda plataforma:
--
--    licenses              la compra de un cliente (clave, MonoCaja/MultiCaja)
--    license_activations   las computadoras autorizadas de esa licencia
--    device_trials         la prueba gratuita de 30 días, una por equipo
--
--  y agrega lo que faltaba para el modelo final:
--
--    license_catalog        QUÉ EXISTE: productos, qué otorgan, precio de lista
--    license_verticals      qué giros tiene cada licencia y su nivel de pantallas
--    license_purchases      QUÉ SE COMPRÓ Y CUÁNTO SE PAGÓ (con descuento)
--    license_subscriptions  los periodos pagados (primer año incluido, mensual,
--                           anual). paid_until = el fin del último periodo pagado
--    license_code_changes   adaptaciones de código y correcciones (soporte)
--    license_events         el historial: nada se reemplaza sin dejar rastro
--
--  RUNTIME vs COMERCIAL. Lo que decide si el POS vende (giros, cajas,
--  pantallas, fechas) se firma en el certificado. Lo comercial (soporte,
--  adaptaciones restantes, precios, descuentos) vive aquí y NUNCA viaja al
--  certificado: el POS no necesita saber cuántos cambios de código le quedan.
--
--  SEGURIDAD. Todas estas tablas: RLS sin políticas y sin privilegios para
--  `anon` ni `authenticated`. Solo el backend (service_role, en las Edge
--  Functions y en /api de la web) lee y escribe. Las funciones de negocio son
--  SECURITY DEFINER y solo `service_role` puede ejecutarlas. La única lectura
--  pública es el catálogo activo (precios de lista, que ya son públicos).
--
--  Idempotente: se puede correr dos veces. Postgres 17 (Supabase).
--
--  DESPLIEGUE EN DOS PASOS (expandir -> contraer). Esta es la PARTE A:
--  solo AGREGA. Todo lo que ya está en producción sigue funcionando igual
--  contra esta base: la web anterior (que guarda MultiCaja como 9999), la
--  Edge Function license-check anterior (que lee `max_registers ?? 1`, con 0
--  = ilimitado), los POS instalados y el panel de administración. La PARTE B
--  (20260927120000_licenciamiento_v2_final.sql) retira el contrato anterior
--  de `max_registers` y se aplica SOLO después de desplegar y verificar las
--  funciones y la web nuevas. Orden completo: docs/licenciamiento-despliegue.md.
-- ============================================================================

-- ---------------------------------------------------------------- licencias
-- `plan` sigue siendo la EDICIÓN (mono | multi): no se renombra solo por
-- traducir.
--
-- CAJAS. El número de cajas lo decide la EDICIÓN: MonoCaja = 1, MultiCaja =
-- ilimitadas (license_registers_max). `max_registers` queda como estaba
-- durante la transición -contrato anterior: 1, o 0/9999 para MultiCaja- porque
-- la web y el license-check anteriores lo escriben y lo leen así. La PARTE B
-- lo normaliza (MultiCaja = NULL) y le pone restricciones.
alter table public.licenses
  add column if not exists first_activated_at    timestamptz,
  add column if not exists included_until        timestamptz,
  add column if not exists support_tier          text not null default 'BASIC',
  add column if not exists included_code_changes int  not null default 3,
  add column if not exists addons                text[] not null default '{}',
  -- Qué ES el registro. NULL = sin clasificar (lo anterior a esta migración):
  -- nadie lo adivina.
  --   PRODUCTION  venta real a un cliente (PayPal live). Lo ÚNICO que cuenta
  --               en métricas comerciales (license_commercial_*).
  --   INTERNAL    uso interno de Wybix (demos, la cuenta del dueño).
  --   QA          equipos de pruebas que se siguen usando; pueden recibir
  --               permisos explícitos (license_qa_grant).
  --   TEST        pruebas y sandbox; candidatas a cancelar.
  add column if not exists origin                text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'licenses_support_tier_check') then
    alter table public.licenses add constraint licenses_support_tier_check
      check (support_tier in ('NONE', 'BASIC', 'PRIORITY'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'licenses_addons_check') then
    -- Complementos que se suman a la licencia base (MultiSucursal, en el futuro).
    alter table public.licenses add constraint licenses_addons_check
      check (addons <@ array['MULTIBRANCH']::text[]);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'licenses_origin_check') then
    alter table public.licenses add constraint licenses_origin_check
      check (origin is null or origin in ('PRODUCTION', 'INTERNAL', 'QA', 'TEST'));
  end if;
end $$;
-- Por si la PARTE A ya se aplicó con la lista anterior (sin QA).
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'licenses_origin_check'
              and pg_get_constraintdef(oid) not like '%QA%') then
    alter table public.licenses drop constraint licenses_origin_check;
    alter table public.licenses add constraint licenses_origin_check
      check (origin is null or origin in ('PRODUCTION', 'INTERNAL', 'QA', 'TEST'));
  end if;
end $$;

-- ---------------------------------------------------------------- catálogo
-- LA ÚNICA FUENTE DE VERDAD COMERCIAL. Código de producto, edición, giro,
-- periodo de cobro, precio de lista, activo/inactivo y entitlements viven
-- AQUÍ y en ningún otro lugar:
--   - license_quote() calcula el importe de un pedido desde esta tabla: es la
--     única validación de cobro (la web la llama desde su servidor);
--   - la web GENERA su copia de lectura al compilar (scripts/catalogo.mjs en
--     wybix-landing) y el asistente la lee en vivo: ninguno escribe precios;
--   - license_runtime() resuelve los entitlements del certificado desde aquí.
-- Un precio cambia con una MIGRACIÓN que actualiza esta tabla. Nunca a mano.
create table if not exists public.license_catalog (
  code            text primary key,
  kind            text not null,
  label           text not null,                 -- lo que ve el cliente; puede cambiar
  description     text,
  edition         text,                          -- mono | multi (solo EDITION)
  vertical        text,                          -- COMMERCE | HOSPITALITY | SERVICES (solo VERTICAL)
  grants          jsonb not null default '{}',   -- qué otorga (entitlements, límites)
  list_price      numeric(12, 2),                -- NULL = precio por definir: NO se puede cobrar
  reference_price numeric(12, 2),                -- precio de referencia (tachado) si lo hay
  currency        text not null default 'MXN',
  billing         text check (billing in ('ONE_TIME', 'MONTHLY', 'ANNUAL')),
  active          boolean not null default true,
  sort            int not null default 0,
  notes           text,
  updated_at      timestamptz not null default now()
);
alter table public.license_catalog
  add column if not exists edition         text,
  add column if not exists vertical        text,
  add column if not exists reference_price numeric(12, 2);

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'license_catalog_kind_check') then
    alter table public.license_catalog drop constraint license_catalog_kind_check;
  end if;
  -- EXTRA: lo que se vende junto con la licencia y se entrega aparte (timbres,
  -- app adicional, capacitación). TAX: la tasa de impuesto que se cobra.
  alter table public.license_catalog add constraint license_catalog_kind_check
    check (kind in ('EDITION', 'VERTICAL', 'SCREENS', 'SUBSCRIPTION', 'SUPPORT', 'ADDON', 'EXTRA', 'TAX'));
  if not exists (select 1 from pg_constraint where conname = 'license_catalog_edition_check') then
    alter table public.license_catalog add constraint license_catalog_edition_check
      check ((kind = 'EDITION') = (edition is not null) and (edition is null or edition in ('mono', 'multi')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'license_catalog_vertical_check') then
    alter table public.license_catalog add constraint license_catalog_vertical_check
      check ((kind = 'VERTICAL') = (vertical is not null) and (vertical is null or vertical in ('COMMERCE', 'HOSPITALITY', 'SERVICES')));
  end if;
end $$;

-- Los códigos son estables; las etiquetas pueden cambiar sin romper licencias.
-- Precios: SOLO los que la web ya cobraba al escribir esta migración (MonoCaja
-- $2,499, MultiCaja $3,999, soporte prioritario $690 con referencia $890, app
-- adicional, paquetes de timbres y capacitación). Todo lo nuevo -giro
-- adicional, ampliación de pantallas, suscripción mensual y anual- queda en
-- NULL a propósito: todavía no se define y no se puede cobrar.
insert into public.license_catalog (code, kind, label, description, edition, vertical, grants, list_price, reference_price, billing, sort, notes) values
  ('EDITION_MONO',  'EDITION', 'MonoCaja',  '1 caja que vende y cobra.', 'mono', null,
     '{"registers_max":1,"entitlements":["sales","customers","reports","invoicing","loyalty","inventory","purchases","suppliers","cloud_sync","backup"]}', 2499, null, 'ONE_TIME', 10,
     'Compra inicial: incluye un giro y el primer año desde la activación.'),
  ('EDITION_MULTI', 'EDITION', 'MultiCaja', 'Cajas ilimitadas en el mismo negocio, sin costo por caja.', 'multi', null,
     '{"registers_max":null,"entitlements":["sales","customers","reports","invoicing","loyalty","inventory","purchases","suppliers","cloud_sync","backup"]}', 3999, null, 'ONE_TIME', 20,
     'Compra inicial: incluye un giro y el primer año desde la activación.'),
  ('VERTICAL_COMMERCE',    'VERTICAL', 'Para Comercios', 'Ventas, productos, inventario, compras, clientes, proveedores, cajas y reportes.', null, 'COMMERCE',
     '{"entitlements":["commerce","operational_surfaces","operational.inventory_floor"]}', null, null, 'ONE_TIME', 30, 'El primer giro va incluido en la edición. Precio de un giro ADICIONAL por definir.'),
  ('VERTICAL_HOSPITALITY', 'VERTICAL', 'Para Restaurantes y Cafeterías', 'Mesas, cuentas, comandas, preparación y cocina, recetas, modificadores y pedidos.', null, 'HOSPITALITY',
     '{"entitlements":["hospitality","hospitality.tables","hospitality.kds","operational_surfaces","operational.preparation","operational.waiter","operational.customer_status","operational.inventory_floor"]}', null, null, 'ONE_TIME', 31, 'El primer giro va incluido en la edición. Precio de un giro ADICIONAL por definir.'),
  ('VERTICAL_SERVICES',    'VERTICAL', 'Para Negocios de Servicios', 'Agenda, citas, profesionales, órdenes de servicio, técnicos y activos.', null, 'SERVICES',
     '{"entitlements":["services","services.agenda","services.orders","operational_surfaces","operational.staff_day","operational.technician","operational.inventory_floor"]}', null, null, 'ONE_TIME', 32, 'Un solo precio para todos los giros de servicios. Precio de un giro ADICIONAL por definir.'),
  ('SCREENS_BASE',      'SCREENS', 'Pantallas Operativas: hasta 3 por giro',  null, null, null, '{"screens_per_vertical":3}',    0,    null, null, 40, 'Incluido en cada giro.'),
  ('SCREENS_EXTENDED',  'SCREENS', 'Pantallas Operativas: hasta 10 por giro', null, null, null, '{"screens_per_vertical":10}',   null, null, null, 41, 'Precio y modalidad por definir.'),
  ('SCREENS_UNLIMITED', 'SCREENS', 'Pantallas Operativas ilimitadas por giro', null, null, null, '{"screens_per_vertical":null}', null, null, null, 42, 'Precio y modalidad por definir.'),
  ('SUBSCRIPTION_MONTHLY', 'SUBSCRIPTION', 'Suscripción mensual', 'Mantiene todas las funciones contratadas.', null, null, '{"months":1}',  null, null, 'MONTHLY', 50, 'Precio por definir.'),
  ('SUBSCRIPTION_ANNUAL',  'SUBSCRIPTION', 'Suscripción anual',   'Las mismas funciones que la mensual, con mejor precio.', null, null, '{"months":12}', null, null, 'ANNUAL', 51, 'Precio por definir.'),
  ('SUPPORT_BASIC',    'SUPPORT', 'Soporte básico',     'Incluido el primer año desde la activación.', null, null, '{"support_tier":"BASIC"}', null, null, 'ANNUAL', 60, 'No se vende por separado.'),
  ('SUPPORT_PRIORITY', 'SUPPORT', 'Soporte prioritario · 1er año',
     'Respuesta en 2 h hábiles, WhatsApp directo, horario extendido (incluye sábado) y asistencia remota. Precio de lanzamiento; renovación $890/año.',
     null, null, '{"support_tier":"PRIORITY"}', 690, 890, 'ANNUAL', 61, 'Precios vigentes en la web.'),
  ('ADDON_MULTIBRANCH', 'ADDON', 'MultiSucursal', 'Varias sucursales. Complemento futuro.', null, null, '{"addon":"MULTIBRANCH","entitlements":["multibranch"]}', null, null, null, 70, 'No disponible todavía.'),
  ('EXTRA_APP_MOBILE', 'EXTRA', 'App móvil adicional', 'Monitorea tu negocio desde otro teléfono. La primera app ya viene incluida.', null, null, '{}', 600,  null, 'ONE_TIME', 80, 'Precio vigente en la web.'),
  ('EXTRA_CFDI_100',   'EXTRA', '100 timbres CFDI',   'Para emitir facturas. No caducan. Se consumen al facturar.', null, null, '{"cfdi_stamps":100}',  250,  null, 'ONE_TIME', 81, 'Precio vigente en la web.'),
  ('EXTRA_CFDI_500',   'EXTRA', '500 timbres CFDI',   'Para emitir facturas. No caducan. Se consumen al facturar.', null, null, '{"cfdi_stamps":500}',  890,  null, 'ONE_TIME', 82, 'Precio vigente en la web.'),
  ('EXTRA_CFDI_1000',  'EXTRA', '1,000 timbres CFDI', 'Para emitir facturas. No caducan. Se consumen al facturar.', null, null, '{"cfdi_stamps":1000}', 1490, null, 'ONE_TIME', 83, 'Precio vigente en la web.'),
  ('EXTRA_CFDI_3000',  'EXTRA', '3,000 timbres CFDI', 'Para emitir facturas. No caducan. Ideal si facturas mucho.', null, null, '{"cfdi_stamps":3000}', 3990, null, 'ONE_TIME', 84, 'Precio vigente en la web.'),
  ('EXTRA_CFDI_5000',  'EXTRA', '5,000 timbres CFDI', 'Para emitir facturas. No caducan. El mejor precio por timbre.', null, null, '{"cfdi_stamps":5000}', 5900, null, 'ONE_TIME', 85, 'Precio vigente en la web.'),
  ('EXTRA_ONBOARDING', 'EXTRA', 'Capacitación y migración de datos', 'Te ayudamos a cargar productos, clientes y proveedores desde Excel.', null, null, '{}', 300, null, 'ONE_TIME', 86, 'Precio vigente en la web.'),
  ('TAX_IVA_MX', 'TAX', 'IVA', 'Impuesto al valor agregado. Los precios de lista son sin IVA.', null, null, '{"rate":0.16}', null, null, null, 99, 'La tasa que cobra license_quote.')
on conflict (code) do nothing;

-- ---------------------------------------------------------------- giros
create table if not exists public.license_verticals (
  license_id   uuid not null references public.licenses(id) on delete cascade,
  vertical     text not null check (vertical in ('COMMERCE', 'HOSPITALITY', 'SERVICES')),
  screen_tier  text not null default 'BASE' check (screen_tier in ('BASE', 'EXTENDED', 'UNLIMITED')),
  added_at     timestamptz not null default now(),
  source       text,                          -- INITIAL | UPGRADE | ADMIN
  primary key (license_id, vertical)
);

-- Las licencias anteriores a este modelo NO reciben giros automáticamente.
-- Auditadas el 2026-09-26: los 7 registros de producción son pruebas o uso
-- interno, no clientes. Quedan sin giro (su certificado solo trae lo de la
-- edición: vender, cobrar, clientes, reportes) y aparecen en
-- `license_review_queue` hasta que alguien decida qué son. La decisión se
-- aplica con un script revisado (supabase/data/), no aquí.

-- ---------------------------------------------------------------- compras
create table if not exists public.license_purchases (
  id               uuid primary key default gen_random_uuid(),
  license_id       uuid not null references public.licenses(id) on delete cascade,
  kind             text not null check (kind in ('INITIAL', 'UPGRADE_EDITION', 'ADD_VERTICAL', 'SCREENS',
                                                 'SUBSCRIPTION', 'SUPPORT', 'ADDON', 'EXTRA', 'LEGACY')),
  catalog_code     text references public.license_catalog(code),
  list_price       numeric(12, 2),
  discount_pct     numeric(5, 2) check (discount_pct is null or (discount_pct >= 0 and discount_pct <= 100)),
  discount_amount  numeric(12, 2) check (discount_amount is null or discount_amount >= 0),
  discount_code    text,
  discount_reason  text,
  price_paid       numeric(12, 2),
  currency         text not null default 'MXN',
  payment_provider text,                      -- PAYPAL | MANUAL | ...
  payment_ref      text,
  detail           jsonb not null default '{}',
  created_by       text,
  created_at       timestamptz not null default now()
);
-- Un pago cubre varias líneas (edición + timbres + soporte): es único por
-- pago Y producto, para que el mismo pago no se registre dos veces.
create unique index if not exists ux_license_purchases_payment_line
  on public.license_purchases (payment_provider, payment_ref, coalesce(catalog_code, '')) where payment_ref is not null;
create index if not exists ix_license_purchases_license on public.license_purchases (license_id, created_at);

-- La compra original de las licencias existentes queda como historial.
insert into public.license_purchases (license_id, kind, catalog_code, list_price, price_paid, payment_provider, payment_ref, detail, created_by, created_at)
select l.id, 'LEGACY', case when l.plan = 'multi' then 'EDITION_MULTI' else 'EDITION_MONO' end,
       null, null, case when l.paypal_order_id is not null then 'PAYPAL' else null end, l.paypal_order_id,
       jsonb_build_object('plan', l.plan, 'nota', 'Compra anterior al licenciamiento v2'), 'migracion', coalesce(l.sold_at, l.created_at)
  from public.licenses l
 where not exists (select 1 from public.license_purchases p where p.license_id = l.id);

-- ---------------------------------------------------------------- suscripción
create table if not exists public.license_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  license_id    uuid not null references public.licenses(id) on delete cascade,
  kind          text not null check (kind in ('INCLUDED', 'MONTHLY', 'ANNUAL', 'MANUAL')),
  period_start  timestamptz not null,
  period_end    timestamptz not null check (period_end > period_start),
  status        text not null default 'PAID' check (status in ('PAID', 'CANCELLED')),
  purchase_id   uuid references public.license_purchases(id),
  created_by    text,
  created_at    timestamptz not null default now()
);
create index if not exists ix_license_subscriptions_license on public.license_subscriptions (license_id, period_end);
-- Un solo primer año incluido por licencia: la activación no puede duplicarlo.
create unique index if not exists ux_license_subscriptions_included
  on public.license_subscriptions (license_id) where kind = 'INCLUDED';

-- Las licencias ya activadas antes de este modelo: su primer año corre desde
-- su primera activación registrada, y su soporte (que ya estaba en
-- support_until) se conserva.
update public.licenses l
   set first_activated_at = a.primera,
       included_until = a.primera + interval '12 months'
  from (select license_id, min(first_seen_at) primera from public.license_activations group by license_id) a
 where a.license_id = l.id and l.first_activated_at is null;

insert into public.license_subscriptions (license_id, kind, period_start, period_end, created_by)
select l.id, 'INCLUDED', l.first_activated_at, l.included_until, 'migracion'
  from public.licenses l
 where l.first_activated_at is not null
on conflict do nothing;

-- ---------------------------------------------------------------- soporte
create table if not exists public.license_code_changes (
  id            uuid primary key default gen_random_uuid(),
  license_id    uuid not null references public.licenses(id) on delete cascade,
  -- CUSTOMIZATION  adaptación de código a la medida: consume de las incluidas.
  -- BUG_FIX        un error de Wybix: se corrige y NUNCA consume adaptaciones.
  -- IMPLEMENTATION puesta en marcha (cargar catálogo, configurar equipos): no
  --                consume. Si una implementación exige cambiar código a la
  --                medida, ESE cambio se registra aparte como CUSTOMIZATION.
  kind          text not null check (kind in ('CUSTOMIZATION', 'BUG_FIX', 'IMPLEMENTATION')),
  title         text not null,
  description   text,
  status        text not null default 'REGISTRADO' check (status in ('REGISTRADO', 'EN_PROCESO', 'ENTREGADO', 'CANCELADO')),
  registered_by text,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz
);
create index if not exists ix_license_code_changes_license on public.license_code_changes (license_id);

-- ---------------------------------------------------------------- historial
create table if not exists public.license_events (
  id          bigint generated always as identity primary key,
  license_id  uuid references public.licenses(id) on delete cascade,
  type        text not null,
  data        jsonb not null default '{}',
  actor       text,
  created_at  timestamptz not null default now()
);
create index if not exists ix_license_events_license on public.license_events (license_id, created_at);

-- ---------------------------------------------------------------- auditoría de activaciones
alter table public.license_activations
  add column if not exists released_at timestamptz,
  add column if not exists released_by text;

-- ---------------------------------------------------------------- prueba gratuita
-- La prueba es de UN giro, el que el negocio elige en su alta. Hasta elegirlo
-- solo trae lo de la edición. Nunca los tres a la vez.
alter table public.device_trials
  add column if not exists vertical             text,
  add column if not exists vertical_selected_at timestamptz,
  add column if not exists vertical_changes     int not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'device_trials_vertical_check') then
    alter table public.device_trials add constraint device_trials_vertical_check
      check (vertical is null or vertical in ('COMMERCE', 'HOSPITALITY', 'SERVICES'));
  end if;
end $$;

-- ============================================================================
--  FUNCIONES
-- ============================================================================

create or replace function public.license_log(p_license uuid, p_type text, p_data jsonb default '{}', p_actor text default null)
returns void language sql security definer set search_path = public as $$
  insert into public.license_events (license_id, type, data, actor) values (p_license, p_type, coalesce(p_data, '{}'), p_actor);
$$;

-- Cajas que permite una edición (lo canónico): MonoCaja 1, MultiCaja sin límite.
create or replace function public.license_registers_max(p_plan text)
returns int language sql immutable set search_path = public as $$
  select case when p_plan = 'mono' then 1 else null end;
$$;

-- Lo que se ESCRIBE en `max_registers` al crear o cambiar una licencia. En la
-- transición (PARTE A) es el contrato anterior -MultiCaja = 0, que el
-- license-check anterior entiende como ilimitado-; la PARTE B lo redefine a
-- NULL. Así ninguna función se reescribe dos veces.
create or replace function public.license_legacy_max_registers(p_plan text)
returns int language sql immutable set search_path = public as $$
  select case when p_plan = 'mono' then 1 else 0 end;
$$;

-- paid_until: el fin del último periodo pagado (incluido el primer año).
create or replace function public.license_paid_until(p_license uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select max(period_end) from public.license_subscriptions where license_id = p_license and status = 'PAID';
$$;

-- Lo que el certificado necesita saber de una licencia. SOLO runtime: sin
-- soporte, sin adaptaciones, sin precios.
create or replace function public.license_runtime(p_license uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'license_id', l.id,
    'customer', l.customer_name,
    'edition', l.plan,
    'registers_max', public.license_registers_max(l.plan),
    'status', l.status,
    'verticals', coalesce((select jsonb_agg(jsonb_build_object('vertical', v.vertical, 'screen_tier', v.screen_tier) order by v.vertical)
                             from public.license_verticals v where v.license_id = l.id), '[]'::jsonb),
    'addons', to_jsonb(l.addons),
    -- Solo informativo en el POS («licencia de pruebas»); no otorga nada.
    'origin', l.origin,
    -- Lo que la licencia otorga sale del CATÁLOGO: edición + giros + complementos.
    'entitlements', coalesce((select jsonb_agg(distinct e order by e) from (
        select jsonb_array_elements_text(c.grants->'entitlements') e
          from public.license_catalog c
         where c.code = case when l.plan = 'multi' then 'EDITION_MULTI' else 'EDITION_MONO' end
            or c.code in (select 'VERTICAL_' || v.vertical from public.license_verticals v where v.license_id = l.id)
            or c.code in (select 'ADDON_' || a from unnest(l.addons) a)) x), '[]'::jsonb),
    -- Pantallas Operativas POR GIRO; null = ilimitadas.
    'screens', coalesce((select jsonb_object_agg(v.vertical, c.grants->'screens_per_vertical')
                           from public.license_verticals v
                           join public.license_catalog c on c.code = 'SCREENS_' || v.screen_tier
                          where v.license_id = l.id), '{}'::jsonb),
    'first_activated_at', l.first_activated_at,
    'paid_until', public.license_paid_until(l.id)
  )
  from public.licenses l where l.id = p_license;
$$;

/*
 * ACTIVAR una computadora. ATÓMICA e IDEMPOTENTE:
 *   - la licencia se bloquea (FOR UPDATE): dos activaciones simultáneas se
 *     serializan y no pueden rebasar el límite de cajas;
 *   - la misma computadora otra vez = la misma activación (no suma);
 *   - la PRIMERA activación fija first_activated_at y crea el primer año
 *     incluido (12 meses calendario). El índice único impide un segundo
 *     periodo incluido aunque algo se repita.
 * Cambiar de computadora es liberar y activar: sin límite de veces. Lo que se
 * impide es el uso SIMULTÁNEO por encima de lo contratado.
 */
create or replace function public.license_activate(p_license_key text, p_machine_id text, p_alias text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  l public.licenses%rowtype;
  a public.license_activations%rowtype;
  v_activas int;
  v_limite int;
  v_ahora timestamptz := now();
  v_primera boolean := false;
  v_existe boolean;
begin
  if coalesce(trim(p_machine_id), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Falta el identificador del equipo.');
  end if;

  select * into l from public.licenses where license_key = upper(trim(p_license_key)) for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Licencia no encontrada.');
  end if;
  if l.status <> 'activa' then
    return jsonb_build_object('ok', false, 'code', 'SUSPENDED', 'error', 'Esta licencia está suspendida. Contacta a soporte.');
  end if;

  select * into a from public.license_activations where license_id = l.id and machine_id = p_machine_id;
  -- FOUND se guarda YA: la siguiente consulta (el conteo) lo sobrescribe.
  v_existe := found;

  if not v_existe or not a.active then
    select count(*) into v_activas from public.license_activations where license_id = l.id and active;
    -- El límite lo da la EDICIÓN, no `max_registers` (contrato anterior).
    v_limite := public.license_registers_max(l.plan);
    if v_limite is not null and v_activas >= v_limite then
      return jsonb_build_object('ok', false, 'code', 'LIMIT_REACHED',
        'error', 'Tu licencia MonoCaja ya está activa en otra computadora. Libérala desde esa computadora o desde tu cuenta, o cambia a MultiCaja.');
    end if;
    if not v_existe then
      insert into public.license_activations (license_id, machine_id, machine_alias)
      values (l.id, p_machine_id, p_alias) returning * into a;
    else
      update public.license_activations
         set active = true, last_seen_at = v_ahora, released_at = null, released_by = null,
             machine_alias = coalesce(p_alias, machine_alias)
       where id = a.id returning * into a;
    end if;
    perform public.license_log(l.id, 'DEVICE_BOUND', jsonb_build_object('machine_id', p_machine_id, 'alias', p_alias));
  else
    update public.license_activations set last_seen_at = v_ahora where id = a.id;
  end if;

  if l.first_activated_at is null then
    v_primera := true;
    update public.licenses
       set first_activated_at = v_ahora,
           included_until = v_ahora + interval '12 months',
           -- El soporte básico del primer año también corre desde la activación.
           support_until = (v_ahora + interval '12 months')::date
     where id = l.id;
    insert into public.license_subscriptions (license_id, kind, period_start, period_end, created_by)
    values (l.id, 'INCLUDED', v_ahora, v_ahora + interval '12 months', 'activacion')
    on conflict do nothing;
    perform public.license_log(l.id, 'ACTIVATED', jsonb_build_object('machine_id', p_machine_id, 'first_activated_at', v_ahora));
  end if;

  return jsonb_build_object('ok', true, 'first', v_primera, 'activation_id', a.id, 'runtime', public.license_runtime(l.id));
end $$;

/* LIBERAR una computadora (cambio de PC). Queda auditado. */
create or replace function public.license_release(p_license_id uuid, p_machine_id text, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update public.license_activations
     set active = false, released_at = now(), released_by = p_actor
   where license_id = p_license_id and machine_id = p_machine_id and active;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.license_log(p_license_id, 'DEVICE_UNBOUND', jsonb_build_object('machine_id', p_machine_id), p_actor);
  end if;
  return jsonb_build_object('ok', true, 'released', v_n > 0);
end $$;

/* La activación vigente de una computadora (validar / refrescar el certificado). */
create or replace function public.license_for_machine(p_machine_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a public.license_activations%rowtype;
  l public.licenses%rowtype;
begin
  select * into a from public.license_activations where machine_id = p_machine_id and active order by last_seen_at desc limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_ACTIVATED', 'error', 'Esta computadora no está activada.');
  end if;
  select * into l from public.licenses where id = a.license_id;
  if l.status <> 'activa' then
    return jsonb_build_object('ok', false, 'code', 'SUSPENDED', 'error', 'Esta licencia está suspendida. Contacta a soporte.');
  end if;
  update public.license_activations set last_seen_at = now() where id = a.id;
  return jsonb_build_object('ok', true, 'runtime', public.license_runtime(l.id));
end $$;

-- ---------------------------------------------------------------- upgrades
-- Todas las operaciones comerciales dejan historial y, cuando hay dinero de
-- por medio, una fila en license_purchases con precio de lista, descuento y
-- precio pagado. Un descuento NO cambia el plan ni lo que otorga.

create or replace function public.license_record_purchase(
  p_license uuid, p_kind text, p_catalog text, p_list numeric, p_discount_pct numeric, p_discount_amount numeric,
  p_discount_code text, p_discount_reason text, p_paid numeric, p_provider text, p_ref text, p_detail jsonb, p_actor text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.license_purchases (license_id, kind, catalog_code, list_price, discount_pct, discount_amount,
                                        discount_code, discount_reason, price_paid, payment_provider, payment_ref, detail, created_by)
  values (p_license, p_kind, p_catalog, p_list, p_discount_pct, p_discount_amount, p_discount_code, p_discount_reason,
          p_paid, p_provider, p_ref, coalesce(p_detail, '{}'), p_actor)
  returning id into v_id;
  if coalesce(p_discount_pct, 0) > 0 or coalesce(p_discount_amount, 0) > 0 then
    perform public.license_log(p_license, 'DISCOUNT_APPLIED', jsonb_build_object(
      'purchase_id', v_id, 'list_price', p_list, 'discount_pct', p_discount_pct, 'discount_amount', p_discount_amount,
      'discount_code', p_discount_code, 'reason', p_discount_reason, 'price_paid', p_paid), p_actor);
  end if;
  return v_id;
end $$;

/* MonoCaja -> MultiCaja: la misma licencia, sin reinstalar ni perder historial. */
create or replace function public.license_upgrade_to_multi(p_license uuid, p_purchase jsonb default '{}', p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.licenses%rowtype; v_p uuid;
begin
  select * into l from public.licenses where id = p_license for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if l.plan = 'multi' then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  update public.licenses set plan = 'multi', max_registers = public.license_legacy_max_registers('multi') where id = p_license;
  v_p := public.license_record_purchase(p_license, 'UPGRADE_EDITION', 'EDITION_MULTI',
    (p_purchase->>'list_price')::numeric, (p_purchase->>'discount_pct')::numeric, (p_purchase->>'discount_amount')::numeric,
    p_purchase->>'discount_code', p_purchase->>'discount_reason', (p_purchase->>'price_paid')::numeric,
    p_purchase->>'provider', p_purchase->>'ref', jsonb_build_object('from', 'mono', 'to', 'multi'), p_actor);
  perform public.license_log(p_license, 'MONO_TO_MULTI', jsonb_build_object('purchase_id', v_p), p_actor);
  return jsonb_build_object('ok', true, 'purchase_id', v_p);
end $$;

/* Agregar un giro (licencia híbrida). Paga la diferencia; no crea otra licencia. */
create or replace function public.license_add_vertical(p_license uuid, p_vertical text, p_purchase jsonb default '{}', p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_p uuid;
begin
  if p_vertical not in ('COMMERCE', 'HOSPITALITY', 'SERVICES') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Giro desconocido.');
  end if;
  perform 1 from public.licenses where id = p_license for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if exists (select 1 from public.license_verticals where license_id = p_license and vertical = p_vertical) then
    return jsonb_build_object('ok', true, 'unchanged', true);
  end if;
  insert into public.license_verticals (license_id, vertical, source) values (p_license, p_vertical, 'UPGRADE');
  v_p := public.license_record_purchase(p_license, 'ADD_VERTICAL', 'VERTICAL_' || p_vertical,
    (p_purchase->>'list_price')::numeric, (p_purchase->>'discount_pct')::numeric, (p_purchase->>'discount_amount')::numeric,
    p_purchase->>'discount_code', p_purchase->>'discount_reason', (p_purchase->>'price_paid')::numeric,
    p_purchase->>'provider', p_purchase->>'ref', jsonb_build_object('vertical', p_vertical), p_actor);
  perform public.license_log(p_license, 'VERTICAL_ADDED', jsonb_build_object('vertical', p_vertical, 'purchase_id', v_p), p_actor);
  return jsonb_build_object('ok', true, 'purchase_id', v_p);
end $$;

/* Quitar un giro (corrección administrativa de una licencia LEGACY, p. ej.). */
create or replace function public.license_remove_vertical(p_license uuid, p_vertical text, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if (select count(*) from public.license_verticals where license_id = p_license) <= 1 then
    return jsonb_build_object('ok', false, 'code', 'LAST_VERTICAL', 'error', 'Una licencia necesita al menos un giro.');
  end if;
  delete from public.license_verticals where license_id = p_license and vertical = p_vertical;
  get diagnostics v_n = row_count;
  if v_n > 0 then perform public.license_log(p_license, 'VERTICAL_REMOVED', jsonb_build_object('vertical', p_vertical), p_actor); end if;
  return jsonb_build_object('ok', true, 'removed', v_n > 0);
end $$;

/* Ampliación de Pantallas Operativas de UN giro: BASE (3), EXTENDED (10), UNLIMITED. */
create or replace function public.license_set_screen_tier(p_license uuid, p_vertical text, p_tier text, p_purchase jsonb default '{}', p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_antes text; v_p uuid;
begin
  if p_tier not in ('BASE', 'EXTENDED', 'UNLIMITED') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Nivel de pantallas desconocido.');
  end if;
  select screen_tier into v_antes from public.license_verticals where license_id = p_license and vertical = p_vertical for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NO_VERTICAL', 'error', 'La licencia no tiene ese giro.'); end if;
  if v_antes = p_tier then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  update public.license_verticals set screen_tier = p_tier where license_id = p_license and vertical = p_vertical;
  v_p := public.license_record_purchase(p_license, 'SCREENS', 'SCREENS_' || p_tier,
    (p_purchase->>'list_price')::numeric, (p_purchase->>'discount_pct')::numeric, (p_purchase->>'discount_amount')::numeric,
    p_purchase->>'discount_code', p_purchase->>'discount_reason', (p_purchase->>'price_paid')::numeric,
    p_purchase->>'provider', p_purchase->>'ref', jsonb_build_object('vertical', p_vertical, 'from', v_antes, 'to', p_tier), p_actor);
  perform public.license_log(p_license, 'SCREEN_QUOTA_CHANGED', jsonb_build_object('vertical', p_vertical, 'from', v_antes, 'to', p_tier), p_actor);
  return jsonb_build_object('ok', true, 'purchase_id', v_p);
end $$;

/*
 * RENOVAR: un periodo mensual o anual. Si la suscripción sigue vigente, el
 * periodo nuevo empieza al terminar el actual; si ya venció (gracia o Venta
 * Esencial), empieza hoy: no se cobra el tiempo que no se tuvo.
 * Mensual y anual otorgan EXACTAMENTE lo mismo: solo cambia la duración.
 */
create or replace function public.license_renew(p_license uuid, p_kind text, p_purchase jsonb default '{}', p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_inicio timestamptz; v_fin timestamptz; v_p uuid; v_hasta timestamptz;
begin
  if p_kind not in ('MONTHLY', 'ANNUAL', 'MANUAL') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Periodo desconocido.');
  end if;
  perform 1 from public.licenses where id = p_license for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  -- Idempotente por pago: el mismo pago no renueva dos veces.
  if p_purchase ? 'ref' and exists (select 1 from public.license_purchases
       where payment_ref = p_purchase->>'ref' and payment_provider is not distinct from p_purchase->>'provider') then
    return jsonb_build_object('ok', true, 'unchanged', true, 'paid_until', public.license_paid_until(p_license));
  end if;
  v_hasta := public.license_paid_until(p_license);
  v_inicio := greatest(coalesce(v_hasta, now()), now());
  v_fin := v_inicio + case p_kind when 'MONTHLY' then interval '1 month'
                                  when 'ANNUAL' then interval '12 months'
                                  else make_interval(days => coalesce((p_purchase->>'days')::int, 30)) end;
  v_p := public.license_record_purchase(p_license, 'SUBSCRIPTION',
    case p_kind when 'MONTHLY' then 'SUBSCRIPTION_MONTHLY' when 'ANNUAL' then 'SUBSCRIPTION_ANNUAL' else null end,
    (p_purchase->>'list_price')::numeric, (p_purchase->>'discount_pct')::numeric, (p_purchase->>'discount_amount')::numeric,
    p_purchase->>'discount_code', p_purchase->>'discount_reason', (p_purchase->>'price_paid')::numeric,
    p_purchase->>'provider', p_purchase->>'ref', jsonb_build_object('kind', p_kind), p_actor);
  insert into public.license_subscriptions (license_id, kind, period_start, period_end, purchase_id, created_by)
  values (p_license, p_kind, v_inicio, v_fin, v_p, p_actor);
  perform public.license_log(p_license, 'SUBSCRIPTION_RENEWED',
    jsonb_build_object('kind', p_kind, 'from', v_inicio, 'to', v_fin, 'purchase_id', v_p), p_actor);
  return jsonb_build_object('ok', true, 'paid_until', v_fin, 'purchase_id', v_p);
end $$;

/* Registrar una adaptación de código, una corrección o una implementación. */
create or replace function public.license_register_code_change(p_license uuid, p_kind text, p_title text, p_description text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_kind not in ('CUSTOMIZATION', 'BUG_FIX', 'IMPLEMENTATION') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Tipo de cambio desconocido.');
  end if;
  insert into public.license_code_changes (license_id, kind, title, description, registered_by)
  values (p_license, p_kind, p_title, p_description, p_actor) returning id into v_id;
  perform public.license_log(p_license, p_kind || '_REGISTERED', jsonb_build_object('id', v_id, 'title', p_title), p_actor);
  return jsonb_build_object('ok', true, 'id', v_id, 'counts_as_customization', p_kind = 'CUSTOMIZATION');
end $$;

-- ============================================================================
--  COBRO: el importe de un pedido sale del catálogo, en el servidor
-- ============================================================================
/*
 * COTIZAR un pedido desde license_catalog. La ÚNICA validación de cobro: la
 * web la llama desde su servidor antes de emitir nada, y license_create_from_order
 * la vuelve a llamar. El navegador no decide precios.
 *
 *   p_order = { "edition": "EDITION_MONO", "vertical": "COMMERCE",
 *               "items": [ { "code": "EXTRA_CFDI_100", "qty": 2 } ] }
 *
 * Rechaza: códigos desconocidos o inactivos, precios por definir (NULL),
 * productos que no se venden en un pedido (suscripciones, pantallas, giros
 * sueltos), cantidades fuera de 1..100.
 */
create or replace function public.license_quote(p_order jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c public.license_catalog%rowtype;
  it jsonb;
  v_lines jsonb := '[]';
  v_sub numeric(12, 2) := 0;
  v_rate numeric;
  v_qty int;
  v_ed text := nullif(trim(coalesce(p_order->>'edition', '')), '');
  v_vert text := nullif(upper(trim(coalesce(p_order->>'vertical', ''))), '');
  v_code text;
begin
  select (grants->>'rate')::numeric into v_rate from public.license_catalog where code = 'TAX_IVA_MX' and active;
  if v_rate is null then
    return jsonb_build_object('ok', false, 'code', 'TAX_MISSING', 'error', 'El catálogo no tiene tasa de impuesto.');
  end if;

  if v_ed is not null then
    select * into c from public.license_catalog where code = v_ed;
    if not found or c.kind <> 'EDITION' then return jsonb_build_object('ok', false, 'code', 'UNKNOWN_CODE', 'error', 'Edición desconocida.', 'product', v_ed); end if;
    if not c.active then return jsonb_build_object('ok', false, 'code', 'INACTIVE', 'error', 'Esa edición no está a la venta.', 'product', v_ed); end if;
    if c.list_price is null then return jsonb_build_object('ok', false, 'code', 'PRICE_TBD', 'error', 'Esa edición todavía no tiene precio.', 'product', v_ed); end if;
    if v_vert is null or not exists (select 1 from public.license_catalog where kind = 'VERTICAL' and vertical = v_vert and active) then
      return jsonb_build_object('ok', false, 'code', 'BAD_VERTICAL', 'error', 'Elige el tipo de negocio.');
    end if;
    v_lines := v_lines || jsonb_build_object('code', c.code, 'kind', c.kind, 'label', c.label, 'qty', 1,
                                             'unit_price', c.list_price, 'amount', c.list_price, 'edition', c.edition, 'vertical', v_vert);
    v_sub := v_sub + c.list_price;
  elsif v_vert is not null then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Un giro se compra con una edición.');
  end if;

  for it in select value from jsonb_array_elements(coalesce(p_order->'items', '[]')) loop
    v_code := it->>'code';
    v_qty := coalesce(nullif(it->>'qty', '')::int, 1);
    if v_qty < 1 or v_qty > 100 then return jsonb_build_object('ok', false, 'code', 'BAD_QTY', 'error', 'Cantidad inválida.', 'product', v_code); end if;
    select * into c from public.license_catalog where code = v_code;
    if not found then return jsonb_build_object('ok', false, 'code', 'UNKNOWN_CODE', 'error', 'Producto desconocido.', 'product', v_code); end if;
    if c.kind not in ('EXTRA', 'SUPPORT') then
      return jsonb_build_object('ok', false, 'code', 'NOT_SOLD_HERE', 'error', 'Ese producto no se vende en un pedido.', 'product', v_code);
    end if;
    if not c.active then return jsonb_build_object('ok', false, 'code', 'INACTIVE', 'error', 'Ese producto no está a la venta.', 'product', v_code); end if;
    if c.list_price is null then return jsonb_build_object('ok', false, 'code', 'PRICE_TBD', 'error', 'Ese producto todavía no tiene precio.', 'product', v_code); end if;
    if c.kind = 'SUPPORT' and v_ed is null then
      return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'El soporte se compra con una licencia.', 'product', v_code);
    end if;
    v_lines := v_lines || jsonb_build_object('code', c.code, 'kind', c.kind, 'label', c.label, 'qty', v_qty,
                                             'unit_price', c.list_price, 'amount', c.list_price * v_qty);
    v_sub := v_sub + c.list_price * v_qty;
  end loop;

  if jsonb_array_length(v_lines) = 0 then
    return jsonb_build_object('ok', false, 'code', 'EMPTY', 'error', 'El pedido está vacío.');
  end if;
  return jsonb_build_object('ok', true, 'currency', 'MXN', 'lines', v_lines, 'subtotal', v_sub,
                            'tax_rate', v_rate, 'tax', round(v_sub * v_rate, 2), 'total', v_sub + round(v_sub * v_rate, 2));
end $$;

/*
 * EMITIR la licencia de un pedido PAGADO. Atómica e idempotente por pago:
 * la misma orden devuelve la misma licencia (también si la creó la web
 * anterior). Cotiza otra vez desde el catálogo y exige que lo pagado cubra
 * el total: el importe que manda la web no es autoridad.
 *
 *   p_order = { provider, order_ref, license_key, edition, vertical, items,
 *               amount_paid, customer: { name, email, business, phone },
 *               cajas, origin, actor }
 */
create or replace function public.license_create_from_order(p_order jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  q jsonb;
  ln jsonb;
  v_id uuid;
  v_key text := upper(trim(coalesce(p_order->>'license_key', '')));
  v_prov text := upper(trim(coalesce(p_order->>'provider', '')));
  v_ref text := trim(coalesce(p_order->>'order_ref', ''));
  v_paid numeric := nullif(p_order->>'amount_paid', '')::numeric;
  v_plan text;
  v_vert text := upper(trim(coalesce(p_order->>'vertical', '')));
  v_cust jsonb := coalesce(p_order->'customer', '{}');
  v_origin text := coalesce(nullif(p_order->>'origin', ''), 'PRODUCTION');
  v_prio boolean;
  v_existente record;
begin
  if v_prov = '' or v_ref = '' then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Falta el pago.');
  end if;
  -- Idempotencia: el mismo pago ya emitió una licencia (con esta web o la anterior).
  select l.id, l.license_key into v_existente from public.licenses l
   where (v_prov = 'PAYPAL' and l.paypal_order_id = v_ref)
      or exists (select 1 from public.license_purchases p where p.license_id = l.id and p.payment_provider = v_prov and p.payment_ref = v_ref)
   limit 1;
  if found then
    return jsonb_build_object('ok', true, 'existing', true, 'license_id', v_existente.id, 'license_key', v_existente.license_key);
  end if;

  q := public.license_quote(p_order);
  if not (q->>'ok')::boolean then return q; end if;
  if v_paid is null or v_paid + 0.005 < (q->>'total')::numeric then
    return jsonb_build_object('ok', false, 'code', 'AMOUNT_MISMATCH', 'error', 'El monto pagado no cubre el pedido.',
                              'expected', q->'total', 'paid', v_paid);
  end if;
  if nullif(p_order->>'edition', '') is null then
    -- Pedido sin licencia (solo timbres, app, capacitación): se entrega a mano.
    return jsonb_build_object('ok', true, 'license_id', null, 'license_key', null, 'quote', q);
  end if;
  if v_key !~ '^[A-Z0-9-]{8,40}$' then
    return jsonb_build_object('ok', false, 'code', 'BAD_KEY', 'error', 'Clave de licencia inválida.');
  end if;
  if v_origin not in ('PRODUCTION', 'INTERNAL', 'QA', 'TEST') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Origen inválido.');
  end if;

  select edition into v_plan from public.license_catalog where code = p_order->>'edition';
  v_prio := exists (select 1 from jsonb_array_elements(q->'lines') x where x->>'code' = 'SUPPORT_PRIORITY');

  begin
    insert into public.licenses (license_key, plan, max_registers, customer_name, customer_email, customer_phone,
                                 buyer_email, buyer_name, negocio, cajas, paypal_order_id, status, support_until,
                                 support_tier, origin)
    values (v_key, v_plan, public.license_legacy_max_registers(v_plan),
            coalesce(nullif(trim(v_cust->>'name'), ''), nullif(trim(v_cust->>'business'), ''), 'Cliente Wybix'),
            nullif(trim(v_cust->>'email'), ''), nullif(trim(v_cust->>'phone'), ''),
            nullif(trim(v_cust->>'email'), ''), nullif(trim(v_cust->>'name'), ''), nullif(trim(v_cust->>'business'), ''),
            greatest(1, coalesce(nullif(p_order->>'cajas', '')::int, 1)),
            case when v_prov = 'PAYPAL' then v_ref end, 'activa', null,
            case when v_prio then 'PRIORITY' else 'BASIC' end, v_origin)
    returning id into v_id;
  exception when unique_violation then
    -- Otra petición con el mismo pago ganó la carrera: se devuelve la suya.
    select l.id, l.license_key into v_existente from public.licenses l where v_prov = 'PAYPAL' and l.paypal_order_id = v_ref;
    if found then
      return jsonb_build_object('ok', true, 'existing', true, 'license_id', v_existente.id, 'license_key', v_existente.license_key);
    end if;
    return jsonb_build_object('ok', false, 'code', 'KEY_CONFLICT', 'error', 'La clave ya existe; genera otra.');
  end;

  insert into public.license_verticals (license_id, vertical, source) values (v_id, v_vert, 'INITIAL');
  for ln in select value from jsonb_array_elements(q->'lines') loop
    insert into public.license_purchases (license_id, kind, catalog_code, list_price, price_paid, currency,
                                          payment_provider, payment_ref, detail, created_by)
    values (v_id, case ln->>'kind' when 'EDITION' then 'INITIAL' when 'SUPPORT' then 'SUPPORT' else 'EXTRA' end,
            ln->>'code', (ln->>'unit_price')::numeric, (ln->>'amount')::numeric, 'MXN', v_prov, v_ref,
            jsonb_build_object('qty', (ln->>'qty')::int, 'vertical', ln->>'vertical', 'order_total', q->'total', 'amount_paid', v_paid,
                               'cajas', p_order->'cajas', 'consent', p_order->'consent'),
            coalesce(p_order->>'actor', 'web'));
  end loop;
  perform public.license_log(v_id, 'LICENSE_CREATED',
    jsonb_build_object('edition', v_plan, 'vertical', v_vert, 'provider', v_prov, 'order_ref', v_ref, 'total', q->'total', 'origin', v_origin),
    coalesce(p_order->>'actor', 'web'));
  -- Evidencia de aceptación del Aviso de Privacidad y los Términos en el
  -- checkout: versiones aceptadas, cuándo y la referencia del pago. Sin datos
  -- personales. Si faltara (una llamada que no pasó por el checkout), queda
  -- marcado para revisión: el pago ya se capturó y no se retiene la licencia.
  perform public.license_log(v_id,
    case when p_order->'consent'->>'privacy_version' is not null and p_order->'consent'->>'terms_version' is not null
         then 'CHECKOUT_TERMS_ACCEPTED' else 'CHECKOUT_WITHOUT_CONSENT' end,
    jsonb_build_object('privacy_version', p_order->'consent'->>'privacy_version', 'terms_version', p_order->'consent'->>'terms_version',
                       'accepted_at', p_order->'consent'->>'accepted_at', 'marketing_opt_in', coalesce((p_order->'consent'->>'marketing')::boolean, false),
                       'provider', v_prov, 'order_ref', v_ref),
    coalesce(p_order->>'actor', 'web'));
  return jsonb_build_object('ok', true, 'existing', false, 'license_id', v_id, 'license_key', v_key, 'quote', q);
end $$;

-- ============================================================================
--  PRUEBA GRATUITA DE UN GIRO
-- ============================================================================
/* Lo que otorga una prueba: MonoCaja + el giro elegido (o ninguno todavía). */
create or replace function public.license_trial_grants(p_vertical text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'edition', 'mono',
    'registers_max', 1,
    'verticals', case when p_vertical is null then '[]'::jsonb else jsonb_build_array(p_vertical) end,
    'entitlements', coalesce((select jsonb_agg(distinct e order by e) from (
        select jsonb_array_elements_text(c.grants->'entitlements') e
          from public.license_catalog c
         where c.code = 'EDITION_MONO' or (c.kind = 'VERTICAL' and c.vertical = p_vertical)) x), '[]'::jsonb),
    'screens', case when p_vertical is null then '{}'::jsonb
                    else jsonb_build_object(p_vertical, (select grants->'screens_per_vertical' from public.license_catalog where code = 'SCREENS_BASE')) end);
$$;

/*
 * ELEGIR (o cambiar) el giro de la prueba. Lo pide el alta del negocio; el
 * servidor decide: solo con la prueba vigente, un giro a la vez, sin mover
 * las fechas. Cada cambio queda en el historial.
 */
create or replace function public.license_trial_select_vertical(p_machine_id text, p_vertical text, p_actor text default 'pos')
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.device_trials%rowtype; v_vert text := upper(trim(coalesce(p_vertical, '')));
begin
  if v_vert not in ('COMMERCE', 'HOSPITALITY', 'SERVICES') then
    return jsonb_build_object('ok', false, 'code', 'BAD_VERTICAL', 'error', 'Giro desconocido.');
  end if;
  select * into t from public.device_trials where machine_id = p_machine_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NO_TRIAL', 'error', 'Esta máquina no tiene prueba.'); end if;
  if t.expires_at < now() then return jsonb_build_object('ok', false, 'code', 'TRIAL_EXPIRED', 'error', 'La prueba ya terminó.'); end if;
  if t.vertical = v_vert then return jsonb_build_object('ok', true, 'unchanged', true, 'vertical', v_vert); end if;
  update public.device_trials
     set vertical = v_vert, vertical_selected_at = now(),
         vertical_changes = vertical_changes + case when t.vertical is null then 0 else 1 end
   where id = t.id;
  perform public.license_log(null, case when t.vertical is null then 'TRIAL_VERTICAL_SELECTED' else 'TRIAL_VERTICAL_CHANGED' end,
                             jsonb_build_object('machine_id', p_machine_id, 'from', t.vertical, 'to', v_vert), p_actor);
  return jsonb_build_object('ok', true, 'vertical', v_vert, 'previous', t.vertical);
end $$;

-- ============================================================================
--  REVISIÓN: licencias que alguien tiene que clasificar o completar
-- ============================================================================
create or replace view public.license_review_queue as
select l.id as license_id, l.license_key, l.plan, l.status, l.origin, l.created_at,
       (select count(*) from public.license_verticals v where v.license_id = l.id) as verticals,
       array_remove(array[
         case when l.origin is null then 'SIN_CLASIFICAR' end,
         case when not exists (select 1 from public.license_verticals v where v.license_id = l.id) then 'SIN_GIRO' end,
         case when exists (select 1 from public.license_events e where e.license_id = l.id and e.type = 'CANCEL_CANDIDATE')
                   and l.status = 'activa' then 'CANDIDATA_A_CANCELAR' end
       ], null) as reasons
  from public.licenses l
 where l.origin is null
    or not exists (select 1 from public.license_verticals v where v.license_id = l.id)
    or (l.status = 'activa' and exists (select 1 from public.license_events e where e.license_id = l.id and e.type = 'CANCEL_CANDIDATE'));

-- ============================================================================
--  MÉTRICAS COMERCIALES: SOLO PRODUCTION
-- ============================================================================
-- La ÚNICA fuente para contar clientes, ventas de licencias, renovaciones o
-- MRR. Una licencia TEST, QA o INTERNAL (o sin clasificar) no es un cliente
-- pagado y no entra aquí.
create or replace view public.license_commercial_licenses as
select l.* from public.licenses l where l.origin = 'PRODUCTION';

create or replace view public.license_commercial_purchases as
select p.* from public.license_purchases p
  join public.licenses l on l.id = p.license_id
 where l.origin = 'PRODUCTION';

-- ============================================================================
--  QA: permisos EXPLÍCITOS para equipos de pruebas
-- ============================================================================
/*
 * Da a una licencia de pruebas lo que su suite necesita: giros, MultiCaja,
 * pantallas ampliadas o ilimitadas, un periodo pagado. SOLO si la licencia es
 * TEST, QA o INTERNAL: nunca una comercial. Sin cobro (no deja compras) y con
 * historial (QA_GRANT). El certificado que resulta se firma igual que
 * cualquiera: V2, con la clave de producción.
 *
 *   p_grants = { "verticals": ["COMMERCE", ...], "screen_tier": "UNLIMITED",
 *                "edition": "multi", "paid_until": "2027-12-31" }
 */
create or replace function public.license_qa_grant(p_license uuid, p_grants jsonb, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.licenses%rowtype; v text; v_tier text := coalesce(p_grants->>'screen_tier', 'BASE');
        v_hasta timestamptz := nullif(p_grants->>'paid_until', '')::timestamptz;
begin
  if coalesce(trim(p_reason), '') = '' or coalesce(trim(p_actor), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Falta el motivo o quién lo autoriza.');
  end if;
  select * into l from public.licenses where id = p_license for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if l.origin is null or l.origin not in ('TEST', 'QA', 'INTERNAL') then
    return jsonb_build_object('ok', false, 'code', 'NOT_QA', 'error', 'Solo una licencia TEST, QA o INTERNAL recibe permisos de pruebas.');
  end if;
  if v_tier not in ('BASE', 'EXTENDED', 'UNLIMITED') then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Nivel de pantallas desconocido.');
  end if;
  if p_grants ? 'edition' then
    if p_grants->>'edition' not in ('mono', 'multi') then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST'); end if;
    update public.licenses set plan = p_grants->>'edition', max_registers = public.license_legacy_max_registers(p_grants->>'edition')
     where id = p_license;
  end if;
  for v in select jsonb_array_elements_text(coalesce(p_grants->'verticals', '[]')) loop
    if v not in ('COMMERCE', 'HOSPITALITY', 'SERVICES') then
      raise exception 'Giro desconocido: %', v;
    end if;
    insert into public.license_verticals (license_id, vertical, screen_tier, source) values (p_license, v, v_tier, 'QA')
    on conflict (license_id, vertical) do update set screen_tier = excluded.screen_tier;
  end loop;
  if v_hasta is not null and v_hasta > coalesce(public.license_paid_until(p_license), '-infinity') then
    insert into public.license_subscriptions (license_id, kind, period_start, period_end, created_by)
    values (p_license, 'MANUAL', now(), v_hasta, p_actor);
  end if;
  perform public.license_log(p_license, 'QA_GRANT', jsonb_build_object('grants', p_grants, 'reason', p_reason), p_actor);
  return jsonb_build_object('ok', true, 'runtime', public.license_runtime(p_license));
end $$;

/* Marcar una licencia de pruebas como candidata a cancelar (no se borra ni se suspende). */
create or replace function public.license_mark_cancel_candidate(p_license uuid, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.licenses where id = p_license and origin in ('TEST', 'QA', 'INTERNAL')) then
    return jsonb_build_object('ok', false, 'code', 'NOT_QA', 'error', 'Solo una licencia de pruebas se marca así.');
  end if;
  if not exists (select 1 from public.license_events where license_id = p_license and type = 'CANCEL_CANDIDATE') then
    perform public.license_log(p_license, 'CANCEL_CANDIDATE', jsonb_build_object('reason', p_reason), p_actor);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================================
--  PRECIOS: cambiar sin migración, con historial
-- ============================================================================
/*
 * El catálogo sigue siendo la única fuente de verdad. Lo que cambia es el
 * CÓMO: un cambio de precio es un DATO comercial, no un cambio de esquema.
 * Se hace con license_catalog_update() (backend privilegiado: service_role;
 * nunca anon ni un cliente autenticado) y queda en el historial. Las
 * migraciones quedan para el esquema, los seeds iniciales y los cambios
 * estructurales.
 *
 * El historial lo escribe un TRIGGER, así que ningún cambio se escapa: ni el
 * de la función, ni uno hecho por migración o a mano (este último queda
 * marcado como DIRECT, sin motivo). Las compras pasadas no se tocan: cada
 * license_purchases guarda su precio de lista, su descuento y lo pagado.
 */
create table if not exists public.license_catalog_price_history (
  id                  bigint generated always as identity primary key,
  catalog_code        text not null references public.license_catalog(code),
  old_price           numeric(12, 2),
  new_price           numeric(12, 2),
  old_reference_price numeric(12, 2),
  new_reference_price numeric(12, 2),
  old_active          boolean,
  new_active          boolean,
  currency            text not null,
  effective_from      timestamptz not null default now(),
  changed_at          timestamptz not null default now(),
  changed_by          text not null,
  reason              text not null,
  source              text not null check (source in ('SEED', 'FUNCTION', 'MIGRATION', 'DIRECT'))
);
create index if not exists ix_license_catalog_price_history on public.license_catalog_price_history (catalog_code, effective_from);

create or replace function public.license_catalog_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE'
     and new.list_price is not distinct from old.list_price
     and new.reference_price is not distinct from old.reference_price
     and new.active is not distinct from old.active then
    return new;
  end if;
  insert into public.license_catalog_price_history
    (catalog_code, old_price, new_price, old_reference_price, new_reference_price, old_active, new_active,
     currency, changed_by, reason, source)
  values (new.code,
          case when tg_op = 'UPDATE' then old.list_price end, new.list_price,
          case when tg_op = 'UPDATE' then old.reference_price end, new.reference_price,
          case when tg_op = 'UPDATE' then old.active end, new.active,
          new.currency,
          coalesce(nullif(current_setting('wybix.actor', true), ''), session_user),
          coalesce(nullif(current_setting('wybix.reason', true), ''), case when tg_op = 'INSERT' then 'alta en el catálogo' else 'cambio directo, sin motivo' end),
          coalesce(nullif(current_setting('wybix.source', true), ''), case when tg_op = 'INSERT' then 'MIGRATION' else 'DIRECT' end));
  return new;
end $$;

drop trigger if exists tr_license_catalog_audit on public.license_catalog;
create trigger tr_license_catalog_audit after insert or update on public.license_catalog
  for each row execute function public.license_catalog_audit();

-- El estado inicial de cada producto, una vez (lo sembrado antes del trigger).
insert into public.license_catalog_price_history
  (catalog_code, old_price, new_price, old_reference_price, new_reference_price, old_active, new_active,
   currency, effective_from, changed_at, changed_by, reason, source)
select c.code, null, c.list_price, null, c.reference_price, null, c.active, c.currency, c.updated_at, now(),
       'migracion', 'catálogo inicial del licenciamiento v2', 'SEED'
  from public.license_catalog c
 where not exists (select 1 from public.license_catalog_price_history h where h.catalog_code = c.code);

/*
 * CAMBIAR un producto del catálogo: precio de lista (NULL = por definir),
 * precio de referencia o activo/inactivo. Exige motivo y quién lo autoriza.
 * Solo afecta cotizaciones NUEVAS; ninguna compra pasada cambia.
 *
 *   select license_catalog_update('EXTRA_CFDI_100', '{"list_price": 275}', 'ajuste de proveedor', 'admin:david');
 */
create or replace function public.license_catalog_update(p_code text, p_changes jsonb, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.license_catalog%rowtype; v_precio numeric; v_ref numeric; v_activo boolean;
begin
  if coalesce(length(trim(p_reason)), 0) < 5 or coalesce(trim(p_actor), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Todo cambio de precio necesita un motivo y quién lo autoriza.');
  end if;
  select * into c from public.license_catalog where code = p_code for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Producto desconocido.'); end if;
  if c.kind = 'TAX' then return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'El impuesto no se cambia por aquí.'); end if;
  v_precio := case when p_changes ? 'list_price' then nullif(p_changes->>'list_price', '')::numeric else c.list_price end;
  v_ref    := case when p_changes ? 'reference_price' then nullif(p_changes->>'reference_price', '')::numeric else c.reference_price end;
  v_activo := case when p_changes ? 'active' then (p_changes->>'active')::boolean else c.active end;
  if (v_precio is not null and v_precio < 0) or (v_ref is not null and v_ref < 0) then
    return jsonb_build_object('ok', false, 'code', 'BAD_REQUEST', 'error', 'Un precio no puede ser negativo.');
  end if;
  perform set_config('wybix.actor', p_actor, true);
  perform set_config('wybix.reason', p_reason, true);
  perform set_config('wybix.source', 'FUNCTION', true);
  update public.license_catalog
     set list_price = v_precio, reference_price = v_ref, active = v_activo, updated_at = now()
   where code = p_code;
  perform set_config('wybix.source', '', true);
  return jsonb_build_object('ok', true, 'code', p_code,
    'before', jsonb_build_object('list_price', c.list_price, 'reference_price', c.reference_price, 'active', c.active),
    'after',  jsonb_build_object('list_price', v_precio, 'reference_price', v_ref, 'active', v_activo));
end $$;

/* Qué precio tenía cada producto, desde cuándo y hasta cuándo. */
create or replace view public.license_catalog_price_periods as
select h.catalog_code, h.new_price as list_price, h.new_active as active, h.currency,
       h.effective_from as valid_from,
       lead(h.effective_from) over (partition by h.catalog_code order by h.effective_from, h.id) as valid_to,
       h.changed_by, h.reason, h.source
  from public.license_catalog_price_history h;

-- Beneficios de soporte: comercial, NUNCA en el certificado del POS.
-- Las adaptaciones incluidas son del primer año desde la activación; los
-- BUG_FIX no cuentan.
create or replace view public.license_support_summary as
select l.id as license_id,
       l.support_tier,
       l.support_until,
       l.included_code_changes,
       (select count(*) from public.license_code_changes c
         where c.license_id = l.id and c.kind = 'CUSTOMIZATION' and c.status <> 'CANCELADO'
           and (l.first_activated_at is null or c.created_at < l.first_activated_at + interval '12 months')) as used_code_changes,
       greatest(l.included_code_changes - (select count(*) from public.license_code_changes c
         where c.license_id = l.id and c.kind = 'CUSTOMIZATION' and c.status <> 'CANCELADO'
           and (l.first_activated_at is null or c.created_at < l.first_activated_at + interval '12 months')), 0) as remaining_code_changes
  from public.licenses l;

-- ============================================================================
--  PRIVILEGIOS: nada de licencias para anon ni authenticated.
--  RLS sin políticas ya lo impedía por PostgREST; se quitan además los
--  privilegios de tabla (TRUNCATE no respeta RLS) por defensa en profundidad.
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['licenses', 'license_activations', 'device_trials', 'license_verticals', 'license_purchases',
                           'license_subscriptions', 'license_code_changes', 'license_events', 'license_catalog'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

revoke all on public.license_support_summary from anon, authenticated;
grant select on public.license_support_summary to service_role;
revoke all on public.license_review_queue from anon, authenticated;
grant select on public.license_review_queue to service_role;
do $$
declare v text;
begin
  foreach v in array array['license_commercial_licenses', 'license_commercial_purchases', 'license_catalog_price_periods'] loop
    execute format('revoke all on public.%I from anon, authenticated', v);
    execute format('grant select on public.%I to service_role', v);
  end loop;
end $$;
alter table public.license_catalog_price_history enable row level security;
revoke all on table public.license_catalog_price_history from anon, authenticated;
grant all on table public.license_catalog_price_history to service_role;

-- El catálogo ACTIVO es público (precios de lista y descripciones).
grant select on table public.license_catalog to anon, authenticated;
drop policy if exists "catalogo publico" on public.license_catalog;
create policy "catalogo publico" on public.license_catalog for select to anon, authenticated using (active);

do $$
declare f text;
begin
  foreach f in array array[
    'license_log(uuid, text, jsonb, text)', 'license_paid_until(uuid)', 'license_runtime(uuid)',
    'license_activate(text, text, text)', 'license_release(uuid, text, text)', 'license_for_machine(text)',
    'license_record_purchase(uuid, text, text, numeric, numeric, numeric, text, text, numeric, text, text, jsonb, text)',
    'license_upgrade_to_multi(uuid, jsonb, text)', 'license_add_vertical(uuid, text, jsonb, text)',
    'license_remove_vertical(uuid, text, text)', 'license_set_screen_tier(uuid, text, text, jsonb, text)',
    'license_renew(uuid, text, jsonb, text)', 'license_register_code_change(uuid, text, text, text, text)',
    'license_registers_max(text)', 'license_legacy_max_registers(text)',
    'license_quote(jsonb)', 'license_create_from_order(jsonb)',
    'license_trial_grants(text)', 'license_trial_select_vertical(text, text, text)',
    'license_qa_grant(uuid, jsonb, text, text)', 'license_mark_cancel_candidate(uuid, text, text)',
    'license_catalog_update(text, jsonb, text, text)', 'license_catalog_audit()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
