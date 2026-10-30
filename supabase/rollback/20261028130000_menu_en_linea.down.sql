-- Reversa de 20261028130000_menu_en_linea.sql. Borra los pedidos en línea y
-- el menú publicado: la caja los vuelve a publicar al reactivar.
begin;
drop function if exists public.menu_pedido_estado(jsonb), public.menu_pedido_crear(jsonb), public.menu_imagen_publica(jsonb),
  public.menu_publico(jsonb), public.menu_bandeja(jsonb), public.menu_imagen(jsonb), public.menu_publicar(jsonb),
  public.wx_menu_estado_cliente(public.menu_pedidos), public.wx_menu_abierto(public.menu_publicaciones), public.wx_menu_caja(jsonb);
drop table if exists public.menu_pedidos, public.menu_imagenes, public.menu_publicaciones;
commit;
