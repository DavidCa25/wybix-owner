-- ============================================================================
--  PRUEBAS DEL ESTADO FINAL (PARTE B aplicada sobre la A). Las corre
--  scripts/probar-licenciamiento.mjs después de las de la PARTE A, sobre la
--  misma base (t_res y t_check ya existen).
-- ============================================================================
create temp table t_tmp_b (k text primary key, v jsonb);

select t_check('F01', (select count(*) from licenses where plan = 'multi' and max_registers is not null) = 0
                  and (select bool_and(max_registers = 1) from licenses where plan = 'mono'),
  'estado final: MultiCaja = NULL (ilimitadas), MonoCaja = 1; ya no hay 0 ni 9999');
select t_check('F01', exists (select 1 from pg_constraint where conname = 'licenses_edicion_cajas_check')
                  and exists (select 1 from license_events where type = 'LEGACY_REGISTERS_CONTRACT_RETIRED'),
  'la restricción edición/cajas existe y el retiro del contrato anterior queda registrado');

-- La web ANTERIOR (INSERT directo con 9999) ya no puede emitir: por eso B va después de reemplazarla.
do $$
begin
  begin
    set local role service_role;
    insert into public.licenses (license_key, plan, customer_name, max_registers, paypal_order_id)
    values ('WYBIX-VIEJ-B000-0001', 'multi', 'Web anterior', 9999, 'ORD-B-OLD');
    perform t_check('F02', false, 'la web anterior ya no puede guardar MultiCaja como 9999');
  exception when check_violation then
    perform t_check('F02', true, 'la web anterior ya no puede guardar MultiCaja como 9999 (se rechaza)');
  end;
end $$;
reset role;

insert into t_tmp_b values ('n1', license_create_from_order('{"provider":"PAYPAL","order_ref":"ORD-F3","license_key":"WYBIX-FINA-L000-0003","edition":"EDITION_MULTI","vertical":"COMMERCE","amount_paid":4638.84}'));
select t_check('F03', (select v->>'ok' = 'true' from t_tmp_b where k = 'n1')
                  and (select plan = 'multi' and max_registers is null from licenses where license_key = 'WYBIX-FINA-L000-0003'),
  'la web nueva emite MultiCaja con max_registers NULL');
insert into t_tmp_b values ('n2', license_create_from_order('{"provider":"PAYPAL","order_ref":"ORD-F4","license_key":"WYBIX-FINA-L000-0004","edition":"EDITION_MONO","vertical":"SERVICES","amount_paid":2898.84}'));
insert into t_tmp_b values ('up', license_upgrade_to_multi((select id from licenses where license_key = 'WYBIX-FINA-L000-0004'), '{}', 'admin'));
select t_check('F04', (select plan = 'multi' and max_registers is null from licenses where license_key = 'WYBIX-FINA-L000-0004'),
  'MonoCaja -> MultiCaja en el estado final: NULL');
select t_check('F05', (license_activate('WYBIX-FINA-L000-0003', 'F-PC-1'))->>'ok' = 'true'
                  and (license_activate('WYBIX-FINA-L000-0003', 'F-PC-2'))->>'ok' = 'true'
                  and (license_activate('WYBIX-FINA-L000-0003', 'F-PC-3'))->>'ok' = 'true',
  'MultiCaja sigue activando cajas sin límite');
insert into t_tmp_b values ('m1', license_create_from_order('{"provider":"PAYPAL","order_ref":"ORD-F6","license_key":"WYBIX-FINA-L000-0006","edition":"EDITION_MONO","vertical":"COMMERCE","amount_paid":2898.84}'));
select t_check('F05', (license_activate('WYBIX-FINA-L000-0006', 'F6-A'))->>'ok' = 'true'
                  and (license_activate('WYBIX-FINA-L000-0006', 'F6-B'))->>'code' = 'LIMIT_REACHED',
  'MonoCaja sigue en una caja');
select t_check('F06', (select (license_runtime(id)->>'registers_max') is null from licenses where license_key = 'WYBIX-FINA-L000-0003')
                  and (select (license_runtime(id)->>'registers_max')::int = 1 from licenses where license_key = 'WYBIX-FINA-L000-0006'),
  'el certificado dice lo mismo antes y después de B: las cajas salen de la edición');

select string_agg(format('%s|%s|%s', case when ok then 'ok' else 'FALLA' end, id, msg), E'\n' order by n) as resultado
  from t_res where id like 'F%';
