-- Datos de compra en las licencias (para emitir la clave al pagar en el sitio).
-- Correr en el SQL Editor de Supabase. Es idempotente.

alter table public.licenses
  add column if not exists buyer_email     text,
  add column if not exists buyer_name      text,
  add column if not exists negocio         text,
  add column if not exists cajas           int  default 1,
  add column if not exists paypal_order_id text,
  add column if not exists created_at      timestamptz default now();

-- Evita emitir dos licencias para la misma orden de PayPal
create unique index if not exists ux_licenses_paypal_order
  on public.licenses (paypal_order_id)
  where paypal_order_id is not null;
