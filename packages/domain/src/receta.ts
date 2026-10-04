/**
 * RECETA EFECTIVA: port exacto de `sp_resolver_receta_efectiva` (SQL Server).
 *
 *     receta base (o la del tamaño) x escala - removidos ~ sustituidos + añadidos
 *
 * Cada paso replica el procedimiento en el mismo orden. Las pruebas cruzadas
 * (scripts/paridad-recetas.mjs en el repo del POS) ejecutan las MISMAS
 * ventas en SQL Server y aquí y exigen resultados idénticos.
 */
import { Dec } from './decimal.ts';
import type { CatalogoIndexado, ModoInventario, OpcionCat, GrupoCat } from './catalogo.ts';

export type Origen = 'DIRECT' | 'BASE' | 'SIZE' | 'SUBSTITUTE' | 'ADD';

export interface OpcionElegida { option_uuid: string; qty?: number; }

export interface Requerimiento {
  product_uuid: string;
  qty_per_unit: Dec;            // DECIMAL(18,6)
  origen: Origen;
  option_uuid: string | null;
  recipe_uuid: string | null;
}

export interface RecetaEfectiva {
  inventory_mode: ModoInventario;
  recipe_uuid: string | null;
  variant_option_uuid: string | null;
  scale: Dec;
  requerimientos: Requerimiento[];
  /** Opciones válidas (activas y de grupo activo), como las relee el SP. */
  opciones: Array<{ opcion: OpcionCat; grupo: GrupoCat; qty: number }>;
}

export function resolverRecetaEfectiva(cat: CatalogoIndexado, productUuid: string, elegidas: OpcionElegida[] = []): RecetaEfectiva {
  const p = cat.producto.get(productUuid);
  if (!p) throw new Error(`Producto fuera del catálogo: ${productUuid}`);
  const modo = p.inventory_mode;

  // 1) opciones: se releen de la configuración; qty < 1 cuenta como 1.
  const opciones = elegidas
    .map((e) => ({ ref: cat.opcion.get(e.option_uuid), qty: !e.qty || e.qty < 1 ? 1 : Math.trunc(e.qty) }))
    .filter((x) => x.ref && x.ref.opcion.active && x.ref.grupo.active)
    .map((x) => ({ opcion: x.ref!.opcion, grupo: x.ref!.grupo, qty: x.qty }));

  // 2) qué receta: la del tamaño elegido gana a la base.
  let recipe_uuid: string | null = null;
  let variant_option_uuid: string | null = null;
  let lineasReceta: { ingredient_uuid: string; qty_base: string; waste_pct: string }[] = [];
  if (modo === 'RECIPE') {
    const tamanos = new Set(opciones.filter((o) => o.grupo.role === 'SIZE').map((o) => o.opcion.uuid));
    const candidatas = (cat.recetasDe.get(productUuid) ?? [])
      .filter((r) => r.active && (r.variant_option_uuid == null || tamanos.has(r.variant_option_uuid)));
    const elegida = candidatas.find((r) => r.variant_option_uuid != null) ?? candidatas.find((r) => r.variant_option_uuid == null) ?? null;
    if (elegida) {
      recipe_uuid = elegida.uuid;
      variant_option_uuid = elegida.variant_option_uuid;
      lineasReceta = elegida.lines;
    }
  }

  // 3) escala: SCALE solo sobre la receta BASE (la de tamaño ya trae cantidades).
  let scale = Dec.uno;
  if (modo === 'RECIPE' && recipe_uuid && variant_option_uuid == null) {
    for (const o of opciones) {
      if (o.opcion.effect === 'SCALE' && o.opcion.qty_factor != null && Dec.de(o.opcion.qty_factor).esPositivo()) {
        scale = Dec.de(o.opcion.qty_factor);   // UPDATE ... FROM: gana la última fila que coincide
      }
    }
  }

  const req: Requerimiento[] = [];
  // 4) DIRECT se consume a sí mismo. NONE no consume nada.
  if (modo === 'DIRECT') req.push({ product_uuid: productUuid, qty_per_unit: Dec.uno, origen: 'DIRECT', option_uuid: null, recipe_uuid: null });

  // 5) receta: qty_base * (1 + merma/100) * escala, guardado en DECIMAL(18,6).
  if (modo === 'RECIPE' && recipe_uuid) {
    for (const l of lineasReceta) {
      const q = Dec.de(l.qty_base).por(Dec.uno.mas(Dec.de(l.waste_pct).entre10(2))).por(scale);
      req.push({ product_uuid: l.ingredient_uuid, qty_per_unit: q.redondear(6), origen: variant_option_uuid ? 'SIZE' : 'BASE', option_uuid: null, recipe_uuid });
    }
  }

  // 6) REMOVE: quita el ingrediente de la receta (si no estaba, no pasa nada).
  const quitados = new Set(opciones.filter((o) => o.opcion.effect === 'REMOVE' && o.opcion.replaces_uuid).map((o) => o.opcion.replaces_uuid!));
  for (let i = req.length - 1; i >= 0; i--) {
    if ((req[i].origen === 'BASE' || req[i].origen === 'SIZE') && quitados.has(req[i].product_uuid)) req.splice(i, 1);
  }

  // 7) SUBSTITUTE: cambia el ingrediente; cantidad propia (escalada) si la trae.
  for (const r of req) {
    if (r.origen !== 'BASE' && r.origen !== 'SIZE') continue;
    const o = opciones.find((x) => x.opcion.effect === 'SUBSTITUTE' && x.opcion.replaces_uuid === r.product_uuid);
    if (!o || !o.opcion.ingredient_uuid) continue;
    r.product_uuid = o.opcion.ingredient_uuid;
    if (o.opcion.qty_base != null) r.qty_per_unit = Dec.de(o.opcion.qty_base).por(scale).redondear(6);
    r.origen = 'SUBSTITUTE';
    r.option_uuid = o.opcion.uuid;
  }

  // 8) ADD: consumo extra x cantidad elegida; NO escala con el tamaño.
  if (modo === 'RECIPE' || modo === 'DIRECT') {
    for (const o of opciones) {
      if (o.opcion.effect === 'ADD' && o.opcion.ingredient_uuid && o.opcion.qty_base != null && Dec.de(o.opcion.qty_base).esPositivo()) {
        req.push({ product_uuid: o.opcion.ingredient_uuid, qty_per_unit: Dec.de(o.opcion.qty_base).por(o.qty).redondear(6), origen: 'ADD', option_uuid: o.opcion.uuid, recipe_uuid: null });
      }
    }
  }

  // Cantidad cero no consume nada.
  return {
    inventory_mode: modo, recipe_uuid, variant_option_uuid, scale, opciones,
    requerimientos: req.filter((r) => r.qty_per_unit.esPositivo()),
  };
}
