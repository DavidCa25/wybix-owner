-- ============================================================================
--  CLUB (POS 0063) · se corre sobre el contenedor de probar-fase3 (--conservar).
--  Dos cajas de la misma empresa (Centro y Norte): un socio, su café de hoy en
--  las dos sucursales (una sin internet) y la marca de doble.
-- ============================================================================
create temp table r (k text primary key, v jsonb);
create or replace function pg_temp.dev(n text) returns uuid language sql as $$
  select d.id from devices d join sucursales s on s.id = d.location_id
   where d.kind = 'POS_PRIMARY' and d.status = 'ACTIVE' and s.nombre = n
     and d.company_id in (select company_id from devices where kind = 'POS_PRIMARY' and status = 'ACTIVE' group by company_id having count(*) > 1)
   limit 1 $$;
create or replace function pg_temp.ev(t text, agg uuid, ver int, pl jsonb, occ timestamptz default now()) returns jsonb language sql as $$
  select jsonb_build_object('event_uuid', gen_random_uuid(), 'event_type', t, 'aggregate_type', t, 'aggregate_uuid', agg,
                            'aggregate_version', ver, 'occurred_at', occ, 'payload', pl) $$;
create or replace function pg_temp.subir(dev uuid, evs jsonb) returns jsonb language sql as $$
  select sync_ingest(jsonb_build_object('device_id', dev, 'envelope', '{}'::jsonb, 'events', evs)) $$;
create or replace function pg_temp.chk(id text, ok boolean, msg text) returns text language sql as $$
  select case when ok then 'ok|' else 'FALLA|' end || id || '|' || msg $$;

insert into r values ('plan', to_jsonb(gen_random_uuid())), ('socia', to_jsonb(gen_random_uuid())),
                     ('c1', to_jsonb(gen_random_uuid())), ('c2', to_jsonb(gen_random_uuid())), ('c3', to_jsonb(gen_random_uuid()));
create or replace function pg_temp.u(k text) returns uuid language sql as $$ select (v #>> '{}')::uuid from r where r.k = $1 $$;

-- Centro crea el plan y afilia a Mariana.
insert into r select 'sub1', pg_temp.subir(pg_temp.dev('Centro'), jsonb_build_array(
  pg_temp.ev('MEMBERSHIP_PLAN', pg_temp.u('plan'), 1, jsonb_build_object('name', 'Club Café', 'period_days', 30, 'daily_limit', 1, 'grace_days', 2, 'active', true, 'products', '[]'::jsonb)),
  pg_temp.ev('MEMBERSHIP', pg_temp.u('socia'), 1, jsonb_build_object('plan_uuid', pg_temp.u('plan'), 'customer_name', 'Mariana López', 'phone', '4773124588', 'status', 'ACTIVE', 'paid_until', (current_date + 29)::text)),
  pg_temp.ev('MEMBERSHIP_REDEMPTION', pg_temp.u('c1'), 1, jsonb_build_object('membership_uuid', pg_temp.u('socia'), 'redeem_date', current_date::text, 'units', 1, 'product_name', 'Americano'), now() - interval '2 hours')));
select pg_temp.chk('CLUB01', (select count(*) from jsonb_array_elements(v->'results') x where x->>'result' = 'APPLIED') = 3, 'Centro sube plan, socia y su café') from r where k = 'sub1';
select pg_temp.chk('CLUB02', not (select doble from club_redemptions where uuid = pg_temp.u('c1')), 'el primer café del día no es doble');

-- Norte (sin internet, no sabía) también le dio café hoy; y renovó desde allá con menos días.
insert into r select 'sub2', pg_temp.subir(pg_temp.dev('Norte'), jsonb_build_array(
  pg_temp.ev('MEMBERSHIP_REDEMPTION', pg_temp.u('c2'), 1, jsonb_build_object('membership_uuid', pg_temp.u('socia'), 'redeem_date', current_date::text, 'units', 1, 'product_name', 'Capuchino'), now() - interval '1 hour'),
  pg_temp.ev('MEMBERSHIP', pg_temp.u('socia'), 5, jsonb_build_object('plan_uuid', pg_temp.u('plan'), 'customer_name', 'Mariana López', 'phone', '4773124588', 'status', 'ACTIVE', 'paid_until', (current_date + 10)::text))));
select pg_temp.chk('CLUB03', (select doble from club_redemptions where uuid = pg_temp.u('c2')) and not (select doble from club_redemptions where uuid = pg_temp.u('c1')),
  'el segundo café del mismo día queda doble; el primero no');
select pg_temp.chk('CLUB04', (select paid_until from club_memberships where uuid = pg_temp.u('socia')) = current_date + 29, 'pagado hasta: se queda el mayor');

-- Norte anula su café (devolución): ya no hay doble.
insert into r select 'sub3', pg_temp.subir(pg_temp.dev('Norte'), jsonb_build_array(
  pg_temp.ev('MEMBERSHIP_REDEMPTION', pg_temp.u('c2'), 2, jsonb_build_object('membership_uuid', pg_temp.u('socia'), 'redeem_date', current_date::text, 'units', 1, 'voided', true), now() - interval '1 hour')));
select pg_temp.chk('CLUB05', not (select doble from club_redemptions where uuid = pg_temp.u('c2')) and (select voided from club_redemptions where uuid = pg_temp.u('c2')),
  'anulado el café de Norte, ya no es doble');

-- club_pull: Norte recibe todo, con el nombre de la sucursal.
insert into r select 'pull', club_pull(jsonb_build_object('device_id', pg_temp.dev('Norte'), 'desde', (now() - interval '1 day')::text));
select pg_temp.chk('CLUB06', (v->>'ok')::boolean and jsonb_array_length(v->'plans') >= 1 and jsonb_array_length(v->'memberships') >= 1
  and exists (select 1 from jsonb_array_elements(v->'redemptions') x where x->>'uuid' = pg_temp.u('c1')::text and x->>'location_name' = 'Centro'),
  'club_pull de Norte trae plan, socia y el café de Centro con su sucursal') from r where k = 'pull';
insert into r select 'pull2', club_pull(jsonb_build_object('device_id', pg_temp.dev('Norte'), 'desde', (now() + interval '1 minute')::text));
select pg_temp.chk('CLUB07', jsonb_array_length(v->'memberships') = 0 and jsonb_array_length(v->'redemptions') = 0, 'sin cambios desde el cursor no trae nada') from r where k = 'pull2';
select pg_temp.chk('CLUB08', (club_pull(jsonb_build_object('device_id', gen_random_uuid())))->>'code' = 'DENIED', 'un equipo desconocido no recibe nada');
-- Reenviar el mismo lote: DUPLICATE, sin cambios.
select pg_temp.chk('CLUB09', (select count(*) from club_redemptions where membership_uuid = pg_temp.u('socia')) = 2, 'cada canje existe una sola vez');

-- ============================================================================
--  PUNTOS Y SELLOS (POS 0064): cada sucursal sube sus movimientos; club_pull
--  le devuelve a cada una los de las DEMÁS.
-- ============================================================================
insert into r values ('tarjeta', to_jsonb(gen_random_uuid())), ('m1', to_jsonb(gen_random_uuid())), ('m2', to_jsonb(gen_random_uuid()));
insert into r select 'sub4', pg_temp.subir(pg_temp.dev('Centro'), jsonb_build_array(
  pg_temp.ev('POINTS_CONFIG', '00000000-0000-0000-0000-000000000064', 7, jsonb_build_object('enabled', true, 'per_amount', '10.00', 'points_per', 1, 'visit_points', 5, 'updated_local', '2026-10-19T08:00:00')),
  pg_temp.ev('STAMP_CARD', pg_temp.u('tarjeta'), 1, jsonb_build_object('name', 'Café 9+1', 'stamps_required', 9, 'active', true, 'products', '[]'::jsonb)),
  pg_temp.ev('LOYALTY_LEDGER', pg_temp.u('m1'), 1, jsonb_build_object('customer_name', 'Mariana López', 'phone', '4773124588', 'program', 'POINTS', 'delta', 12, 'kind', 'EARN', 'reason', 'PURCHASE', 'created_local', '2026-10-19T08:10:00')),
  pg_temp.ev('LOYALTY_LEDGER', pg_temp.u('m2'), 1, jsonb_build_object('customer_name', 'Mariana López', 'phone', '4773124588', 'program', 'STAMPS', 'card_uuid', pg_temp.u('tarjeta'), 'delta', 1, 'kind', 'EARN', 'created_local', '2026-10-19T08:10:00'))));
select pg_temp.chk('PTS01', (select count(*) from jsonb_array_elements(v->'results') x where x->>'result' = 'APPLIED') = 4, 'Centro sube configuración, tarjeta y dos movimientos') from r where k = 'sub4';
select pg_temp.chk('PTS02', (select points_per from club_points_config where company_id = (select company_id from devices where id = pg_temp.dev('Centro'))) = 1
  and exists (select 1 from club_stamp_cards where uuid = pg_temp.u('tarjeta')), 'se guardan la configuración y la tarjeta');
insert into r select 'pullN', club_pull(jsonb_build_object('device_id', pg_temp.dev('Norte'), 'desde', (now() - interval '1 day')::text));
select pg_temp.chk('PTS03', (v->'points_config'->>'points_per')::int = 1 and jsonb_array_length(v->'stamp_cards') >= 1
  and exists (select 1 from jsonb_array_elements(v->'ledger') x where x->>'uuid' = pg_temp.u('m1')::text and x->>'location_name' = 'Centro'),
  'Norte recibe configuración, tarjeta y los puntos de Mariana hechos en Centro') from r where k = 'pullN';
insert into r select 'pullC', club_pull(jsonb_build_object('device_id', pg_temp.dev('Centro'), 'desde', (now() - interval '1 day')::text));
select pg_temp.chk('PTS04', not exists (select 1 from jsonb_array_elements(v->'ledger') x where x->>'uuid' in (pg_temp.u('m1')::text, pg_temp.u('m2')::text)),
  'Centro no recibe de vuelta sus propios movimientos') from r where k = 'pullC';
insert into r select 'sub5', pg_temp.subir(pg_temp.dev('Centro'), jsonb_build_array(
  pg_temp.ev('POINTS_CONFIG', '00000000-0000-0000-0000-000000000064', 3, jsonb_build_object('enabled', true, 'per_amount', '50.00', 'points_per', 1, 'updated_local', '2026-10-01T08:00:00'))));
select pg_temp.chk('PTS05', (select per_amount from club_points_config where company_id = (select company_id from devices where id = pg_temp.dev('Centro'))) = 10,
  'una configuración más vieja no pisa la vigente');
