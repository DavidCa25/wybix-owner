/** Fixture: la Feria León 2026 de I Do Nut, con catálogo, personal y una transferencia. */
import { DatabaseSync } from 'node:sqlite';
import { hashPin } from '@wybix/auth';
import { adaptadorNode, migrar, guardarEnrolamiento, aplicarSnapshot, crearPos, type Snapshot } from '../src/index.ts';

export const U = {
  company: '11111111-1111-4111-8111-111111111111',
  centro: '22222222-2222-4222-8222-222222222222',
  feria: '33333333-3333-4333-8333-333333333333',
  register: '44444444-4444-4444-8444-444444444444',
  dona: 'aaaaaaaa-0000-4000-8000-000000000001',
  cafe: 'aaaaaaaa-0000-4000-8000-000000000002',
  leche: 'aaaaaaaa-0000-4000-8000-000000000003',
  grano: 'aaaaaaaa-0000-4000-8000-000000000004',
  vieja: 'aaaaaaaa-0000-4000-8000-000000000005',
  rcafe: 'bbbbbbbb-0000-4000-8000-000000000001',
  lupita: 'cccccccc-0000-4000-8000-000000000001',
  marta: 'cccccccc-0000-4000-8000-000000000002',
  transfer: 'dddddddd-0000-4000-8000-000000000001',
};

const SAL_L = '0123456789abcdef0123456789abcdef';
const SAL_M = 'fedcba9876543210fedcba9876543210';
export const PIN = { lupita: '4821', marta: '7305' };

export function catalogo(version: number, cambios: { precioDona?: string; desactivarVieja?: boolean } = {}) {
  return {
    catalog_version: version,
    products: [
      { uuid: U.dona, nombre: 'Dona glaseada', price: cambios.precioDona ?? '25.00', cost: '6.5000', inventory_mode: 'DIRECT' as const, sellable: true, active: true, modifier_groups: [] },
      { uuid: U.cafe, nombre: 'Café de olla', price: '35.00', cost: null, inventory_mode: 'RECIPE' as const, sellable: true, active: true, modifier_groups: [] },
      { uuid: U.leche, nombre: 'Leche', price: '0', cost: '0.0250', inventory_mode: 'DIRECT' as const, sellable: false, active: true, modifier_groups: [] },
      { uuid: U.grano, nombre: 'Grano', price: '0', cost: '0.4000', inventory_mode: 'DIRECT' as const, sellable: false, active: true, modifier_groups: [] },
      { uuid: U.vieja, nombre: 'Dona de temporada', price: '30.00', cost: '7', inventory_mode: 'DIRECT' as const, sellable: true, active: !cambios.desactivarVieja, modifier_groups: [] },
    ],
    recipes: [{ uuid: U.rcafe, product_uuid: U.cafe, variant_option_uuid: null, active: true, lines: [
      { ingredient_uuid: U.grano, qty_base: '18.0000', waste_pct: '0' }, { ingredient_uuid: U.leche, qty_base: '200.0000', waste_pct: '0' }] }],
    modifier_groups: [],
  };
}

export function snapshot(o: { snapshot_version?: number; catalog?: ReturnType<typeof catalogo>; security_revision?: number; company?: string; location?: string } = {}): Snapshot {
  return {
    snapshot_version: o.snapshot_version ?? 1,
    security_revision: o.security_revision ?? 1,
    device: { id: 'dev-1', uuid: 'tablet-1', status: 'ACTIVE' },
    company: { uuid: o.company ?? U.company, nombre: 'I Do Nut' },
    location: { uuid: o.location ?? U.feria, nombre: 'Feria León 2026', tipo: 'EVENT', timezone: 'America/Mexico_City', status: 'ACTIVE', event_status: 'OPEN',
                home_location_uuid: U.centro, starts_at: '2026-11-01', ends_at: '2026-11-10' },
    register: { uuid: U.register, code: 'F1', name: 'Caja Feria 1' },
    catalog: o.catalog ?? catalogo(1),
    staff: [
      { uuid: U.lupita, name: 'lupita', role: 'CASHIER', pin_hash: hashPin(PIN.lupita, SAL_L), pin_sal: SAL_L, pin_algo: 'scrypt:16384:8:1:32', active: true },
      { uuid: U.marta, name: 'marta', role: 'SUPERVISOR', pin_hash: hashPin(PIN.marta, SAL_M), pin_sal: SAL_M, pin_algo: 'scrypt:16384:8:1:32', active: true },
    ],
    payment_methods: [{ code: 'EFECTIVO', label: 'Efectivo', enabled: true }, { code: 'TARJETA', label: 'Tarjeta', enabled: true }, { code: 'TRANSFERENCIA', label: 'Transferencia', enabled: true }],
    trusted_keys: [],
    transfers: [{ transfer_uuid: U.transfer, from_location_uuid: U.centro, to_location_uuid: U.feria, status: 'SENT',
                  lines: [{ product_uuid: U.dona, product_name: 'Dona glaseada', qty_sent: '40.00' }, { product_uuid: U.leche, product_name: 'Leche', qty_sent: '5000.00' }, { product_uuid: U.grano, product_name: 'Grano', qty_sent: '1000.00' }] }],
    releases: { latest_version: '0.1.0', min_supported_version: '0.1.0' },
  };
}

/** Base nueva (archivo o memoria), migrada, enrolada y con snapshot. */
export async function base(archivo = ':memory:', reloj?: () => Date) {
  const raw = new DatabaseSync(archivo);
  const db = adaptadorNode(raw);
  await migrar(db);
  await guardarEnrolamiento(db, { device_uuid: 'tablet-1', device_id: 'dev-1' });
  await aplicarSnapshot(db, snapshot());
  const pos = crearPos(db, reloj ? { ahora: reloj } : undefined);
  return { raw, db, pos };
}

export const lupita = { uuid: U.lupita, name: 'lupita', role: 'CASHIER' as const };
export const marta = { uuid: U.marta, name: 'marta', role: 'SUPERVISOR' as const };
