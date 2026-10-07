-- ============================================================================
--  DATOS CON LA FORMA DE PRODUCCIÓN, ANTES DE LA FASE 1
-- ----------------------------------------------------------------------------
--  Lo que hay hoy (2026-10-02, conteos del catálogo real): un negocio por
--  equipo (7 negocios / 7 sucursales), 3 con token de sincronización, 1 dueño
--  ligado por owner_id, 1 owner_app, licencias con su activación por máquina y
--  una sucursal con license_machine_id. Aquí se reproduce ESA forma con datos
--  ficticios para probar que la migración la conserva y no inventa nada.
-- ============================================================================
insert into auth.users (id, email) values
  ('10000000-0000-0000-0000-00000000000a', 'dueno.legado@prueba.mx'),
  ('10000000-0000-0000-0000-00000000000b', 'app.sin.verificar@prueba.mx');

insert into public.negocios (id, nombre, owner_id) values
  ('20000000-0000-0000-0000-000000000001', 'Tienda Legado', '10000000-0000-0000-0000-00000000000a'),
  ('20000000-0000-0000-0000-000000000002', 'Mi negocio', null),
  ('20000000-0000-0000-0000-000000000003', 'Mi negocio', null),
  ('20000000-0000-0000-0000-000000000004', 'Mi negocio', null),
  ('20000000-0000-0000-0000-000000000005', 'Mi negocio', null),
  ('20000000-0000-0000-0000-000000000006', 'Mi negocio', null),
  ('20000000-0000-0000-0000-000000000007', 'Mi negocio', null);

insert into public.sucursales (id, negocio_id, nombre, device_key, license_machine_id) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Matriz', 'DEV-LEGADO-1', 'PC-LEGADO-1'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'Matriz', 'DEV-LEGADO-2', null),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', 'Matriz', 'DEV-LEGADO-3', null),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000004', 'Matriz', 'DEV-LEGADO-4', null),
  ('30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000005', 'Matriz', 'DEV-LEGADO-5', null),
  ('30000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000006', 'Matriz', 'DEV-LEGADO-6', null),
  ('30000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000007', 'Matriz', 'DEV-LEGADO-7', null);

-- Tokens anteriores (sha256 hex del token, como los guarda pos-sync).
update public.sucursales set sync_token_hash = encode(sha256(convert_to('token-legado-uno-0123456789abcdef', 'UTF8')), 'hex')
 where id = '30000000-0000-0000-0000-000000000001';
update public.sucursales set sync_token_hash = encode(sha256(convert_to('token-legado-dos-0123456789abcdef', 'UTF8')), 'hex')
 where id = '30000000-0000-0000-0000-000000000002';
update public.sucursales set sync_token_hash = encode(sha256(convert_to('token-legado-tres-0123456789abcde', 'UTF8')), 'hex')
 where id = '30000000-0000-0000-0000-000000000003';

-- Espejos que hoy lee la app del dueño.
insert into public.resumen_ventas (sucursal_id, fecha, total, num_tickets) values
  ('30000000-0000-0000-0000-000000000001', current_date, 1500, 12),
  ('30000000-0000-0000-0000-000000000002', current_date, 999, 3);
insert into public.cortes_caja (sucursal_id, closure_id_local, caja, abierto_at, cerrado_at, esperado, entregado, diferencia) values
  ('30000000-0000-0000-0000-000000000001', 7, 'Caja 1', now() - interval '9 hours', now() - interval '1 hour', 800, 790, -10);
insert into public.alertas (sucursal_id, tipo, titulo, mensaje) values
  ('30000000-0000-0000-0000-000000000001', 'corte', 'Corte con diferencia', 'Faltaron $10'),
  ('30000000-0000-0000-0000-000000000002', 'corte', 'Alerta ajena', 'De otro negocio');

-- Apps del dueño: la del dueño real y otra que se ligó solo con el id del negocio.
insert into public.owner_apps (negocio_id, user_id) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000a'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000b');

-- Licencias: una con evidencia ÚNICA (su máquina = license_machine_id de una
-- sucursal) y otra activada en una máquina que ninguna sucursal reporta.
insert into public.licenses (id, license_key, plan, customer_name, max_registers) values
  ('40000000-0000-0000-0000-000000000001', 'WYBX-LEG1-0001', 'mono', 'Tienda Legado', 1),
  ('40000000-0000-0000-0000-000000000002', 'WYBX-LEG2-0002', 'multi', 'Sin rastro', null);
insert into public.license_activations (license_id, machine_id) values
  ('40000000-0000-0000-0000-000000000001', 'PC-LEGADO-1'),
  ('40000000-0000-0000-0000-000000000002', 'PC-SIN-SUCURSAL');

-- Políticas RLS tal como están en producción (catálogo real). La Fase 1 las
-- respalda y las reemplaza por membresías.
create policy "dueno ve su negocio" on public.negocios for select using (owner_id = auth.uid());
create policy "dueno ve sus sucursales" on public.sucursales for select
  using (negocio_id in (select negocios.id from negocios where negocios.owner_id = auth.uid()));
create policy "dueno ve sus resumenes" on public.resumen_ventas for select
  using (sucursal_id in (select s.id from sucursales s join negocios n on n.id = s.negocio_id where n.owner_id = auth.uid()));
create policy "dueno ve su tendencia" on public.tendencia_ventas for select
  using (sucursal_id in (select s.id from sucursales s join negocios n on n.id = s.negocio_id where n.owner_id = auth.uid()));
create policy "owner reads seguridad_riesgo" on public.seguridad_riesgo for select
  using (sucursal_id in (select sucursales.id from sucursales));
create policy "dueno ve sus tokens" on public.push_tokens for select using (owner_id = auth.uid());
create policy "dueno inserta sus tokens" on public.push_tokens for insert with check (owner_id = auth.uid());
create policy "dueno borra sus tokens" on public.push_tokens for delete using (owner_id = auth.uid());
