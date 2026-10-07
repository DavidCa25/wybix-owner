import type {PoliticaComercial} from './comercial.ts';
/**
 * CATÁLOGO QUE VIAJA A LA TABLET (publicación versionada de la sucursal base).
 *
 * Es la misma información que usa `sp_register_sale` en SQL Server, con UUID
 * en vez de ids locales (los ids de una base no significan nada en otra). Los
 * números viajan como TEXTO para no perder decimales en JSON.
 */
export type ModoInventario = 'DIRECT' | 'RECIPE' | 'NONE';
export type EfectoOpcion = 'NONE' | 'REMOVE' | 'SUBSTITUTE' | 'ADD' | 'SCALE';
export type RolGrupo = 'SIZE' | 'ADDON' | 'SUBSTITUTION' | 'NOTE';

export interface ProductoCat {
  uuid: string;
  nombre: string;
  price: string;            // DECIMAL(10,2)
  cost: string | null;      // DECIMAL(14,4)
  inventory_mode: ModoInventario;
  sellable: boolean;
  active: boolean;
  allow_decimal_qty?: boolean;
  category_uuid?: string | null;
  modifier_groups?: string[];   // uuids de grupos, en orden
  tasa_iva?: string;
}

export interface LineaReceta { ingredient_uuid: string; qty_base: string; waste_pct: string; }
export interface RecetaCat {
  uuid: string;
  product_uuid: string;
  variant_option_uuid: string | null;
  active: boolean;
  lines: LineaReceta[];
}

export interface OpcionCat {
  uuid: string;
  name: string;
  price_delta: string;               // DECIMAL(10,2)
  effect: EfectoOpcion;
  ingredient_uuid: string | null;
  replaces_uuid: string | null;
  qty_base: string | null;           // DECIMAL(14,4)
  qty_factor: string | null;         // DECIMAL(8,4)
  active: boolean;
}
export interface GrupoCat {
  uuid: string;
  name: string;
  role: RolGrupo;
  min_select: number;
  max_select: number;
  required: boolean;
  active: boolean;
  options: OpcionCat[];
}

export interface Catalogo {
  commercial?:PoliticaComercial;
  catalog_version: number;
  products: ProductoCat[];
  recipes: RecetaCat[];
  modifier_groups: GrupoCat[];
  categories?: { uuid: string; nombre: string }[];
}

/** Índices para resolver rápido (una vez por versión de catálogo). */
export interface CatalogoIndexado {
  commercial?:PoliticaComercial;
  version: number;
  producto: Map<string, ProductoCat>;
  recetasDe: Map<string, RecetaCat[]>;
  opcion: Map<string, { opcion: OpcionCat; grupo: GrupoCat }>;
  grupo: Map<string, GrupoCat>;
}

export function indexar(c: Catalogo): CatalogoIndexado {
  const producto = new Map(c.products.map((p) => [p.uuid, p]));
  const recetasDe = new Map<string, RecetaCat[]>();
  for (const r of c.recipes) {
    const l = recetasDe.get(r.product_uuid) ?? [];
    l.push(r);
    recetasDe.set(r.product_uuid, l);
  }
  const opcion = new Map<string, { opcion: OpcionCat; grupo: GrupoCat }>();
  const grupo = new Map<string, GrupoCat>();
  for (const g of c.modifier_groups) {
    grupo.set(g.uuid, g);
    for (const o of g.options) opcion.set(o.uuid, { opcion: o, grupo: g });
  }
  return { commercial:c.commercial,version: c.catalog_version, producto, recetasDe, opcion, grupo };
}

/** Lo que se puede vender en esta versión (lo desactivado ya no aparece). */
export function vendibles(c: Catalogo): ProductoCat[] {
  return c.products.filter((p) => p.active && p.sellable);
}
