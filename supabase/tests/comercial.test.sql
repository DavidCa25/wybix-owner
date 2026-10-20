begin;
do $$
declare d public.devices; loc public.sucursales; f public.sales_facts; ev jsonb; marker jsonb := '{"channel":"QA_COMERCIAL","version":7,"discount":"5.00"}';
begin
 if has_function_privilege('anon','public.wx_proyectar_f2(public.devices,public.sucursales,jsonb,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.wx_proyectar_f2(public.devices,public.sucursales,jsonb,uuid)','EXECUTE') then
    raise exception 'El proyector no debe ser un RPC público'; end if;
 select * into f from public.sales_facts limit 1;
 if f.sale_uuid is null then raise exception 'Falta fixture de ventas'; end if;
 select * into d from public.devices where company_id=f.company_id and location_id=f.location_id limit 1;
 if d.id is null then raise exception 'Falta fixture de dispositivo'; end if;
 select * into loc from public.sucursales where id=d.location_id;
 ev:=jsonb_build_object('aggregate_type','SALE','event_type','SALE_RECORDED','aggregate_uuid',f.sale_uuid,'occurred_at',now(),
   'payload',jsonb_build_object('commercial',marker,'catalog_version',7,'lines',jsonb_build_array(jsonb_build_object('line_no',90001,'product_uuid',gen_random_uuid(),'product_name','QA comercial','quantity','1.00','unit_price','25.00','unit_cost','5.00','commercial',marker))));
 perform public.wx_proyectar_f2(d,loc,ev,gen_random_uuid());
 if (select commercial_snapshot from public.sales_facts where sale_uuid=f.sale_uuid)<>marker then raise exception 'La venta perdió su política';end if;
 if (select commercial_snapshot from public.sale_line_facts where sale_uuid=f.sale_uuid and line_no=90001)<>marker then raise exception 'La partida perdió su descuento';end if;
 perform public.wx_proyectar_f2(d,loc,ev,gen_random_uuid());
 if (select count(*) from public.sale_line_facts where sale_uuid=f.sale_uuid and line_no=90001)<>1 then raise exception 'Se duplicó el reintento';end if;
 raise notice 'COMERCIAL_NUBE_OK: snapshot, partidas, reintento y permisos';
end $$;
do $$
declare f public.sales_facts; member uuid; result jsonb; d public.devices; loc public.sucursales; publication bigint;
begin
 if has_function_privilege('anon','public.commercial_sales_summary(uuid,date)','EXECUTE') then raise exception 'Reporte accesible a anon';end if;
 select * into f from public.sales_facts limit 1;
 select user_id into member from public.company_memberships where company_id=f.company_id and status='ACTIVE' and (location_ids is null or f.location_id=any(location_ids)) limit 1;
 if member is null then raise exception 'Falta membresía QA';end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',member)::text,true);
 set local role authenticated;
 result:=public.commercial_sales_summary(f.location_id,f.business_date);
 if jsonb_array_length(result->'channels')=0 then raise exception 'Reporte vacío';end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid())::text,true);
 begin perform public.commercial_sales_summary(f.location_id,f.business_date);raise exception 'Se permitió otra empresa';exception when insufficient_privilege then null;end;
 reset role;
 select x.* into d from public.devices x join public.sucursales s on s.id=x.location_id where x.status='ACTIVE' and x.kind='MOBILE_POS' and exists(select 1 from public.catalog_publications p where p.location_id=s.home_location_id) limit 1;
 if d.id is null then raise exception 'Falta tablet QA';end if;
 select * into loc from public.sucursales where id=d.location_id;
 select id into publication from public.catalog_publications where location_id=loc.home_location_id order by version desc limit 1;
 update public.catalog_publications set payload=jsonb_set(payload,'{commercial}','{"version":1,"channels":[{"id":"LOCAL","name":"Mostrador","active":true,"inheritBase":true},{"id":"QA","name":"Plataforma QA","active":true,"inheritBase":true}],"promotions":[],"prices":[],"combos":[]}') where id=publication;
 if public.mobile_snapshot(jsonb_build_object('device_id',d.id))->>'code'<>'UPDATE_REQUIRED' then raise exception 'Cliente antiguo recibió nuevas reglas';end if;
 result:=public.mobile_snapshot(jsonb_build_object('device_id',d.id,'commercial_schema',1));
 if result->>'ok'<>'true' or result#>>'{catalog,commercial,version}'<>'1' then raise exception 'Cliente comercial no recibió catálogo';end if;
 raise notice 'COMERCIAL_COMPAT_REPORT_OK: membresía, separación de empresas y versiones';
end $$;
do $$
declare d public.devices; loc public.sucursales; publication bigint; result jsonb; k uuid:=gen_random_uuid();
begin
 select x.* into d from public.devices x join public.sucursales s on s.id=x.location_id where x.status='ACTIVE' and x.kind='MOBILE_POS' and exists(select 1 from public.catalog_publications p where p.location_id=s.home_location_id) limit 1;
 select * into loc from public.sucursales where id=d.location_id;
 select id into publication from public.catalog_publications where location_id=loc.home_location_id order by version desc limit 1;
 update public.catalog_publications set payload=jsonb_set(payload,'{commercial}','{"version":2,"channels":[{"id":"LOCAL","name":"Mostrador","active":true,"inheritBase":true}],"promotions":[{"id":"MAYOREO","name":"Mayoreo","active":true,"priority":1,"kind":"VOLUME","minimumQty":6,"selector":{}}],"prices":[],"combos":[]}') where id=publication;
 if public.mobile_snapshot(jsonb_build_object('device_id',d.id,'commercial_schema',1))->>'code'<>'UPDATE_REQUIRED' then raise exception 'Tablet sin mayoreo recibió reglas de mayoreo';end if;
 result:=public.mobile_snapshot(jsonb_build_object('device_id',d.id,'commercial_schema',2));
 if result->>'ok'<>'true' then raise exception 'Tablet con mayoreo no recibió catálogo: %',result;end if;
 if has_function_privilege('anon','public.ticket_mail_reserve(jsonb)','EXECUTE') or has_function_privilege('authenticated','public.ticket_mail_reserve(jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.ticket_mail_complete(jsonb)','EXECUTE') then raise exception 'El correo de ticket no debe ser un RPC público';end if;
 if public.ticket_mail_reserve(jsonb_build_object('device_id',gen_random_uuid(),'id',k,'fingerprint','f1'))->>'code'<>'DENIED' then raise exception 'Equipo desconocido reservó un correo';end if;
 result:=public.ticket_mail_reserve(jsonb_build_object('device_id',d.id,'id',k,'fingerprint','f1'));
 if result->>'ok'<>'true' or result->>'sent'<>'false' then raise exception 'No se reservó el correo: %',result;end if;
 if public.ticket_mail_reserve(jsonb_build_object('device_id',d.id,'id',k,'fingerprint','f1'))->>'code'<>'BUSY' then raise exception 'Un reintento inmediato duplicó el envío';end if;
 if public.ticket_mail_reserve(jsonb_build_object('device_id',d.id,'id',k,'fingerprint','f2'))->>'code'<>'CONFLICT' then raise exception 'La misma solicitud cambió de contenido';end if;
 if public.ticket_mail_complete(jsonb_build_object('device_id',d.id,'id',k,'provider_id','qa'))->>'ok'<>'true' then raise exception 'No se marcó como enviado';end if;
 if public.ticket_mail_reserve(jsonb_build_object('device_id',d.id,'id',k,'fingerprint','f1'))->>'sent'<>'true' then raise exception 'Un correo enviado se volvería a mandar';end if;
 raise notice 'COMERCIAL_V2_TICKET_OK: compuerta de mayoreo y correo idempotente';
end $$;
rollback;
