/** Política comercial pura. Importada por UI y compilada para el proceso principal.
 * Importes en centavos enteros; nunca modifica recetas ni consumos de inventario.
 * La copia publicada al dominio móvil debe coincidir byte por byte (prueba de paridad).
 */
export interface Selector {
    products?: string[];
    categories?: string[];
    variants?: string[];
}
export interface Canal {
    id: string;
    name: string;
    active: boolean;
    inheritBase: boolean;
}
export interface Horario {
    from: string;
    to: string;
}
export interface Promocion {
    id: string;
    name: string;
    active: boolean;
    priority: number;
    kind: 'PRICE' | 'PERCENT' | 'AMOUNT' | 'BUY_PAY' | 'ADDON' | 'VOLUME';
    /** Mayoreo: mínimo de piezas, sumadas por selector o por producto/variante. */
    minimumQty?: number;
    mixProducts?: boolean;
    /** Precio por cantidad en paquetes (p. ej. 12 por 225 y 6 por 123): se arma
     *  sola la combinación más barata y lo que sobra se cobra suelto. Con
     *  paquetes no se usan minimumQty ni value. */
    tiers?: {
        qty: number;
        price: string;
    }[];
    selector: Selector;
    value?: string;
    buy?: number;
    pay?: number;
    trigger?: Selector;
    triggerQty?: number;
    channels?: string[];
    weekdays?: number[];
    windows?: Horario[];
    starts?: string;
    ends?: string;
    audience?: string;
    extrasIncluded?: boolean;
    maxApplications?: number;
}
export interface Combo {
    id: string;
    name: string;
    active: boolean;
    price: string;
    /** Se aplica solo cuando la cuenta ya trae las piezas, sin armarlo a mano. */
    auto?: boolean;
    channels?: string[];
    weekdays?: number[];
    windows?: Horario[];
    starts?: string;
    ends?: string;
    groups: {
        id: string;
        name: string;
        quantity: number;
        selector: Selector;
    }[];
}
export interface PoliticaComercial {
    version: number;
    channels: Canal[];
    prices: {
        channel: string;
        product: string;
        variant?: string;
        price: string;
    }[];
    promotions: Promocion[];
    combos: Combo[];
}
export interface ProductoComercial {
    id: string;
    price: string;
    category?: string;
}
export interface PartidaComercial {
    key: string;
    product: string;
    quantity: string;
    extras: string;
    variant?: string;
    combo?: {
        id: string;
        instance: string;
        group: string;
    };
}
export interface ContextoComercial {
    channel: string;
    date: string;
    time: string;
    weekday: number;
    audiences?: string[];
}
export interface PrecioResuelto {
    source: string;
    product: string;
    quantity: string;
    unitPrice: string;
    basePrice: string;
    extras: string;
    discount: string;
    rule: string | null;
    ruleName?: string;
    combo: string | null;
}
export interface CuentaComercial {
    version: number;
    channel: string;
    channelName: string;
    context: ContextoComercial;
    gross: string;
    discount: string;
    total: string;
    lines: PrecioResuelto[];
}
export const politicaVacia = (): PoliticaComercial => ({ version: 0, channels: [{ id: 'LOCAL', name: 'Mostrador', active: true, inheritBase: true }], prices: [], promotions: [], combos: [] });
export function centavos(s: string): bigint {
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(String(s)))
        throw new Error('Importe inválido: usa hasta dos decimales.');
    const [a, b = ''] = String(s).split('.');
    return BigInt(a) * 100n + BigInt(b.padEnd(2, '0'));
}
const signedCentavos = (s: string) => s.startsWith('-') ? -centavos(s.slice(1)) : centavos(s);
const dinero = (n: bigint): string => n < 0n ? '-' + dinero(-n) : `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
const redondear = (n: bigint, d: bigint) => (n + d / 2n) / d;
const entero = (n: unknown, min = 1, max = 500) => Number.isInteger(n) && Number(n) >= min && Number(n) <= max;
function coincide(s: Selector, p: ProductoComercial, variant?: string): boolean {
    return ((!s.products?.length && !s.categories?.length) || !!s.products?.includes(p.id) || (!!p.category && !!s.categories?.includes(p.category)))
        && (!s.variants?.length || (!!variant && s.variants.includes(variant)));
}
export function validarPolitica(p: PoliticaComercial): void {
    if (!p || !entero(p.version, 0, 2147483647) || !Array.isArray(p.channels) || !Array.isArray(p.prices) || !Array.isArray(p.promotions) || !Array.isArray(p.combos))
        throw new Error('Configuración comercial inválida.');
    if (p.channels.length > 30 || p.prices.length > 20000 || p.promotions.length > 100 || p.combos.length > 200)
        throw new Error('La configuración supera el límite permitido.');
    const unique = (items: {
        id: string;
        name: string;
    }[]) => { const ids = new Set<string>(); for (const x of items) {
        if (!x.id || !/^[a-zA-Z0-9_-]{1,64}$/.test(x.id) || !x.name?.trim() || x.name.length > 100 || ids.has(x.id))
            throw new Error('Identificadores duplicados o nombres inválidos.');
        ids.add(x.id);
    } };
    unique(p.channels);
    unique(p.promotions);
    unique(p.combos);
    if (!p.channels.some(c => c.id === 'LOCAL' && c.active && c.inheritBase))
        throw new Error('Mostrador debe conservar su precio base.');
    const prices = new Set<string>();
    for (const x of p.prices) {
        centavos(x.price);
        if (!p.channels.some(c => c.id === x.channel) || !x.product)
            throw new Error('Precio sin producto o canal.');
        const k = JSON.stringify([x.channel, x.product, x.variant ?? null]);
        if (prices.has(k))
            throw new Error('Precio duplicado.');
        prices.add(k);
    }
    const selector = (s: Selector) => { if (!s || Object.keys(s).some(k => !['products', 'categories', 'variants'].includes(k)))
        throw new Error('Selección inválida.'); for (const v of Object.values(s)) {
        if (!Array.isArray(v) || v.length > 1000 || v.some(x => typeof x !== 'string' || !x))
            throw new Error('Selección inválida.');
    } };
    for (const r of p.promotions) {
        validarVigencia(r);
        if (r.maxApplications !== undefined && !entero(r.maxApplications))
            throw new Error('Límite por cuenta inválido.');
        selector(r.selector);
        if (!['PRICE', 'PERCENT', 'AMOUNT', 'BUY_PAY', 'ADDON', 'VOLUME'].includes(r.kind) || !entero(r.priority, 0, 10000))
            throw new Error('Tipo o prioridad de promoción inválida.');
        if (r.kind === 'VOLUME' && ((r.tiers === undefined && !entero(r.minimumQty, 2)) || (r.mixProducts !== undefined && typeof r.mixProducts !== 'boolean') || r.maxApplications !== undefined))
            throw new Error('Mayoreo inválido: mínimo de 2 a 500 piezas y sin límite parcial de aplicaciones.');
        if (r.tiers !== undefined) {
            if (r.kind !== 'VOLUME' || !Array.isArray(r.tiers) || !r.tiers.length || r.tiers.length > 5 || r.minimumQty !== undefined || r.value !== undefined)
                throw new Error('Paquetes inválidos: de uno a cinco, solo en precio por cantidad.');
            const sizes = new Set<number>();
            for (const t of r.tiers) {
                if (!t || !entero(t.qty, 2) || sizes.has(t.qty))
                    throw new Error('Paquetes inválidos: cada uno de 2 a 500 piezas y sin repetir.');
                centavos(t.price);
                sizes.add(t.qty);
            }
        }
        if (r.kind === 'BUY_PAY') {
            if (!entero(r.buy, 2) || !entero(r.pay, 1) || r.pay! >= r.buy!)
                throw new Error('Compra/paga inválido.');
        }
        else if (r.tiers === undefined) {
            centavos(r.value!);
            if (r.kind === 'PERCENT' && centavos(r.value!) > 10000n)
                throw new Error('El descuento no puede superar 100%.');
        }
        if (r.kind === 'ADDON') {
            selector(r.trigger!);
            if (!entero(r.triggerQty))
                throw new Error('Cantidad requerida inválida.');
        }
        if (r.weekdays?.some(d => !entero(d, 0, 6)))
            throw new Error('Día inválido.');
        for (const w of r.windows ?? []) {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.to) || w.from === w.to)
                throw new Error('Horario inválido.');
        }
        for (const d of [r.starts, r.ends])
            if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d))
                throw new Error('Fecha inválida.');
        if (r.starts && r.ends && r.starts > r.ends)
            throw new Error('Vigencia inválida.');
    }
    for (const c of p.combos) {
        validarVigencia(c);
        centavos(c.price);
        if (c.auto !== undefined && typeof c.auto !== 'boolean')
            throw new Error('Combo inválido.');
        if (!c.groups.length || c.groups.length > 10)
            throw new Error('El combo necesita de uno a diez grupos.');
        const ids = new Set();
        for (const g of c.groups) {
            selector(g.selector);
            if (!g.id || ids.has(g.id) || !g.name?.trim() || !entero(g.quantity, 1, 50))
                throw new Error('Grupo de combo inválido.');
            ids.add(g.id);
        }
    }
}
function validarVigencia(r: { weekdays?: number[]; windows?: Horario[]; starts?: string; ends?: string }): void {
    if (r.weekdays && (!Array.isArray(r.weekdays) || r.weekdays.some(d => !entero(d, 0, 6)))) throw Error('Día inválido.');
    if (r.windows && (!Array.isArray(r.windows) || r.windows.some(w => !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.to) || w.from === w.to))) throw Error('Horario inválido.');
    for (const d of [r.starts, r.ends]) if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(d + 'T12:00:00Z').toISOString().slice(0, 10) !== d)) throw Error('Fecha inválida.');
    if (r.starts && r.ends && r.starts > r.ends) throw Error('Vigencia inválida.');
}
export function vigente(r: { active: boolean; channels?: string[]; weekdays?: number[]; windows?: Horario[]; starts?: string; ends?: string }, ctx: ContextoComercial): boolean {
    return r.active && (!r.channels?.length || r.channels.includes(ctx.channel)) && (!r.starts || ctx.date >= r.starts) && (!r.ends || ctx.date <= r.ends) && (!r.weekdays?.length || r.weekdays.includes(ctx.weekday)) && (!r.windows?.length || r.windows.some(w => w.from < w.to ? ctx.time >= w.from && ctx.time < w.to : ctx.time >= w.from || ctx.time < w.to));
}
/** Prioridad explícita: una unidad reservada por combo/oferta no recibe otra oferta.
 *  Los combos automáticos se prueban aparte: queda la cuenta más barata para el
 *  cliente (con empate, la que arma el combo). */
export function cotizar(p: PoliticaComercial, products: ProductoComercial[], cart: PartidaComercial[], ctx: ContextoComercial): CuentaComercial {
    validarPolitica(p);
    const sin = cotizarCon(p, products, cart, ctx, false);
    if (!p.combos.some(c => c.auto && vigente(c, ctx)))
        return sin;
    let con: CuentaComercial;
    try {
        con = cotizarCon(p, products, cart, ctx, true);
    }
    catch {
        return sin;
    }
    return centavos(con.total) <= centavos(sin.total) ? con : sin;
}
function cotizarCon(p: PoliticaComercial, products: ProductoComercial[], cart: PartidaComercial[], ctx: ContextoComercial, auto: boolean): CuentaComercial {
    const channel = p.channels.find(c => c.id === ctx.channel && c.active);
    if (!channel)
        throw new Error('Canal no disponible.');
    const active = p.promotions.filter(r => vigente(r, ctx) && (!r.audience || ctx.audiences?.includes(r.audience))).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const autos = auto ? p.combos.filter(c => c.auto && vigente(c, ctx)).sort((a, b) => a.id.localeCompare(b.id)) : [];
    const byProduct = new Map(products.map(x => [x.id, x]));
    const keys = new Set();
    type Unit = {
        src: PartidaComercial;
        p: ProductoComercial;
        q: bigint;
        base: bigint;
        extras: bigint;
        price: bigint;
        rule: string | null;
        combo: string | null;
        locked: boolean;
        triggered: boolean;
    };
    const units: Unit[] = [];
    for (const l of cart) {
        if (!l.key || keys.has(l.key))
            throw new Error('Partida duplicada.');
        keys.add(l.key);
        const prod = byProduct.get(l.product);
        if (!prod)
            throw new Error('Producto no disponible.');
        const qty = centavos(l.quantity);
        if (qty <= 0n)
            throw new Error('Cantidad inválida.');
        const price = p.prices.find(x => x.channel === ctx.channel && x.product === prod.id && x.variant === l.variant) ?? p.prices.find(x => x.channel === ctx.channel && x.product === prod.id && !x.variant);
        if (!price && !channel.inheritBase)
            throw new Error('Falta configurar el precio de este producto en el canal.');
        const base = centavos(price?.price ?? prod.price), extras = signedCentavos(l.extras);
        if (base + extras < 0n)
            throw Error('El precio con opciones no puede ser negativo.');
        const needsUnits = !!l.combo || autos.some(c => c.groups.some(g => coincide(g.selector, prod, l.variant))) || active.some(r => (r.kind === 'BUY_PAY' || r.kind === 'ADDON' || r.kind === 'VOLUME' || r.maxApplications !== undefined) && (coincide(r.selector, prod, l.variant) || (r.trigger && coincide(r.trigger, prod, l.variant))));
        if (needsUnits && qty % 100n !== 0n)
            throw new Error('Las ofertas requieren unidades completas.');
        if (needsUnits && qty > 50000n)
            throw new Error('Divide la cuenta: máximo 500 unidades por partida con ofertas.');
        const count = needsUnits ? Number(qty / 100n) : 1;
        for (let i = 0; i < count; i++)
            units.push({ src: l, p: prod, q: needsUnits ? 100n : qty, base, extras, price: base + extras, rule: null, combo: null, locked: false, triggered: false });
        if (units.length > 2000)
            throw new Error('La cuenta supera el límite de unidades con ofertas.');
    }
    const instances = new Set(cart.filter(l => l.combo).map(l => l.combo!.instance));
    for (const instance of instances) {
        const selected = units.filter(u => u.src.combo?.instance === instance);
        const id = selected[0].src.combo!.id;
        const combo = p.combos.find(c => c.id === id && vigente(c, ctx));
        if (!instance || !combo || selected.some(u => u.src.combo!.id !== id))
            throw new Error('Combo no disponible.');
        for (const g of combo.groups) {
            const group = selected.filter(u => u.src.combo!.group === g.id);
            if (group.length !== g.quantity || group.some(u => !coincide(g.selector, u.p, u.src.variant)))
                throw new Error('Completa las elecciones del combo.');
        }
        if (selected.some(u => !combo.groups.some(g => g.id === u.src.combo!.group)))
            throw new Error('Componente ajeno al combo.');
        const target = centavos(combo.price), baseTotal = selected.reduce((a, u) => a + u.base, 0n);
        if (target > baseTotal)
            throw new Error('El precio del combo supera sus componentes; ajusta la lista del canal.');
        let remaining = target;
        selected.forEach((u, i) => { const assigned = i === selected.length - 1 ? remaining : baseTotal ? target * u.base / baseTotal : 0n; remaining -= assigned; u.price = assigned + u.extras; if (u.price < 0n)
            throw Error('El precio del combo con opciones no puede ser negativo.'); u.rule = combo.id; u.combo = instance; u.locked = true; });
    }
    for (const combo of autos) {
        const target = centavos(combo.price);
        for (let n = 1; ; n++) {
            // Las piezas de mayor precio primero: así el cliente ahorra más.
            const selected: Unit[] = [];
            for (const g of combo.groups) {
                const pick = units.filter(u => !u.locked && !selected.includes(u) && coincide(g.selector, u.p, u.src.variant)).sort((a, b) => a.base > b.base ? -1 : a.base < b.base ? 1 : a.src.key.localeCompare(b.src.key)).slice(0, g.quantity);
                if (pick.length < g.quantity)
                    break;
                selected.push(...pick);
            }
            const needed = combo.groups.reduce((a, g) => a + g.quantity, 0);
            const baseTotal = selected.reduce((a, u) => a + u.base, 0n);
            // Solo si ahorra: un combo que cuesta lo mismo o más que sus piezas no se arma solo.
            if (selected.length < needed || target >= baseTotal)
                break;
            const instance = `auto-${combo.id}-${n}`;
            let remaining = target;
            selected.forEach((u, i) => { const assigned = i === selected.length - 1 ? remaining : baseTotal ? target * u.base / baseTotal : 0n; remaining -= assigned; u.price = assigned + u.extras < 0n ? 0n : assigned + u.extras; u.rule = combo.id; u.combo = instance; u.locked = true; });
        }
    }
    for (const r of active) {
        const eligible = units.filter(u => !u.locked && coincide(r.selector, u.p, u.src.variant));
        const apply = (u: Unit, target: bigint) => { if (target < 0n)
            target = 0n; if (target >= u.price)
            return; u.price = target; u.rule = r.id; u.locked = true; };
        if (r.kind === 'VOLUME') {
            const groups = new Map<string, Unit[]>();
            for (const u of eligible) {
                const key = r.mixProducts !== false ? '*' : JSON.stringify([u.p.id, u.src.variant ?? null]);
                const group = groups.get(key) ?? [];
                group.push(u); groups.set(key, group);
            }
            if (r.tiers) {
                const tiers = r.tiers.map(t => ({ qty: t.qty, price: centavos(t.price) }));
                for (const group of groups.values()) {
                    // Las piezas caras entran al paquete; las baratas, sueltas.
                    group.sort((a, b) => a.base > b.base ? -1 : a.base < b.base ? 1 : a.src.key.localeCompare(b.src.key));
                    const n = group.length;
                    // Paquetes más baratos que suman exactamente m piezas (mochila sin límite).
                    const best: (bigint | null)[] = [0n], how: number[][] = [[]];
                    for (let m = 1; m <= n; m++) {
                        best[m] = null; how[m] = [];
                        for (const [i, t] of tiers.entries())
                            if (t.qty <= m && best[m - t.qty] !== null && (best[m] === null || best[m - t.qty]! + t.price < best[m]!)) {
                                best[m] = best[m - t.qty]! + t.price;
                                how[m] = [...how[m - t.qty], i];
                            }
                    }
                    const suelto = (from: number) => group.slice(from).reduce((a, u) => a + u.base, 0n);
                    let m = 0;
                    for (let k = 1; k <= n; k++)
                        if (best[k] !== null && best[k]! + suelto(k) < best[m]! + suelto(m))
                            m = k;
                    let at = 0;
                    for (const i of [...how[m]].sort((a, b) => tiers[b].qty - tiers[a].qty)) {
                        const pack = group.slice(at, at + tiers[i].qty), baseTotal = pack.reduce((a, u) => a + u.base, 0n);
                        at += tiers[i].qty;
                        let remaining = tiers[i].price;
                        pack.forEach((u, j) => { const assigned = j === pack.length - 1 ? remaining : baseTotal ? tiers[i].price * u.base / baseTotal : 0n; remaining -= assigned; u.price = assigned + (r.extrasIncluded ? 0n : u.extras); u.rule = r.id; u.locked = true; });
                    }
                }
            }
            else
                for (const group of groups.values()) if (group.length >= r.minimumQty!)
                    for (const u of group) apply(u, centavos(r.value!) + (r.extrasIncluded ? 0n : u.extras));
        }
        else if (r.kind === 'BUY_PAY') {
            const sorted = eligible.sort((a, b) => a.price < b.price ? -1 : a.price > b.price ? 1 : a.src.key.localeCompare(b.src.key));
            const groups = Math.floor(sorted.length / r.buy!);
            const freebies = groups * (r.buy! - r.pay!);
            for (let i = 0; i < groups * r.buy!; i++) {
                const u = sorted[i];
                u.locked = true;
                u.rule = r.id;
                if (i < freebies) {
                    u.price = r.extrasIncluded || u.extras < 0n ? 0n : u.extras;
                    u.rule = r.id;
                }
            }
        }
        else if (r.kind === 'ADDON') {
            const trigger = units.filter(u => !u.locked && !u.triggered && coincide(r.trigger!, u.p, u.src.variant) && !eligible.includes(u));
            let limit = Math.floor(trigger.length / r.triggerQty!);
            for (const u of eligible) {
                if (!limit)
                    break;
                const target = centavos(r.value!) + (r.extrasIncluded ? 0n : u.extras);
                if (target < u.price) {
                    apply(u, target);
                    limit--;
                    for (const t of trigger.filter(x => !x.triggered).slice(0, r.triggerQty)) {
                        t.triggered = true;
                        t.locked = true;
                        t.rule = r.id;
                    }
                }
            }
        }
        else {
            let applied = 0;
            for (const u of eligible) {
                if (r.maxApplications !== undefined && applied >= r.maxApplications)
                    break;
                const base = r.extrasIncluded ? u.price : u.base;
                const v = centavos(r.value!);
                const discounted = r.kind === 'PRICE' ? v : r.kind === 'PERCENT' ? base - redondear(base * v, 10000n) : base > v ? base - v : 0n;
                const target = discounted + (r.extrasIncluded ? 0n : u.extras);
                if (target < u.price) {
                    apply(u, target);
                    applied++;
                }
            }
        }
    }
    const gross = redondear(units.reduce((a, u) => a + (u.base + u.extras) * u.q, 0n), 100n), total = redondear(units.reduce((a, u) => a + u.price * u.q, 0n), 100n);
    return { version: p.version, channel: ctx.channel, channelName: channel.name, context: { ...ctx, audiences: [...(ctx.audiences ?? [])] }, gross: dinero(gross), discount: dinero(gross - total), total: dinero(total), lines: units.map(u => ({ source: u.src.key, product: u.p.id, quantity: dinero(u.q), unitPrice: dinero(u.price), basePrice: dinero(u.base), extras: dinero(u.extras), discount: dinero((u.base + u.extras - u.price) * u.q / 100n), rule: u.rule, ruleName: p.promotions.find(r => r.id === u.rule)?.name ?? p.combos.find(c => c.id === u.rule)?.name, combo: u.combo })) };
}
