-- ============================================================================
--  CONCILIACIÓN MANUAL (Fase 1 -> Fase 2)
-- ----------------------------------------------------------------------------
--  Herramienta de SOPORTE. No es una migración: se corre a mano en el editor
--  SQL del proyecto (rol postgres / service_role), un paso a la vez, leyendo el
--  resultado antes de seguir. Cada decisión queda en cloud_audit.
--
--  Regla: nada se resuelve sin EVIDENCIA inequívoca. Ante la duda, el
--  pendiente se queda abierto: un dueño equivocado ve ventas ajenas.
--
--  Qué evidencia cuenta
--    LICENSE_UNLINKED      factura o comprobante de compra a nombre del negocio,
--                          o el POS de esa empresa activó la licencia (ver
--                          license_activations con device_id de esa empresa).
--    OWNER_APP_UNVERIFIED  la persona confirma por un canal conocido (teléfono
--                          del contrato, correo de la factura) que es dueña o
--                          encargada; o la dueña actual la invita desde el POS
--                          (eso crea la membresía y el pendiente se cierra solo).
--    CLONE_SUSPECTED       la dueña confirma "moví el servidor" (REBIND) o
--                          "es otra sucursal" (NEW_LOCATION) desde Wybix Owner.
-- ============================================================================

-- 0) Qué hay pendiente ---------------------------------------------------------
select kind, status, count(*) from public.reconciliation_items group by 1, 2 order by 1, 2;

select i.id, i.kind, i.ref, i.detail, i.created_at
  from public.reconciliation_items i
 where i.status = 'OPEN'
 order by i.kind, i.created_at;

-- 1) Lo que se resuelve solo (evidencia ya presente en la base) ----------------
--    Licencia que ya quedó ligada; app de dueño cuya membresía ya existe;
--    duplicado del modelo viejo sin ningún dato propio (se ARCHIVA, no se borra).
select public.conciliar_automatico();

-- 2) Licencia sin empresa -------------------------------------------------------
--    Revisar a quién pertenece ANTES de ligar:
--      select l.id, l.license_key, l.customer_name, l.company_id, a.device_id, d.company_id as empresa_del_equipo
--        from public.licenses l
--        left join public.license_activations a on a.license_id = l.id
--        left join public.devices d on d.id = a.device_id
--       where l.id = '<license_id>';
--
-- select public.conciliar_licencia(jsonb_build_object(
--   'license_id', '<license_id>',
--   'company_id', '<company_id>',
--   'evidencia',  'Factura 1234 a nombre de I Do Nut; confirmado por teléfono con la dueña',
--   'actor',      'soporte:<tu nombre>'
-- ));
--    Si la licencia ya está en OTRA empresa responde ALREADY_LINKED; reasignar
--    exige 'reasignar', true y una evidencia que explique por qué.

-- 3) App de dueño sin verificar -------------------------------------------------
-- select public.conciliar_owner_app(jsonb_build_object(
--   'item_id',  <id del pendiente>,
--   'decision', 'GRANT',          -- o 'DENY' (desactiva la app, no da acceso)
--   'role',     'VIEWER',         -- el mínimo que corresponda; OWNER solo con evidencia fuerte
--   'actor',    'soporte:<tu nombre>'
-- ));

-- 4) Base restaurada en otro servidor (clon) -----------------------------------
--    Lo decide la DUEÑA desde Wybix Owner (owner_resolver_clon). Soporte solo
--    revisa:
--      select id, ref, detail from public.reconciliation_items where kind = 'CLONE_SUSPECTED' and status = 'OPEN';

-- 5) Evento conciliado con faltante --------------------------------------------
--    No es un pendiente: queda en sucursales.reconciliation (motivo, quién y
--    las existencias que no regresaron).
--      select nombre, reconciled_at, reconciliation from public.sucursales where tipo = 'EVENT' and event_status = 'RECONCILED';
