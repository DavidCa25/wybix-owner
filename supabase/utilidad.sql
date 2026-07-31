-- Utilidad del día en el tablero de la app del dueño.
-- Agrega la columna "utilidad" a resumen_ventas (ganancia estimada del día).
-- Correr en el SQL Editor de Supabase (proyecto de la app). Es idempotente.

alter table public.resumen_ventas
  add column if not exists utilidad numeric default 0;
