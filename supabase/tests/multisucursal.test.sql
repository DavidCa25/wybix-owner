begin;
do $$
declare c uuid := gen_random_uuid(); m uuid := gen_random_uuid(); n uuid := gen_random_uuid(); x uuid := gen_random_uuid();
        dm uuid := gen_random_uuid(); dn uuid := gen_random_uuid(); dx uuid := gen_random_uuid();
        lic uuid := gen_random_uuid(); r jsonb; t uuid := gen_random_uuid(); prod uuid := gen_random_uuid();
        cat jsonb := jsonb_build_object('products', jsonb_build_array(jsonb_build_object('uuid', gen_random_uuid(), 'nombre', 'Dona glaseada', 'price', '25.00')));
begin
  -- Una empresa con dos sucursales (Matriz y Norte) y una ajena.
  insert into public.negocios (id, nombre) values (c, 'QA Multi'), (gen_random_uuid(), 'QA Ajena');
  insert into public.sucursales (id, negocio_id, nombre, device_key, created_at) values
    (m, c, 'Matriz', 'qa-multi-m-' || m, now() - interval '2 days'),
    (n, c, 'Norte', 'qa-multi-n-' || n, now() - interval '1 day');
  insert into public.sucursales (id, negocio_id, nombre, device_key) select x, id, 'Otra', 'qa-multi-x-' || x from public.negocios where nombre = 'QA Ajena' limit 1;
  insert into public.devices (id, company_id, location_id, kind) values (dm, c, m, 'POS_PRIMARY'), (dn, c, n, 'POS_PRIMARY');
  insert into public.devices (id, company_id, location_id, kind) select dx, negocio_id, x, 'POS_PRIMARY' from public.sucursales where id = x;

  -- Sin el complemento: se informa, pero no se publica ni se traspasa.
  r := public.multi_estado(jsonb_build_object('device_id', dm));
  if (r->>'multisucursal')::boolean or not (r->>'es_matriz')::boolean then raise exception 'Estado sin licencia: %', r; end if;
  if public.multi_publicar(jsonb_build_object('device_id', dm, 'catalog', cat))->>'code' <> 'NO_ENTITLEMENT_MULTIBRANCH' then raise exception 'Publicó sin MultiSucursal'; end if;

  insert into public.licenses (id, license_key, plan, customer_name, company_id, addons) values (lic, 'QA-MULTI-' || lic, 'multi', 'QA Multi', c, array['MULTIBRANCH']);

  -- La matriz por omisión es la más antigua; Norte no publica.
  if public.multi_publicar(jsonb_build_object('device_id', dn, 'catalog', cat))->>'code' <> 'NOT_MATRIZ' then raise exception 'Una sucursal publicó'; end if;
  r := public.multi_publicar(jsonb_build_object('device_id', dm, 'catalog', cat));
  if (r->>'version')::int <> 1 then raise exception 'Primera versión: %', r; end if;
  if (public.multi_publicar(jsonb_build_object('device_id', dm, 'catalog', cat))->>'version')::int <> 1 then raise exception 'Misma huella creó versión'; end if;
  if public.multi_publicar(jsonb_build_object('device_id', dm))->>'code' <> 'BAD_REQUEST' then raise exception 'Publicó sin catálogo'; end if;

  -- Norte recibe la versión y sus excepciones solo cuando cambian.
  r := public.multi_recibir(jsonb_build_object('device_id', dn, 'version', 0));
  if r->'catalog'->'products'->0->>'nombre' <> 'Dona glaseada' then raise exception 'Norte no recibió el catálogo: %', r; end if;
  if public.multi_recibir(jsonb_build_object('device_id', dn, 'version', 1, 'overrides_revision', (r->>'overrides_revision')::int)) ? 'catalog'
     and public.multi_recibir(jsonb_build_object('device_id', dn, 'version', 1, 'overrides_revision', (r->>'overrides_revision')::int))->'catalog' <> 'null'::jsonb then
    raise exception 'Mandó otra vez la misma versión'; end if;

  if public.multi_excepciones(jsonb_build_object('device_id', dn, 'location_id', n, 'items', '[]'::jsonb))->>'code' <> 'NOT_MATRIZ' then raise exception 'Norte fijó excepciones'; end if;
  if public.multi_excepciones(jsonb_build_object('device_id', dm, 'location_id', x, 'items', '[]'::jsonb))->>'code' <> 'NOT_FOUND' then raise exception 'Excepciones en sucursal ajena'; end if;
  r := public.multi_excepciones(jsonb_build_object('device_id', dm, 'location_id', n, 'items', jsonb_build_array(
         jsonb_build_object('product_uuid', prod, 'price', '29.00', 'available', true),
         jsonb_build_object('product_uuid', gen_random_uuid(), 'price', '', 'available', true))));
  if (r->>'n')::int <> 1 then raise exception 'Una excepción vacía se guardó: %', r; end if;
  r := public.multi_recibir(jsonb_build_object('device_id', dn, 'version', 1, 'overrides_revision', 0));
  if (r->'overrides'->0->>'price')::numeric <> 29 then raise exception 'Norte no recibió su precio: %', r; end if;

  -- Reglas de la empresa.
  perform public.multi_excepciones(jsonb_build_object('device_id', dm, 'reglas', jsonb_build_object('precios_sucursal', true, 'productos_locales', false)));
  if not (public.multi_recibir(jsonb_build_object('device_id', dn))->'reglas'->>'precios_sucursal')::boolean then raise exception 'Reglas no viajaron'; end if;

  -- Traspaso Matriz -> Norte: enviar, idempotencia, recibir; ajena no entra.
  r := public.multi_traspaso_enviar(jsonb_build_object('device_id', dm, 'id', t, 'to_location_id', n,
         'lines', jsonb_build_array(jsonb_build_object('product_uuid', prod, 'nombre', 'Dona glaseada', 'qty', 12))));
  if r->>'status' <> 'SENT' then raise exception 'No se envió: %', r; end if;
  if public.multi_traspaso_enviar(jsonb_build_object('device_id', dm, 'id', t, 'to_location_id', n,
         'lines', jsonb_build_array(jsonb_build_object('product_uuid', prod, 'nombre', 'Dona glaseada', 'qty', 12))))->>'status' <> 'SENT' then raise exception 'Reintento no idempotente'; end if;
  if public.multi_traspaso_enviar(jsonb_build_object('device_id', dm, 'id', t, 'to_location_id', n,
         'lines', jsonb_build_array(jsonb_build_object('product_uuid', prod, 'nombre', 'Dona glaseada', 'qty', 99))))->>'code' <> 'CONFLICT' then raise exception 'Mismo id, otro contenido'; end if;
  if public.multi_traspaso_enviar(jsonb_build_object('device_id', dm, 'id', gen_random_uuid(), 'to_location_id', x,
         'lines', jsonb_build_array(jsonb_build_object('product_uuid', prod, 'qty', 1))))->>'code' <> 'NOT_FOUND' then raise exception 'Traspaso a otra empresa'; end if;
  if public.multi_traspaso_enviar(jsonb_build_object('device_id', dm, 'id', gen_random_uuid(), 'to_location_id', n, 'lines', '[]'::jsonb))->>'code' <> 'BAD_REQUEST' then raise exception 'Traspaso vacío'; end if;
  if jsonb_array_length(public.multi_traspaso_bandeja(jsonb_build_object('device_id', dn))->'entrantes') <> 1 then raise exception 'Norte no ve el envío'; end if;
  if public.multi_traspaso_recibir(jsonb_build_object('device_id', dx, 'id', t, 'received_lines', '[]'::jsonb))->>'code' <> 'DENIED'
     and public.multi_traspaso_recibir(jsonb_build_object('device_id', dx, 'id', t, 'received_lines', '[]'::jsonb))->>'code' <> 'NOT_FOUND' then raise exception 'Otra empresa recibió'; end if;
  r := public.multi_traspaso_recibir(jsonb_build_object('device_id', dn, 'id', t, 'received_by_name', 'lupita',
         'received_lines', jsonb_build_array(jsonb_build_object('product_uuid', prod, 'qty', 11))));
  if r->>'status' <> 'RECEIVED' then raise exception 'No se recibió: %', r; end if;
  if public.multi_traspaso_cancelar(jsonb_build_object('device_id', dm, 'id', t))->>'code' <> 'ALREADY_RECEIVED' then raise exception 'Se canceló lo recibido'; end if;
  r := public.multi_traspaso_bandeja(jsonb_build_object('device_id', dm));
  if r->'enviados'->0->>'status' <> 'RECEIVED' or (r->'enviados'->0->'received_lines'->0->>'qty')::numeric <> 11 then raise exception 'Matriz no ve lo que llegó: %', r; end if;

  -- El dueño cambia la matriz: ahora publica Norte.
  perform set_config('request.jwt.claims', '{}', true);
  update public.negocios set matriz_location_id = n where id = c;
  if not (public.multi_estado(jsonb_build_object('device_id', dn))->>'es_matriz')::boolean then raise exception 'Cambio de matriz'; end if;
  if public.multi_publicar(jsonb_build_object('device_id', dm, 'catalog', cat))->>'code' <> 'NOT_MATRIZ' then raise exception 'La matriz anterior siguió publicando'; end if;

  -- Nadie fuera del backend llama las funciones de equipo.
  if has_function_privilege('anon', 'public.multi_publicar(jsonb)', 'EXECUTE') or has_function_privilege('authenticated', 'public.multi_traspaso_enviar(jsonb)', 'EXECUTE') then
    raise exception 'Funciones de equipo públicas'; end if;
  raise notice 'MULTISUCURSAL_OK: licencia, matriz, publicación, excepciones, reglas, traspasos y permisos';
end $$;
rollback;
