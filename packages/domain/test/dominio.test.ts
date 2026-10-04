import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dec, D } from '../src/decimal.ts';
import { indexar, vendibles, type Catalogo } from '../src/catalogo.ts';
import { congelarLinea, cobrar, totalDe, folio, ErrorVenta } from '../src/venta.ts';
import { proyectarStock, diferenciaTransferencia, validarMovimiento } from '../src/inventario.ts';
import { corte, efectivoEsperado } from '../src/caja.ts';
import { puede, corteCiego } from '../src/permisos.ts';
import { uuidv7, esUuid } from '../src/uuid.ts';

test('decimal exacto: 0.1 + 0.2 = 0.3 (no 0.30000000000000004)', () => {
  assert.equal(D('0.1').mas('0.2').toString(), '0.3');
  assert.equal(D('19.99').por(3).fijo(2), '59.97');
});

test('redondeo como CAST de SQL Server: mitad lejos del cero', () => {
  assert.equal(D('2.345').redondear(2).fijo(2), '2.35');
  assert.equal(D('-2.345').redondear(2).fijo(2), '-2.35');
  assert.equal(D('2.3449999').redondear(2).fijo(2), '2.34');
  assert.equal(D('1.00005').redondear(4).fijo(4), '1.0001');
});

const cat: Catalogo = {
  catalog_version: 7,
  products: [
    { uuid: 'dona', nombre: 'Dona glaseada', price: '25.00', cost: '6.5000', inventory_mode: 'DIRECT', sellable: true, active: true, modifier_groups: ['extras'] },
    { uuid: 'cafe', nombre: 'Café', price: '40.00', cost: null, inventory_mode: 'RECIPE', sellable: true, active: true, modifier_groups: ['tam', 'leche', 'extras'] },
    { uuid: 'botella', nombre: 'Agua', price: '15.00', cost: '4.2000', inventory_mode: 'NONE', sellable: true, active: true },
    { uuid: 'vieja', nombre: 'Dona descontinuada', price: '20.00', cost: '5', inventory_mode: 'DIRECT', sellable: true, active: false },
    { uuid: 'leche', nombre: 'Leche', price: '0', cost: '0.0250', inventory_mode: 'DIRECT', sellable: false, active: true },
    { uuid: 'almendra', nombre: 'Leche almendra', price: '0', cost: '0.0600', inventory_mode: 'DIRECT', sellable: false, active: true },
    { uuid: 'grano', nombre: 'Café en grano', price: '0', cost: '0.4000', inventory_mode: 'DIRECT', sellable: false, active: true },
    { uuid: 'azucar', nombre: 'Azúcar', price: '0', cost: '0.0100', inventory_mode: 'DIRECT', sellable: false, active: true },
    { uuid: 'chispas', nombre: 'Chispas', price: '0', cost: '0.1500', inventory_mode: 'DIRECT', sellable: false, active: true },
  ],
  recipes: [
    { uuid: 'r-base', product_uuid: 'cafe', variant_option_uuid: null, active: true, lines: [
      { ingredient_uuid: 'grano', qty_base: '18.0000', waste_pct: '2.00' },
      { ingredient_uuid: 'leche', qty_base: '240.0000', waste_pct: '0' },
      { ingredient_uuid: 'azucar', qty_base: '10.0000', waste_pct: '0' } ] },
    { uuid: 'r-grande', product_uuid: 'cafe', variant_option_uuid: 'op-grande', active: true, lines: [
      { ingredient_uuid: 'grano', qty_base: '27.0000', waste_pct: '2.00' },
      { ingredient_uuid: 'leche', qty_base: '360.0000', waste_pct: '0' } ] },
  ],
  modifier_groups: [
    { uuid: 'tam', name: 'Tamaño', role: 'SIZE', min_select: 0, max_select: 1, required: false, active: true, options: [
      { uuid: 'op-grande', name: 'Grande', price_delta: '10.00', effect: 'NONE', ingredient_uuid: null, replaces_uuid: null, qty_base: null, qty_factor: null, active: true },
      { uuid: 'op-doble', name: 'Doble', price_delta: '8.00', effect: 'SCALE', ingredient_uuid: null, replaces_uuid: null, qty_base: null, qty_factor: '1.5000', active: true } ] },
    { uuid: 'leche', name: 'Leche', role: 'SUBSTITUTION', min_select: 0, max_select: 2, required: false, active: true, options: [
      { uuid: 'op-almendra', name: 'Almendra', price_delta: '7.50', effect: 'SUBSTITUTE', ingredient_uuid: 'almendra', replaces_uuid: 'leche', qty_base: null, qty_factor: null, active: true },
      { uuid: 'op-sin-azucar', name: 'Sin azúcar', price_delta: '0', effect: 'REMOVE', ingredient_uuid: null, replaces_uuid: 'azucar', qty_base: null, qty_factor: null, active: true } ] },
    { uuid: 'extras', name: 'Extras', role: 'ADDON', min_select: 0, max_select: 3, required: false, active: true, options: [
      { uuid: 'op-chispas', name: 'Chispas', price_delta: '5.00', effect: 'ADD', ingredient_uuid: 'chispas', replaces_uuid: null, qty_base: '12.0000', qty_factor: null, active: true } ] },
  ],
};
const ix = indexar(cat);

test('DIRECT: precio, costo y consumo de sí mismo', () => {
  const l = congelarLinea(ix, { product_uuid: 'dona', quantity: 3 }, 1);
  assert.equal(l.unit_price, '25.00');
  assert.equal(l.unit_cost, '6.5000');
  assert.deepEqual(l.consumos.map((c) => [c.product_uuid, c.quantity, c.source]), [['dona', '3.00', 'SALE']]);
});

test('RECIPE base con merma, sustitución, remoción y extra', () => {
  const l = congelarLinea(ix, { product_uuid: 'cafe', quantity: 2, options: [
    { option_uuid: 'op-almendra' }, { option_uuid: 'op-sin-azucar' }, { option_uuid: 'op-chispas', qty: 2 } ] }, 1);
  assert.equal(l.unit_price, '57.50');   // 40 + 7.50 + 2 x 5
  const c = Object.fromEntries(l.consumos.map((x) => [x.product_uuid, x]));
  assert.equal(c.grano.qty_per_unit, '18.360000');     // 18 x 1.02
  assert.equal(c.almendra.qty_per_unit, '240.000000'); // sustituye a leche con la misma cantidad
  assert.equal(c.azucar, undefined);                    // sin azúcar
  assert.equal(c.chispas.qty_per_unit, '24.000000');   // 12 x 2, no escala
  // costo = 18.36x0.40 + 240x0.06 + 24x0.15 = 7.344 + 14.4 + 3.6
  assert.equal(l.unit_cost, '25.3440');
  assert.equal(c.grano.quantity, '36.72');
});

test('la receta del tamaño gana a la base y SCALE no se aplica sobre ella', () => {
  const g = congelarLinea(ix, { product_uuid: 'cafe', quantity: 1, options: [{ option_uuid: 'op-grande' }] }, 1);
  assert.equal(g.recipe_uuid, 'r-grande');
  assert.equal(g.variant_option_uuid, 'op-grande');
  assert.equal(g.consumos.find((c) => c.product_uuid === 'grano')!.qty_per_unit, '27.540000');
  const d = congelarLinea(ix, { product_uuid: 'cafe', quantity: 1, options: [{ option_uuid: 'op-doble' }] }, 1);
  assert.equal(d.recipe_uuid, 'r-base');
  assert.equal(d.consumos.find((c) => c.product_uuid === 'grano')!.qty_per_unit, '27.540000'); // 18 x 1.02 x 1.5
});

test('NONE: costo propio, sin consumo', () => {
  const l = congelarLinea(ix, { product_uuid: 'botella', quantity: 1 }, 1);
  assert.equal(l.unit_cost, '4.2000');
  assert.equal(l.consumos.length, 0);
});

test('validaciones con los mismos mensajes que SQL Server', () => {
  assert.throws(() => congelarLinea(ix, { product_uuid: 'vieja', quantity: 1 }, 1), (e: ErrorVenta) => e.code === 'PRODUCTO_NO_VENDIBLE');
  assert.throws(() => congelarLinea(ix, { product_uuid: 'dona', quantity: 1, options: [{ option_uuid: 'op-almendra' }] }, 1),
    /no corresponde al producto/);
  assert.throws(() => congelarLinea(ix, { product_uuid: 'dona', quantity: 1.5 }, 1), /por pieza/);
});

test('producto desactivado desaparece de lo vendible en la versión nueva', () => {
  assert.ok(!vendibles(cat).some((p) => p.uuid === 'vieja'));
});

test('cobro: efectivo da cambio y entra a caja; tarjeta no toca la caja', () => {
  const c = cobrar('100.00', [{ method: 'EFECTIVO', amount: '60.00', received: '100.00' }, { method: 'TARJETA', amount: '40.00' }]);
  assert.equal(c.cambio, '40.00');
  assert.equal(c.efectivo_neto, '60.00');
  assert.throws(() => cobrar('100.00', [{ method: 'TARJETA', amount: '90.00' }]), /suman 90.00/);
  assert.throws(() => cobrar('50.00', [{ method: 'EFECTIVO', amount: '50.00', received: '20.00' }]), /no alcanza/);
});

test('total como SQL: suma exacta y un solo redondeo', () => {
  const l1 = congelarLinea(ix, { product_uuid: 'dona', quantity: 3 }, 1);
  const l2 = congelarLinea(ix, { product_uuid: 'botella', quantity: 1 }, 2);
  assert.equal(totalDe([l1, l2]), '90.00');
  assert.equal(folio('F1', 123), 'F1-000123');
});

test('ledger: Centro 100 → envía 40 → feria vende 32 → regresa 8 → Centro 68', () => {
  const centro = proyectarStock([
    { product_uuid: 'A', type: 'ADJUSTMENT', quantity: '100' },
    { product_uuid: 'A', type: 'TRANSFER_OUT', quantity: '40' },
    { product_uuid: 'A', type: 'RETURN_TRANSFER_IN', quantity: '8' }]);
  const feria = proyectarStock([
    { product_uuid: 'A', type: 'TRANSFER_IN', quantity: '40' },
    ...Array.from({ length: 32 }, () => ({ product_uuid: 'A', type: 'SALE' as const, quantity: '1' })),
    { product_uuid: 'A', type: 'RETURN_TRANSFER_OUT', quantity: '8' }]);
  assert.equal(centro.get('A')!.fijo(0), '68');
  assert.equal(feria.get('A')!.fijo(0), '0');
  assert.deepEqual(diferenciaTransferencia('40', '39'), { sent: '40.00', received: '39.00', difference: '1.00' });
  assert.throws(() => validarMovimiento({ product_uuid: 'A', type: 'TRANSFER_OUT', quantity: '1' }, 'EVENT'), /no corresponde/);
});

test('corte: solo el efectivo cuenta para el esperado', () => {
  const movs = [{ type: 'OPENING' as const, amount: '500' }, { type: 'SALE_CASH' as const, amount: '60' }, { type: 'CASH_OUT' as const, amount: '100' }];
  assert.equal(efectivoEsperado(movs).fijo(2), '460.00');
  assert.deepEqual(corte(movs, '455'), { expected: '460.00', counted: '455.00', difference: '-5.00' });
});

test('permisos por rol en el EVENT', () => {
  assert.ok(puede('CASHIER', 'VENDER') && !puede('CASHIER', 'MERMA') && corteCiego('CASHIER'));
  assert.ok(puede('SUPERVISOR', 'MERMA') && !corteCiego('SUPERVISOR'));
  assert.ok(!puede(null, 'VENDER'));
});

test('UUIDv7 válido y único aunque el reloj esté mal', () => {
  const a = uuidv7(0), b = uuidv7(0);
  assert.ok(esUuid(a) && a[14] === '7' && a !== b);
});
