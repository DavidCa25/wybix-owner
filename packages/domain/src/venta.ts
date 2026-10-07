/**
 * LÍNEA DE VENTA CONGELADA y totales, con las reglas de `sp_register_sale`.
 *
 * Una venta móvil guarda en el momento de cobrar, y para siempre:
 *   precio unitario   precio del producto + Σ(price_delta x qty) de sus opciones
 *   costo unitario    DECIMAL(14,4): costo propio si es NONE, más Σ(consumo x costo)
 *   receta efectiva   receta/variante/escala usadas
 *   consumos          por ingrediente: por unidad (18,6) y total del movimiento (12,2)
 *   catalog_version   con qué versión del catálogo se vendió
 *
 * Nada de esto se vuelve a calcular cuando llega un catálogo nuevo: una venta
 * hecha con la versión N vale con la versión N (spike 2.3 y punto 30).
 */
import { Dec } from './decimal.ts';
import type { CatalogoIndexado } from './catalogo.ts';
import { resolverRecetaEfectiva, type OpcionElegida, type Origen } from './receta.ts';

export class ErrorVenta extends Error {
  code: string;
  constructor(code: string, mensaje: string) { super(mensaje); this.code = code; }
}

export interface LineaCarrito { combo?:{id:string;instance:string;group:string}; product_uuid: string; quantity: string | number; options?: OpcionElegida[]; note?: string | null; }

export interface ConsumoCongelado {
  product_uuid: string;
  qty_per_unit: string;     // DECIMAL(18,6)
  quantity: string;         // movimiento de inventario, DECIMAL(12,2)
  origen: Origen;
  source: 'SALE' | 'RECIPE';
  option_uuid: string | null;
  unit_cost: string;        // costo del ingrediente en el catálogo, DECIMAL(14,4)
}

export interface LineaCongelada {
  commercial?:import('./comercial.ts').PrecioResuelto;
  line_no: number;
  product_uuid: string;
  product_name: string;
  quantity: string;          // DECIMAL(12,2)
  unit_price: string;        // DECIMAL(10,2)
  subtotal: string;          // quantity * unit_price, exacto (columna calculada de SQL)
  unit_cost: string;         // DECIMAL(14,4)
  inventory_mode: string;
  recipe_uuid: string | null;
  variant_option_uuid: string | null;
  scale: string;
  modifiers: Array<{ option_uuid: string; group_name: string; option_name: string; price_delta: string; quantity: number; effect: string }>;
  consumos: ConsumoCongelado[];
  note: string | null;
}

/** Valida las opciones de una línea con los mismos mensajes que SQL Server. */
function validarOpciones(cat: CatalogoIndexado, productUuid: string, opciones: OpcionElegida[]) {
  const p = cat.producto.get(productUuid)!;
  const gruposDelProducto = new Set(p.modifier_groups ?? []);
  const porGrupo = new Map<string, Set<string>>();
  for (const o of opciones) {
    const ref = cat.opcion.get(o.option_uuid);
    if (!ref || !ref.opcion.active || !ref.grupo.active) throw new ErrorVenta('MOD_INVALIDO', 'Un modificador no existe o esta inactivo.');
    if ((o.qty ?? 1) <= 0) throw new ErrorVenta('MOD_QTY', 'La cantidad de un modificador debe ser mayor a cero.');
    if (!gruposDelProducto.has(ref.grupo.uuid)) throw new ErrorVenta('MOD_AJENO', 'Un modificador no corresponde al producto de su partida.');
    const s = porGrupo.get(ref.grupo.uuid) ?? new Set();
    s.add(o.option_uuid);
    porGrupo.set(ref.grupo.uuid, s);
  }
  for (const [g, s] of porGrupo) {
    if (s.size > cat.grupo.get(g)!.max_select) throw new ErrorVenta('MOD_MAX', 'Se eligieron mas opciones de las permitidas en un grupo de modificadores.');
  }
  for (const gu of gruposDelProducto) {
    const g = cat.grupo.get(gu);
    if (!g || !g.active || !g.required) continue;
    const min = g.min_select > 0 ? g.min_select : 1;
    if ((porGrupo.get(gu)?.size ?? 0) < min) throw new ErrorVenta('MOD_REQUERIDO', `Falta elegir "${g.name}" para ${p.nombre}.`);
  }
}

export function congelarLinea(cat: CatalogoIndexado, linea: LineaCarrito, lineNo: number): LineaCongelada {
  const p = cat.producto.get(linea.product_uuid);
  if (!p || !p.active || !p.sellable) throw new ErrorVenta('PRODUCTO_NO_VENDIBLE', 'El producto ya no está a la venta.');
  const quantity = Dec.de(linea.quantity).redondear(2);
  if (!quantity.esPositivo()) throw new ErrorVenta('CANTIDAD', 'La cantidad debe ser mayor a cero.');
  if (!p.allow_decimal_qty && quantity.redondear(0).comparar(quantity) !== 0) throw new ErrorVenta('CANTIDAD', 'Este producto se vende por pieza.');
  const opciones = linea.options ?? [];
  validarOpciones(cat, p.uuid, opciones);

  const ef = resolverRecetaEfectiva(cat, p.uuid, opciones);
  if (ef.inventory_mode === 'RECIPE' && !ef.recipe_uuid) {
    const recetas = (cat.recetasDe.get(p.uuid) ?? []).filter((r) => r.active);
    const tamano = ef.opciones.some((o) => o.grupo.role === 'SIZE');
    throw new ErrorVenta('SIN_RECETA', recetas.length === 0
      ? `El producto "${p.nombre}" no tiene receta configurada.`
      : !tamano
        ? `Falta elegir el tamano de "${p.nombre}": su receta depende del tamano y la venta no indico ninguno.`
        : `El tamano elegido para "${p.nombre}" no tiene receta, y el producto no tiene receta base.`);
  }

  // Precio: lo decide el catálogo, nunca la pantalla.
  const delta = Dec.suma(ef.opciones.map((o) => Dec.de(o.opcion.price_delta).por(o.qty)));
  const unitPrice = Dec.de(p.price).mas(delta).redondear(2);

  // Costo de UNA unidad: NONE usa su costo; los demás, Σ consumo x costo del ingrediente.
  const costoDe = (u: string) => Dec.de(cat.producto.get(u)?.cost ?? '0');
  const unitCost = (ef.inventory_mode === 'NONE' ? Dec.de(p.cost ?? '0') : Dec.cero)
    .mas(Dec.suma(ef.requerimientos.map((r) => r.qty_per_unit.por(costoDe(r.product_uuid)))))
    .redondear(4);

  // Movimiento por (línea, ingrediente): SUM(qty_per_unit) x cantidad.
  // SQL Server calcula el producto con 6 decimales (desborde de precisión) y
  // lo guarda en DECIMAL(12,2): se reproducen los dos redondeos.
  const agrupado = new Map<string, { suma: Dec; r: (typeof ef.requerimientos)[number]; source: 'SALE' | 'RECIPE' }>();
  for (const r of ef.requerimientos) {
    const a = agrupado.get(r.product_uuid);
    const source = r.origen === 'DIRECT' ? 'SALE' : 'RECIPE';
    // SQL Server guarda MAX(source): 'SALE' > 'RECIPE', así que si hay mezcla gana SALE.
    if (a) { a.suma = a.suma.mas(r.qty_per_unit); if (source === 'SALE') a.source = 'SALE'; }
    else agrupado.set(r.product_uuid, { suma: r.qty_per_unit, r, source });
  }
  const consumos: ConsumoCongelado[] = [...agrupado.values()].map(({ suma, r, source }) => ({
    product_uuid: r.product_uuid,
    qty_per_unit: suma.fijo(6),
    quantity: suma.por(quantity).redondear(6).redondear(2).fijo(2),
    origen: r.origen,
    source,
    option_uuid: r.option_uuid,
    unit_cost: costoDe(r.product_uuid).fijo(4),
  }));

  return {
    line_no: lineNo,
    product_uuid: p.uuid,
    product_name: p.nombre,
    quantity: quantity.fijo(2),
    unit_price: unitPrice.fijo(2),
    subtotal: quantity.por(unitPrice).fijo(4),
    unit_cost: unitCost.fijo(4),
    inventory_mode: ef.inventory_mode,
    recipe_uuid: ef.recipe_uuid,
    variant_option_uuid: ef.variant_option_uuid,
    scale: ef.scale.toString(),
    modifiers: ef.opciones.map((o) => ({
      option_uuid: o.opcion.uuid, group_name: o.grupo.name, option_name: o.opcion.name,
      price_delta: Dec.de(o.opcion.price_delta).fijo(2), quantity: o.qty, effect: o.opcion.effect,
    })),
    consumos,
    note: linea.note ?? null,
  };
}

// ---------------------------------------------------------------- pagos
export type MetodoPago = 'EFECTIVO' | 'TARJETA' | 'TRANSFERENCIA' | 'OTRO' | 'PLATAFORMA';
export const METODOS: MetodoPago[] = ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'OTRO', 'PLATAFORMA'];

export interface Pago { method: MetodoPago; amount: string; received?: string | null; reference?: string | null; }

export interface Cobro {
  total: string;
  pagos: Array<{ method: MetodoPago; amount: string; received: string | null; change: string; reference: string | null }>;
  efectivo_neto: string;    // lo que entra a la caja: efectivo cobrado - cambio
  cambio: string;
}

/**
 * Valida el cobro. Solo el efectivo puede recibir de más (y dar cambio); un
 * pago con tarjeta o transferencia es exacto y NO toca la caja.
 */
export function cobrar(total: Dec | string, pagos: Pago[]): Cobro {
  const t = Dec.de(total).redondear(2);
  if (!pagos.length) throw new ErrorVenta('SIN_PAGO', 'Indica cómo se pagó.');
  let suma = Dec.cero, cambio = Dec.cero, efectivo = Dec.cero;
  const salida = pagos.map((p) => {
    if (!METODOS.includes(p.method)) throw new ErrorVenta('METODO', 'Forma de pago no permitida.');
    const amount = Dec.de(p.amount).redondear(2);
    if (!amount.esPositivo()) throw new ErrorVenta('MONTO', 'El monto de cada pago debe ser mayor a cero.');
    let received: Dec | null = null, change = Dec.cero;
    if (p.method === 'EFECTIVO') {
      received = Dec.de(p.received ?? amount).redondear(2);
      if (received.comparar(amount) < 0) throw new ErrorVenta('RECIBIDO', 'El efectivo recibido no alcanza.');
      change = received.menos(amount);
      efectivo = efectivo.mas(amount);
    }
    suma = suma.mas(amount);
    cambio = cambio.mas(change);
    return { method: p.method, amount: amount.fijo(2), received: received?.fijo(2) ?? null, change: change.fijo(2), reference: p.reference ?? null };
  });
  if (suma.comparar(t) !== 0) throw new ErrorVenta('PAGO_DESCUADRADO', `Los pagos suman ${suma.fijo(2)} y la venta es de ${t.fijo(2)}.`);
  return { total: t.fijo(2), pagos: salida, efectivo_neto: efectivo.fijo(2), cambio: cambio.fijo(2) };
}

/** Total como `sp_register_sale`: SUM(quantity * unit_price) exacto y un solo redondeo a DECIMAL(10,2). */
export function totalDe(lineas: LineaCongelada[]): string {
  return Dec.suma(lineas.map((l) => Dec.de(l.quantity).por(l.unit_price))).redondear(2).fijo(2);
}

/** Folio humano por caja: F1-000123. */
export function folio(codigoCaja: string, secuencia: number): string {
  return `${codigoCaja}-${String(secuencia).padStart(6, '0')}`;
}
