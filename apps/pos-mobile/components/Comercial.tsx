import { useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { uuidv7, type CatalogoIndexado, type LineaCarrito, type Selector, type RolEvento } from '@wybix/domain';
import { Pulse, Boton, Sheet, pos as t, tipo } from './ui';
export function Comercial({ cat, channel, onChannel, audiences, onAudiences, role, onAdd }: {
    cat: CatalogoIndexado;
    channel: string;
    onChannel: (id: string) => void;
    audiences: string[];
    onAudiences: (a: string[]) => void;
    role: RolEvento;
    onAdd: (lines: LineaCarrito[]) => void;
}) {
    const [open, setOpen] = useState(false), [comboId, setComboId] = useState(''), [selections, setSelections] = useState<Record<string, string>>({}), [options, setOptions] = useState<Record<string, string[]>>({}), [error, setError] = useState('');
    const policy = cat.commercial;
    if (!policy)
        return null;
    const combo = policy.combos.find(c => c.id === comboId);
    const products = (selector: Selector) => [...cat.producto.values()].filter(p => p.active && p.sellable && ((!selector.products?.length && !selector.categories?.length) || selector.products?.includes(p.uuid) || (!!p.category_uuid && selector.categories?.includes(p.category_uuid))));
    const chips = (items: {
        id: string;
        name: string;
    }[], value: string, change: (id: string) => void) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{items.map(x => <Pulse key={x.id} accessibilityRole="radio" accessibilityLabel={x.name} accessibilityState={{ checked: value === x.id }} active={value === x.id} onPress={() => change(x.id)} style={{ padding: 12, borderRadius: 14, backgroundColor: value === x.id ? t.cian : '#fff', borderWidth: 1, borderColor: t.borde }}><Text style={tipo.cuerpo}>{x.name}</Text></Pulse>)}</View>;
    function add() { try {
        if (!combo)
            throw Error('Elige un combo.');
        const instance = uuidv7(), lines: LineaCarrito[] = [];
        for (const g of combo.groups)
            for (let i = 0; i < g.quantity; i++) {
                const key = g.id + ':' + i, p = products(g.selector).find(p => p.uuid === selections[key]);
                if (!p)
                    throw Error('Completa las elecciones.');
                const chosen: {
                    option_uuid: string;
                    qty: number;
                }[] = [];
                for (const groupUuid of p.modifier_groups ?? []) {
                    const group = cat.grupo.get(groupUuid)!;
                    const selection = options[key + ':' + groupUuid] ?? [];
                    if (selection.length < Math.max(group.min_select, group.required ? 1 : 0) || selection.length > group.max_select)
                        throw Error('Revisa ' + group.name);
                    for (const uuid of selection)
                        chosen.push({ option_uuid: uuid, qty: 1 });
                }
                lines.push({ product_uuid: p.uuid, quantity: '1', options: chosen, combo: { id: combo.id, instance, group: g.id } });
            }
        onAdd(lines);
        setOpen(false);
        setError('');
    }
    catch (e) {
        setError((e as Error).message);
    } }
    return <View style={{ padding: 16, gap: 12, backgroundColor: t.fondo }}><Text style={tipo.etiqueta}>CANAL DE ESTA CUENTA</Text>{chips(policy.channels.filter(c => c.active), channel, onChannel)}{policy.combos.some(c => c.active && (!c.channels?.length || c.channels.includes(channel))) && <Boton titulo="Agregar combo" variante="secundario" onPress={() => setOpen(true)}/>}
 {[...new Set(policy.promotions.filter(p => p.active && p.audience).map(p => p.audience!))].map(a => <Boton key={a} titulo={`${audiences.includes(a) ? '✓ ' : ''}${a}`} variante="secundario" deshabilitado={role === 'CASHIER'} onPress={() => onAudiences(audiences.includes(a) ? audiences.filter(x => x !== a) : [...audiences, a])}/>)}
 <Sheet visible={open} title="Arma tu combo" subtitle="Elige los productos y sus opciones. Los extras se cobran aparte." onClose={() => setOpen(false)} footer={<View style={{ flexDirection: 'row', gap: 12 }}><Boton titulo="Cancelar" variante="secundario" onPress={() => setOpen(false)}/><Boton titulo="Agregar combo a cuenta" onPress={add}/></View>}><ScrollView contentContainerStyle={{ padding: 20, gap: 18 }}>
 {chips(policy.combos.filter(c => c.active && (!c.channels?.length || c.channels.includes(channel))).map(c => ({ id: c.id, name: c.name + ' · $' + c.price })), comboId, id => { setComboId(id); setSelections({}); setOptions({}); })}
 {combo?.groups.map(g => <View key={g.id} style={{ gap: 16 }}><Text style={tipo.subtitulo}>{g.name}</Text>{Array.from({ length: g.quantity }, (_, i) => { const key = g.id + ':' + i, p = cat.producto.get(selections[key]); return <View key={key} style={{ gap: 12 }}><Text style={tipo.etiqueta}>ELECCIÓN {i + 1}</Text>{chips(products(g.selector).map(p => ({ id: p.uuid, name: p.nombre })), selections[key], id => { setSelections({ ...selections, [key]: id }); setOptions(old => Object.fromEntries(Object.entries(old).filter(([k]) => !k.startsWith(key + ':')))); })}{p?.modifier_groups?.map(id => { const group = cat.grupo.get(id)!; return <View key={id} style={{ gap: 8 }}><Text style={tipo.cuerpo}>{group.name}</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{group.options.filter(o => o.active).map(o => { const k = key + ':' + id, selected = options[k] ?? []; return <Boton key={o.uuid} titulo={`${selected.includes(o.uuid) ? '✓ ' : ''}${o.name} +$${o.price_delta}`} variante="secundario" onPress={() => setOptions({ ...options, [k]: selected.includes(o.uuid) ? selected.filter(x => x !== o.uuid) : group.max_select === 1 ? [o.uuid] : [...selected, o.uuid] })}/>; })}</View></View>; })}</View>; })}</View>)}{error ? <Text accessibilityRole="alert" style={{ color: t.peligro }}>{error}</Text> : null}
 </ScrollView></Sheet></View>;
}
