-- ============================================================================
--  EMPRESA ADICIONAL: la licencia dice cuántas empresas opera una instalación
-- ----------------------------------------------------------------------------
--  Modelo comercial (estudio de mercado del 2026-11-08):
--
--   · Una licencia opera SU empresa. Cada empresa más en la MISMA instalación
--     (B&J Super + Los Pachoncitos, una base cada una en el mismo servidor) es
--     una «Empresa adicional»: $1,499 + IVA con el primer año incluido.
--   · Las empresas REMOTAS de un grupo (I Do Nut ↔ Birrialtlan, cada una en su
--     computadora) no pagan extra: cada una ya tiene su licencia. Para unirse
--     a un grupo, las dos tienen que tener licencia vigente o prueba activa.
--   · Una empresa adicional sin licencia tiene 30 días de prueba en el POS;
--     después queda en solo consulta. Eso lo decide el POS con el certificado.
--
--  Aquí:
--   1. licenses.extra_companies: las empresas adicionales compradas.
--   2. Catálogo: EXTRA_COMPANY se vende en la web como cualquier extra.
--   3. license_runtime → companies_max (1 + adicionales) en el certificado.
--   4. grupo_unir exige licencia o prueba a las dos empresas.
--
--  ENTREGA. Como los timbres, el pedido le llega al dueño por correo. Se
--  entrega sumando a la licencia del cliente:
--
--    update public.licenses set extra_companies = extra_companies + 1
--     where license_key = 'WYBIX-XXXX-XXXX-XXXX';
--
--  y el POS lo recibe en su siguiente refresco del certificado.
--
--  Idempotente: el arnés la aplica dos veces.
-- ============================================================================
begin;

alter table public.licenses add column if not exists extra_companies int not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'licenses_extra_companies_check') then
    alter table public.licenses add constraint licenses_extra_companies_check
      check (extra_companies between 0 and 100);
  end if;
end $$;

insert into public.license_catalog (code, kind, label, description, edition, vertical, grants, list_price, reference_price, billing, sort, notes)
select 'EXTRA_COMPANY', 'EXTRA', 'Empresa adicional',
       'Otra empresa en la misma computadora, con su propia base, cajón, inventario y facturación. Incluye el primer año.',
       null, null, '{"companies":1}', 1499, null, 'ONE_TIME', 79,
       'Se entrega sumando licenses.extra_companies. Renovación: 50% de la renovación de la licencia principal.'
 where not exists (select 1 from public.license_catalog where code = 'EXTRA_COMPANY');

-- Lo que el certificado necesita saber de una licencia. SOLO runtime.
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
    -- La empresa de la licencia + las adicionales compradas.
    'companies_max', 1 + coalesce(l.extra_companies, 0),
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
 * ¿La empresa tiene licencia vigente o una prueba activa?
 *   - una licencia activa ligada a la empresa, o activada en una de sus cajas;
 *   - o una prueba vigente en la computadora de una de sus sucursales.
 */
create or replace function public.wx_empresa_con_licencia(p_company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.licenses l where l.company_id = p_company and l.status = 'activa')
      or exists (select 1 from public.sucursales s
                   join public.license_activations a on a.machine_id = s.license_machine_id and a.active
                   join public.licenses l on l.id = a.license_id and l.status = 'activa'
                  where s.negocio_id = p_company)
      or exists (select 1 from public.sucursales s
                   join public.device_trials t on t.machine_id = s.license_machine_id
                  where s.negocio_id = p_company and t.expires_at > now());
$$;

/*
 * La caja principal de otra empresa escribe el código y su empresa entra al
 * grupo. Las DOS empresas necesitan licencia o prueba: un grupo no sirve para
 * operar una empresa que no paga a través de otra que sí.
 */
create or replace function public.grupo_unir(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices; c public.company_group_codes%rowtype; v_mio uuid;
begin
  d := public.wx_grupo_caja(p);
  if d.id is null then return jsonb_build_object('ok', false, 'code', 'NOT_PRIMARY'); end if;
  select * into c from public.company_group_codes
   where code_hash = public.wx_codigo_hash(p->>'code') and used_at is null and expires_at > now()
   for update;
  if not found then
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'GROUP_JOIN', 'BAD_CODE', '{}');
    return jsonb_build_object('ok', false, 'code', 'BAD_CODE');
  end if;
  if c.company_id = d.company_id then return jsonb_build_object('ok', false, 'code', 'SAME_COMPANY'); end if;
  if not public.wx_empresa_con_licencia(d.company_id) or not public.wx_empresa_con_licencia(c.company_id) then
    perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'GROUP_JOIN', 'NO_LICENSE', jsonb_build_object('group_id', c.group_id));
    return jsonb_build_object('ok', false, 'code', 'NO_LICENSE');
  end if;

  v_mio := public.wx_grupo_de(d.company_id);
  if v_mio = c.group_id then
    update public.company_group_codes set used_at = now(), used_by_company = d.company_id where id = c.id;
    return jsonb_build_object('ok', true, 'group_id', c.group_id, 'ya_estaba', true);
  end if;
  if v_mio is not null then
    if (select count(*) from public.company_group_members where group_id = v_mio) > 1 then
      return jsonb_build_object('ok', false, 'code', 'IN_OTHER_GROUP');
    end if;
    delete from public.company_group_members where company_id = d.company_id;
    delete from public.company_groups where id = v_mio;
  end if;

  insert into public.company_group_members (company_id, group_id, joined_by_device) values (d.company_id, c.group_id, d.id);
  update public.company_group_codes set used_at = now(), used_by_company = d.company_id where id = c.id;
  perform public.wx_audit('DEVICE', d.id::text, d.company_id, 'GROUP_JOIN', 'OK', jsonb_build_object('group_id', c.group_id));
  return jsonb_build_object('ok', true, 'group_id', c.group_id, 'ya_estaba', false);
end $$;

revoke all on function public.wx_empresa_con_licencia(uuid) from public, anon, authenticated;

commit;
