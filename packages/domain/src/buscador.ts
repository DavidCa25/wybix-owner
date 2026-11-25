/**
 * BUSCAR PARA VENDER: por nombre, clave o código, sin acentos.
 *
 * Cada producto vendible es una entrada, y cada presentación de venta (el
 * cartón de 24, el paquete de 12) es otra entrada del mismo producto: así se
 * toca el paquete sin escanearlo, igual que en la caja del escritorio.
 *
 * El índice se arma UNA vez por versión de catálogo (`indiceDeVenta`) y buscar
 * es recorrer textos ya normalizados: con mil productos no se nota al teclear.
 * Puro, sin React: se prueba en node (packages/domain/test/buscador.test.ts).
 */
import type { CatalogoIndexado, PresentacionCat, ProductoCat } from './catalogo.ts';

export type TipoEntrada = 'PIEZA' | 'SUELTO' | 'PAQUETE_SUELTO' | 'PRESENTACION';

export interface EntradaVenta {
  /** Estable: `<uuid>` o `<uuid>|<presentación>`. Sirve de key en listas. */
  clave: string;
  product_uuid: string;
  presentation_id: string | null;
  nombre: string;
  /** Precio de lo que se agrega al tocar (la pieza o el paquete completo). */
  precio: string;
  /** Piezas que se agregan al tocar. */
  piezas: number;
  tipo: TipoEntrada;
  /** «Suelto · de Cajetilla 20», «Paquete · 24 piezas», «Pieza». */
  etiqueta: string;
  category_uuid: string | null;
  bar_code: string | null;
  /** Texto normalizado donde se busca. */
  texto: string;
}

/** minúsculas, sin acentos ni signos dobles: «Papel Higiénico» -> «papel higienico». */
export function normalizar(s: string | null | undefined): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function entradaPieza(cat: CatalogoIndexado, p: ProductoCat): EntradaVenta {
  const padre = p.suelto ? cat.producto.get(p.suelto.parent_uuid) : null;
  const esPaqueteSuelto = (cat.piezasDe?.get(p.uuid)?.length ?? 0) > 0;
  const tipo: TipoEntrada = padre ? 'SUELTO' : esPaqueteSuelto ? 'PAQUETE_SUELTO' : 'PIEZA';
  const etiqueta = padre ? `Suelto · de ${padre.nombre}` : esPaqueteSuelto ? 'Paquete · también por pieza' : 'Pieza';
  return {
    clave: p.uuid, product_uuid: p.uuid, presentation_id: null, nombre: p.nombre, precio: p.price, piezas: 1, tipo, etiqueta,
    category_uuid: p.category_uuid ?? null, bar_code: p.bar_code ?? null,
    texto: normalizar([p.nombre, p.part_number, p.bar_code].filter(Boolean).join(' ')),
  };
}

function entradaPresentacion(p: ProductoCat, x: PresentacionCat): EntradaVenta {
  return {
    clave: `${p.uuid}|${x.id}`, product_uuid: p.uuid, presentation_id: x.id, nombre: `${p.nombre} · ${x.name}`,
    precio: x.sale_price, piezas: x.factor, tipo: 'PRESENTACION', etiqueta: `Paquete · ${x.factor} piezas`,
    category_uuid: p.category_uuid ?? null, bar_code: x.bar_code,
    texto: normalizar([p.nombre, x.name, 'paquete', p.part_number, x.bar_code].filter(Boolean).join(' ')),
  };
}

/** Todas las entradas vendibles, una vez por versión de catálogo. */
export function indiceDeVenta(cat: CatalogoIndexado): EntradaVenta[] {
  const out: EntradaVenta[] = [];
  const productos = [...cat.producto.values()].filter((p) => p.active && p.sellable)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  for (const p of productos) {
    out.push(entradaPieza(cat, p));
    // Los paquetes de menor a mayor: 4, 6, 12, 18.
    for (const x of [...(p.presentations ?? [])].sort((a, b) => a.factor - b.factor)) out.push(entradaPresentacion(p, x));
  }
  return out;
}

/**
 * Buscar: todas las palabras deben aparecer (en cualquier orden). Un código
 * exacto va primero; luego lo que empieza con lo escrito.
 */
export function buscarEntradas(indice: EntradaVenta[], consulta: string, o: { categoria?: string | null; limite?: number } = {}): EntradaVenta[] {
  const q = normalizar(consulta);
  const enCat = (e: EntradaVenta) => !o.categoria || e.category_uuid === o.categoria;
  if (!q) return indice.filter(enCat).slice(0, o.limite ?? indice.length);
  const palabras = q.split(' ');
  const exactos: EntradaVenta[] = [], inicio: EntradaVenta[] = [], resto: EntradaVenta[] = [];
  for (const e of indice) {
    if (!enCat(e)) continue;
    if (e.bar_code && e.bar_code === consulta.trim()) { exactos.push(e); continue; }
    if (!palabras.every((w) => e.texto.includes(w))) continue;
    (e.texto.startsWith(q) ? inicio : resto).push(e);
  }
  const r = [...exactos, ...inicio, ...resto];
  return o.limite ? r.slice(0, o.limite) : r;
}

/** Lo que agrega un código escaneado: la pieza o el paquete completo. */
export function porCodigo(cat: CatalogoIndexado, codigo: string): { product_uuid: string; presentation_id: string | null; piezas: number } | null {
  const hit = cat.porCodigo?.get(String(codigo ?? '').trim());
  if (!hit) return null;
  const p = cat.producto.get(hit.product_uuid);
  if (!p || !p.active || !p.sellable) return null;
  const x = hit.presentation_id ? p.presentations?.find((y) => y.id === hit.presentation_id) : null;
  return { product_uuid: p.uuid, presentation_id: x?.id ?? null, piezas: x?.factor ?? 1 };
}
