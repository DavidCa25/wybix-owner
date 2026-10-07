-- SOPORTE: plantilla de creación de licencias sintéticas, NO una migración.
-- Requiere autorización remota y backend Fase 2+. No se ejecuta desde QA automático.
-- Los códigos devueltos se guardan en bóveda, nunca en Git/capturas/evidencia.
begin;
do $$
declare n text; l uuid; g jsonb;
begin
 if to_regprocedure('public.company_entitlements(uuid)') is null or
    not exists(select 1 from public.license_catalog where code='ADDON_MOBILE_POS' and active) then
   raise exception 'Backend Mobile incompleto';
 end if;
 foreach n in array array['Wybix QA Fase 3','Wybix QA Scope B'] loop
   if exists(select 1 from public.licenses where customer_name=n) then
     raise exception 'La licencia QA ya existe: %, no se reemplaza ni duplica',n;
   end if;
   insert into public.licenses(license_key,plan,customer_name,max_registers,status,origin,addons,notes)
   values('QA-'||upper(replace(gen_random_uuid()::text,'-','')),'multi',n,null,'activa','QA',array['MOBILE_POS'],
          'Piloto Fase 3, sin cobro comercial, vigencia QA de 14 días') returning id into l;
   g := public.license_qa_grant(l,jsonb_build_object('edition','multi','verticals',jsonb_build_array('COMMERCE'),
           'screen_tier','BASE','paid_until',now()+interval '14 days'), 'Piloto aislado Fase 3','SOPORTE_QA');
   if not coalesce((g->>'ok')::boolean,false) then
     raise exception 'No se concedieron los permisos QA: %',g->>'code';
   end if;
 end loop;
end $$;
commit;
-- SOLO SOPORTE, salida sensible. No guardar el resultado en evidencia.
select customer_name,id,license_key from public.licenses
where origin='QA' and customer_name in ('Wybix QA Fase 3','Wybix QA Scope B');
