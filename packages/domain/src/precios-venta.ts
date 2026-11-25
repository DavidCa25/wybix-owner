import { cotizar, centavos, politicaVacia, type CuentaComercial } from './comercial.ts';
import { congelarLinea, totalDe, ErrorVenta, type LineaCarrito, type LineaCongelada } from './venta.ts';
import type { CatalogoIndexado } from './catalogo.ts';
import { Dec } from './decimal.ts';
export interface SeleccionComercial {
    channel?: string;
    audiences?: string[];
}
export function prepararVenta(cat: CatalogoIndexado, carrito: LineaCarrito[], seleccion: SeleccionComercial, ahora: Date, timezone: string): {
    lineas: LineaCongelada[];
    total: string;
    commercial: CuentaComercial | null;
} {
    const original = carrito.map((l, i) => congelarLinea(cat, l, i + 1));
    // Presentaciones de venta: el paquete y su precio salen del catálogo.
    const packs = carrito.map((l) => {
        if (!l.presentation_id) return undefined;
        const p = cat.producto.get(l.product_uuid);
        const x = p?.presentations?.find(y => y.id === l.presentation_id);
        if (!x || !(x.factor >= 2)) throw new ErrorVenta('PRESENTACION', 'Ese paquete ya no está a la venta.');
        const q = Dec.de(l.quantity);
        if (!q.esPositivo() || q.redondear(0).comparar(q) !== 0 || Number(q.fijo(0)) % x.factor !== 0)
            throw new ErrorVenta('PRESENTACION', `${x.name} se vende completo: ${x.factor} piezas por paquete.`);
        return { id: x.id, name: x.name, qty: x.factor, price: Dec.de(x.sale_price).fijo(2) };
    });
    const politica = cat.commercial ?? (packs.some(Boolean) ? politicaVacia() : null);
    if (!politica)
        return { lineas: original, total: totalDe(original), commercial: null };
    const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ahora);
    const get = (name: string) => parts.find(x => x.type === name)!.value;
    const date = `${get('year')}-${get('month')}-${get('day')}`, time = `${get('hour')}:${get('minute')}`;
    const commercial = cotizar(politica, [...cat.producto.values()].map(p => ({ id: p.uuid, price: p.price, category: p.category_uuid ?? undefined })), original.map((l, i) => ({ key: String(i), product: l.product_uuid, quantity: l.quantity, extras: Dec.de(l.unit_price).menos(cat.producto.get(l.product_uuid)!.price).fijo(2), variant: l.variant_option_uuid ?? undefined, combo: carrito[i].combo, ...(packs[i] ? { pack: packs[i] } : {}) })), { channel: seleccion.channel ?? 'LOCAL', audiences: seleccion.audiences, date, time, weekday: new Date(date + 'T12:00:00Z').getUTCDay() });
    const assigned = new Map<string, bigint>();
    const lineas = commercial.lines.map((priced, i) => {
        const source = Number(priced.source), old = original[source], consumed = assigned.get(priced.source) ?? 0n;
        const quantity = centavos(priced.quantity), totalQty = centavos(old.quantity), after = consumed + quantity;
        assigned.set(priced.source, after);
        const ratio = (n: bigint, q: bigint) => (n * q + totalQty / 2n) / totalQty;
        const consumos = old.consumos.map(c => { const n = centavos(c.quantity), amount = ratio(n, after) - ratio(n, consumed); return { ...c, quantity: `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}` }; });
        return { ...old, line_no: i + 1, quantity: priced.quantity, unit_price: priced.unitPrice, subtotal: Dec.de(priced.quantity).por(priced.unitPrice).fijo(4), consumos, commercial: priced };
    });
    if (totalDe(lineas) !== commercial.total)
        throw Error('El total comercial no coincide con las partidas.');
    return { lineas, total: commercial.total, commercial };
}
