// ============================================================================
//  CORTE DE CAJA POR CORREO
// ----------------------------------------------------------------------------
//  El POS manda los DATOS del corte (nunca HTML) y aquí se arma el correo.
//  Los destinatarios no los elige el POS: salen de la membresía OWNER activa
//  de la empresa del equipo, con acceso a esa ubicación y sin el aviso
//  SHIFT_REPORT apagado (corte_mail_reserve, en Postgres).
//
//  Idempotencia: `id` es el trabajo del POS (uno por corte). Reintentar el
//  mismo corte nunca produce dos correos: la reserva lo marca SENT y la
//  Idempotency-Key de Resend cubre un reintento a medio camino.
// ============================================================================
import { CORS, equipoDe, json, negado, type Rpc } from './nube.ts';

// --------------------------------------------------------------- normalizar
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const txt = (v: unknown, max = 120): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const numONull = (v: unknown): number | null => (v == null || v === '' ? null : num(v));
const lista = <T>(v: unknown, max: number, f: (x: any) => T): T[] => (Array.isArray(v) ? v.slice(0, max).map(f) : []);

export interface Corte {
  uuid: string; folio: number; negocio: string; caja: string;
  abrio: string; cerro: string; autorizo: string; abierto: string; cerrado: string; duracion: string; ciego: boolean;
  ventas: { total: number; tickets: number; descuentos: number; devoluciones: number; iva: number };
  pagos: { metodo: string; importe: number }[];
  arqueo: { fondo: number; esperado: number; contado: number; diferencia: number; dejaEnCaja: number | null };
  efectivo: { grupo: string; concepto: string; total: number; movimientos: number }[];
  movimientos: { hora: string; concepto: string; importe: number; quien: string; nota: string }[];
  productos: { nombre: string; cantidad: number; importe: number }[];
  productosTotal: { productos: number; piezas: number };
  devoluciones: { hora: string; folio: number; importe: number; metodo: string; nota: string; quien: string }[];
  bitacora: { evento: string; veces: number; monto: number | null }[];
  nota: string;
}

/** Del cuerpo del POS a un corte limpio, o null si falta lo esencial. */
export function normalizarCorte(c: any): Corte | null {
  if (!c || typeof c !== 'object' || !UUID.test(c.uuid ?? '') || !Number.isSafeInteger(c.folio) || c.folio < 1) return null;
  const v = c.ventas ?? {}, a = c.arqueo ?? {};
  return {
    uuid: c.uuid, folio: c.folio,
    negocio: txt(c.negocio, 200) || 'Tu negocio', caja: txt(c.caja, 80) || 'Caja',
    abrio: txt(c.abrio, 80), cerro: txt(c.cerro, 80), autorizo: txt(c.autorizo, 80),
    abierto: txt(c.abierto, 40), cerrado: txt(c.cerrado, 40), duracion: txt(c.duracion, 40), ciego: c.ciego === true,
    ventas: { total: num(v.total), tickets: Math.max(0, Math.trunc(num(v.tickets))), descuentos: num(v.descuentos), devoluciones: num(v.devoluciones), iva: num(v.iva) },
    pagos: lista(c.pagos, 20, (p) => ({ metodo: txt(p?.metodo, 40), importe: num(p?.importe) })),
    arqueo: { fondo: num(a.fondo), esperado: num(a.esperado), contado: num(a.contado), diferencia: num(a.diferencia), dejaEnCaja: numONull(a.dejaEnCaja) },
    efectivo: lista(c.efectivo, 40, (e) => ({ grupo: txt(e?.grupo, 20), concepto: txt(e?.concepto, 80), total: num(e?.total), movimientos: Math.max(0, Math.trunc(num(e?.movimientos))) })),
    movimientos: lista(c.movimientos, 100, (m) => ({ hora: txt(m?.hora, 10), concepto: txt(m?.concepto, 80), importe: num(m?.importe), quien: txt(m?.quien, 60), nota: txt(m?.nota, 160) })),
    productos: lista(c.productos, 15, (p) => ({ nombre: txt(p?.nombre, 100), cantidad: num(p?.cantidad), importe: num(p?.importe) })),
    productosTotal: { productos: Math.max(0, Math.trunc(num(c.productosTotal?.productos))), piezas: num(c.productosTotal?.piezas) },
    devoluciones: lista(c.devoluciones, 50, (d) => ({ hora: txt(d?.hora, 10), folio: Math.max(0, Math.trunc(num(d?.folio))), importe: num(d?.importe), metodo: txt(d?.metodo, 40), nota: txt(d?.nota, 160), quien: txt(d?.quien, 60) })),
    bitacora: lista(c.bitacora, 30, (b) => ({ evento: txt(b?.evento, 40), veces: Math.max(0, Math.trunc(num(b?.veces))), monto: numONull(b?.monto) })),
    nota: txt(c.nota, 500),
  };
}

// ------------------------------------------------------------------ textos
const PAGOS: Record<string, string> = {
  EFECTIVO: 'Efectivo', TARJETA: 'Tarjeta', TRANSFERENCIA: 'Transferencia', CREDITO: 'Crédito', MIXTO: 'Mixto',
  PLATAFORMA: 'Plataformas', TERMINAL_MP: 'Terminal Mercado Pago', MERCADO_PAGO: 'Mercado Pago',
};
const EVENTOS: Record<string, string> = {
  CASH_OUT_AUTHORIZED: 'Retiro de efectivo', EXPENSE_AUTHORIZED: 'Egreso', REFUND: 'Devolución',
  SALE_UPDATE: 'Venta modificada', DRAWER_NO_SALE: 'Cajón abierto sin venta', STOCK_ADJUST_AUTHORIZED: 'Ajuste de existencias',
  PURCHASE_AUTHORIZED: 'Compra', SUPPLIER_PAYMENT_AUTHORIZED: 'Pago a proveedor', PRICE_DROP: 'Precio rebajado',
  PRICE_CHANGE: 'Cambio de precio', PROMO_CHANGED: 'Promoción modificada', PROMO_AUTHORIZED: 'Promoción fuera de límite',
  SHIFT_CLOSED: 'Corte cerrado', SHIFT_CLOSED_BY_OTHER: 'Corte cerrado por otra persona', VOID: 'Venta anulada',
  ANULADA: 'Venta anulada', DELETE: 'Producto quitado del ticket', ACTOR_IGNORADO: 'Intento de operar como otra persona',
  APPROVALS_DISABLED: 'Se apagaron las aprobaciones', APPROVALS_ENABLED: 'Se encendieron las aprobaciones',
};
/** Lo que el dueño debería mirar dos veces. */
const VIGILADOS = new Set(['PRICE_DROP', 'PROMO_AUTHORIZED', 'DRAWER_NO_SALE', 'REFUND', 'VOID', 'ANULADA', 'ACTOR_IGNORADO', 'STOCK_ADJUST_AUTHORIZED', 'SHIFT_CLOSED_BY_OTHER', 'APPROVALS_DISABLED']);
/** Cómo se lee cada renglón del arqueo: suma o resta al efectivo esperado. */
const GRUPOS: Record<string, string> = {
  VENTAS: 'Ventas en efectivo', ABONOS: 'Abonos de clientes', ENTRADAS: 'Otras entradas', RETIROS: 'Retiros de caja',
  PROVEEDORES: 'Pagos a proveedores', EGRESOS: 'Egresos', DEVOLUCIONES: 'Devoluciones', AJUSTES: 'Ajustes de venta', OTROS: 'Otros movimientos',
};
const ORDEN_GRUPOS = ['VENTAS', 'ABONOS', 'ENTRADAS', 'RETIROS', 'PROVEEDORES', 'EGRESOS', 'DEVOLUCIONES', 'AJUSTES', 'OTROS'];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const pesos = (n: number) => {
  const [e, d] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}$${e.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${d}`;
};
const cant = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const pago = (m: string) => PAGOS[m.toUpperCase()] ?? (m ? m.charAt(0).toUpperCase() + m.slice(1).toLowerCase() : 'Otro');

/** Cuadró, faltó o sobró: lo primero que el dueño quiere saber. */
export function veredicto(dif: number): { texto: string; color: string; fondo: string } {
  if (Math.abs(dif) < 0.01) return { texto: 'El efectivo cuadró exacto', color: '#166534', fondo: '#DCFCE7' };
  if (dif < 0) return { texto: `Faltaron ${pesos(-dif)} en efectivo`, color: '#991B1B', fondo: '#FEE2E2' };
  return { texto: `Sobraron ${pesos(dif)} en efectivo`, color: '#92400E', fondo: '#FEF3C7' };
}

export function asunto(c: Corte): string {
  const d = c.arqueo.diferencia;
  const estado = Math.abs(d) < 0.01 ? 'cuadró' : d < 0 ? `faltaron ${pesos(-d)}` : `sobraron ${pesos(d)}`;
  return `Corte #${c.folio} · ${c.caja} · ${pesos(c.ventas.total)} · ${estado}`.slice(0, 180);
}

// -------------------------------------------------------------- HTML (correo)
const C = { tinta: '#0F2A3F', texto: '#334155', suave: '#64748B', tenue: '#94A3B8', linea: '#E2E8F0', fondo: '#F1F5F9', panel: '#F8FAFC', acento: '#2563EB' };

const seccion = (titulo: string, cuerpo: string, nota = '') =>
  `<tr><td style="padding:22px 32px 4px 32px;">
<div style="color:${C.tinta};font-size:15px;font-weight:bold;margin:0 0 4px 0;">${esc(titulo)}</div>
${nota ? `<div style="color:${C.suave};font-size:12px;line-height:17px;margin:0 0 10px 0;">${esc(nota)}</div>` : '<div style="height:6px;"></div>'}
${cuerpo}</td></tr>`;

const tabla = (filas: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;color:${C.texto};">${filas}</table>`;

const fila = (izq: string, der: string, o: { negrita?: boolean; color?: string; borde?: boolean; sub?: string } = {}) =>
  `<tr><td style="padding:7px 0;${o.borde === false ? '' : `border-bottom:1px solid ${C.linea};`}${o.negrita ? 'font-weight:bold;' : ''}${o.color ? `color:${o.color};` : ''}">${izq}${o.sub ? `<div style="color:${C.tenue};font-size:12px;font-weight:normal;">${o.sub}</div>` : ''}</td>
<td align="right" style="padding:7px 0;white-space:nowrap;${o.borde === false ? '' : `border-bottom:1px solid ${C.linea};`}${o.negrita ? 'font-weight:bold;' : ''}${o.color ? `color:${o.color};` : ''}">${der}</td></tr>`;

const encabezados = (cols: { t: string; der?: boolean }[]) =>
  `<tr>${cols.map((c) => `<td ${c.der ? 'align="right" ' : ''}style="padding:6px 0;color:${C.tenue};font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${C.linea};">${esc(c.t)}</td>`).join('')}</tr>`;

const kpi = (etiqueta: string, valor: string) =>
  `<td width="33%" align="center" style="padding:14px 6px;background-color:${C.panel};border-radius:10px;">
<div style="color:${C.suave};font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">${esc(etiqueta)}</div>
<div style="color:${C.tinta};font-size:19px;font-weight:bold;margin-top:4px;">${esc(valor)}</div></td>`;

export function corteHtml(c: Corte): string {
  const v = veredicto(c.arqueo.diferencia);
  const promedio = c.ventas.tickets ? c.ventas.total / c.ventas.tickets : 0;
  const totalPagos = c.pagos.reduce((s, p) => s + p.importe, 0) || 1;

  // ¿Quién y cuándo?
  const quien = tabla(
    fila('Abrió el turno', esc(c.abrio || '—')) +
    fila('Cerró el turno', esc(c.cerro || '—')) +
    (c.autorizo && c.autorizo !== c.cerro ? fila('Autorizó el cierre', esc(c.autorizo), { color: '#92400E' }) : '') +
    fila('Apertura', esc(c.abierto || '—')) +
    fila('Cierre', esc(c.cerrado || '—'), { sub: c.duracion ? `Turno de ${esc(c.duracion)}` : '' }) +
    fila('Conteo del efectivo', c.ciego ? 'A ciegas (sin ver el esperado)' : 'Viendo el esperado', { borde: false }),
  );

  // Ventas por forma de pago, con su proporción.
  const pagos = c.pagos.length
    ? tabla(encabezados([{ t: 'Forma de pago' }, { t: '%', der: true }, { t: 'Importe', der: true }]) +
        c.pagos.slice().sort((a, b) => b.importe - a.importe).map((p) => {
          const pct = Math.max(0, Math.min(100, Math.round((p.importe / totalPagos) * 100)));
          return `<tr><td style="padding:8px 0;border-bottom:1px solid ${C.linea};">${esc(pago(p.metodo))}
<div style="height:5px;background-color:${C.linea};border-radius:3px;margin-top:5px;width:100%;"><div style="height:5px;width:${pct}%;background-color:${C.acento};border-radius:3px;"></div></div></td>
<td align="right" style="padding:8px 0 8px 12px;border-bottom:1px solid ${C.linea};color:${C.suave};">${pct}%</td>
<td align="right" style="padding:8px 0 8px 12px;border-bottom:1px solid ${C.linea};white-space:nowrap;">${pesos(p.importe)}</td></tr>`;
        }).join('') +
        `<tr><td colspan="2" style="padding:8px 0;font-weight:bold;">Total vendido</td><td align="right" style="padding:8px 0 8px 12px;font-weight:bold;white-space:nowrap;">${pesos(c.ventas.total)}</td></tr>`)
    : `<div style="color:${C.suave};font-size:14px;">No hubo ventas en este turno.</div>`;

  // Resumen de ventas.
  const resumen = tabla(
    fila('Ventas cobradas', pesos(c.ventas.total), { sub: `${c.ventas.tickets} ticket${c.ventas.tickets === 1 ? '' : 's'}` }) +
    (c.ventas.descuentos ? fila('Descuentos y promociones otorgados', pesos(-c.ventas.descuentos), { sub: 'Ya están restados del total cobrado' }) : '') +
    (c.ventas.devoluciones ? fila('Devoluciones', pesos(-c.ventas.devoluciones), { color: '#991B1B' }) : '') +
    fila('Venta neta del turno', pesos(c.ventas.total - c.ventas.devoluciones), { negrita: true }) +
    (c.ventas.iva ? fila('IVA incluido en las ventas', pesos(c.ventas.iva), { borde: false, sub: 'Informativo: ya forma parte del total' }) : ''),
  );

  // Arqueo: fondo + cada renglón = esperado; contado; diferencia.
  const renglones = c.efectivo.slice().sort((a, b) => ORDEN_GRUPOS.indexOf(a.grupo) - ORDEN_GRUPOS.indexOf(b.grupo));
  const arqueo = tabla(
    fila('Fondo inicial', pesos(c.arqueo.fondo)) +
    renglones.map((r) => fila(
      `${r.total >= 0 ? '+' : '−'} ${esc(r.concepto || GRUPOS[r.grupo] || r.grupo)}`,
      pesos(r.total),
      { sub: `${GRUPOS[r.grupo] && r.concepto && r.concepto !== GRUPOS[r.grupo] ? esc(GRUPOS[r.grupo]) + ' · ' : ''}${r.movimientos} movimiento${r.movimientos === 1 ? '' : 's'}`, color: r.total < 0 ? '#991B1B' : undefined },
    )).join('') +
    fila('Efectivo que debía haber', pesos(c.arqueo.esperado), { negrita: true }) +
    fila('Efectivo contado', pesos(c.arqueo.contado), { negrita: true }) +
    fila('Diferencia', pesos(c.arqueo.diferencia), { negrita: true, color: v.color }) +
    (c.arqueo.dejaEnCaja != null
      ? fila('Se queda en caja (fondo del siguiente turno)', pesos(c.arqueo.dejaEnCaja)) +
        fila('Se retira de la caja', pesos(Math.max(0, c.arqueo.contado - c.arqueo.dejaEnCaja)), { borde: false })
      : ''),
  );

  const movimientos = c.movimientos.length
    ? tabla(encabezados([{ t: 'Hora' }, { t: 'Concepto' }, { t: 'Importe', der: true }]) +
        c.movimientos.map((m) => `<tr><td style="padding:7px 8px 7px 0;border-bottom:1px solid ${C.linea};color:${C.suave};white-space:nowrap;vertical-align:top;">${esc(m.hora)}</td>
<td style="padding:7px 0;border-bottom:1px solid ${C.linea};">${esc(m.concepto)}${m.quien || m.nota ? `<div style="color:${C.tenue};font-size:12px;">${esc([m.quien, m.nota].filter(Boolean).join(' · '))}</div>` : ''}</td>
<td align="right" style="padding:7px 0 7px 12px;border-bottom:1px solid ${C.linea};white-space:nowrap;vertical-align:top;${m.importe < 0 ? 'color:#991B1B;' : ''}">${pesos(m.importe)}</td></tr>`).join(''))
    : '';

  const productos = c.productos.length
    ? tabla(encabezados([{ t: 'Producto' }, { t: 'Cant.', der: true }, { t: 'Importe', der: true }]) +
        c.productos.map((p, i) => `<tr><td style="padding:7px 0;border-bottom:1px solid ${C.linea};"><span style="color:${C.tenue};">${i + 1}.</span> ${esc(p.nombre)}</td>
<td align="right" style="padding:7px 0 7px 12px;border-bottom:1px solid ${C.linea};color:${C.suave};">${cant(p.cantidad)}</td>
<td align="right" style="padding:7px 0 7px 12px;border-bottom:1px solid ${C.linea};white-space:nowrap;">${pesos(p.importe)}</td></tr>`).join(''))
    : '';

  const devoluciones = c.devoluciones.length
    ? tabla(encabezados([{ t: 'Hora' }, { t: 'Venta' }, { t: 'Importe', der: true }]) +
        c.devoluciones.map((d) => `<tr><td style="padding:7px 8px 7px 0;border-bottom:1px solid ${C.linea};color:${C.suave};vertical-align:top;">${esc(d.hora)}</td>
<td style="padding:7px 0;border-bottom:1px solid ${C.linea};">Folio #${d.folio} · ${esc(pago(d.metodo))}${d.quien || d.nota ? `<div style="color:${C.tenue};font-size:12px;">${esc([d.quien, d.nota].filter(Boolean).join(' · '))}</div>` : ''}</td>
<td align="right" style="padding:7px 0 7px 12px;border-bottom:1px solid ${C.linea};color:#991B1B;white-space:nowrap;vertical-align:top;">${pesos(-d.importe)}</td></tr>`).join(''))
    : '';

  const bitacora = c.bitacora.filter((b) => b.evento !== 'SHIFT_CLOSED');
  const alertas = bitacora.length
    ? tabla(bitacora.map((b) => fila(
        `${VIGILADOS.has(b.evento) ? '<span style="color:#B45309;">&#9888;</span> ' : ''}${esc(EVENTOS[b.evento] ?? b.evento)}`,
        `${b.veces} vez${b.veces === 1 ? '' : 'es'}${b.monto ? ` · ${pesos(b.monto)}` : ''}`,
      )).join(''))
    : '';

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(asunto(c))}</title></head>
<body style="margin:0;padding:0;background-color:${C.fondo};font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(v.texto)} · ${pesos(c.ventas.total)} vendidos en ${c.ventas.tickets} tickets.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${C.fondo};padding:28px 0;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:94%;background-color:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td style="background-color:${C.tinta};padding:24px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle;"><div style="color:#94A3B8;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Corte de caja</div>
<div style="color:#ffffff;font-size:22px;font-weight:bold;margin-top:4px;">#${c.folio} · ${esc(c.caja)}</div>
<div style="color:#CBD5E1;font-size:14px;margin-top:4px;">${esc(c.negocio)}</div></td>
<td align="right" style="vertical-align:middle;"><img src="https://wybixpos.com.mx/logo-wybix.png" alt="Wybix" width="44" height="44" style="display:block;border:0;outline:none;"></td>
</tr></table></td></tr>
<tr><td style="padding:22px 32px 0 32px;"><div style="background-color:${v.fondo};color:${v.color};border-radius:10px;padding:14px 16px;font-size:16px;font-weight:bold;">${esc(v.texto)}
<div style="font-size:13px;font-weight:normal;margin-top:3px;">Debía haber ${pesos(c.arqueo.esperado)} y se contaron ${pesos(c.arqueo.contado)}.</div></div></td></tr>
<tr><td style="padding:16px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
${kpi('Vendido', pesos(c.ventas.total))}<td width="8"></td>${kpi('Tickets', String(c.ventas.tickets))}<td width="8"></td>${kpi('Ticket promedio', pesos(promedio))}
</tr></table></td></tr>
${seccion('Quién y cuándo', quien)}
${seccion('Ventas por forma de pago', pagos, 'Todo lo cobrado en el turno, sin importar cómo se pagó.')}
${seccion('Resumen de ventas', resumen)}
${seccion('Arqueo de efectivo', arqueo, 'Solo el dinero físico del cajón: el fondo, lo que entró y lo que salió en efectivo.')}
${movimientos ? seccion('Entradas y salidas de efectivo', movimientos, 'Retiros, egresos, pagos y entradas registrados en el turno (sin contar las ventas).') : ''}
${devoluciones ? seccion('Devoluciones', devoluciones) : ''}
${productos ? seccion('Lo más vendido', productos, `${c.productosTotal.productos} producto${c.productosTotal.productos === 1 ? '' : 's'} distinto${c.productosTotal.productos === 1 ? '' : 's'}, ${cant(c.productosTotal.piezas)} piezas en total.`) : ''}
${alertas ? seccion('Autorizaciones y alertas', alertas, 'Lo marcado con ⚠ conviene revisarlo.') : ''}
${c.nota ? seccion('Nota del cierre', `<div style="background-color:${C.panel};border-left:3px solid ${C.acento};padding:10px 14px;color:${C.texto};font-size:14px;line-height:20px;">${esc(c.nota)}</div>`) : ''}
<tr><td style="padding:24px 32px 28px 32px;"><p style="color:${C.tenue};font-size:12px;line-height:18px;margin:0;border-top:1px solid ${C.linea};padding-top:16px;">Recibes este correo porque eres dueño de ${esc(c.negocio)} en Wybix. Puedes apagarlo desde la app Owner: Avisos · Corte de caja detallado.</p></td></tr>
</table></td></tr></table></body></html>`;
}

/** La versión de texto plano: la misma información, para lectores sin HTML. */
export function corteTexto(c: Corte): string {
  const l: string[] = [`CORTE DE CAJA #${c.folio} · ${c.caja}`, c.negocio, '', veredicto(c.arqueo.diferencia).texto, ''];
  l.push(`Abrió: ${c.abrio || '—'} · ${c.abierto}`, `Cerró: ${c.cerro || '—'} · ${c.cerrado}`);
  if (c.autorizo && c.autorizo !== c.cerro) l.push(`Autorizó: ${c.autorizo}`);
  l.push('', `Vendido: ${pesos(c.ventas.total)} en ${c.ventas.tickets} tickets`);
  for (const p of c.pagos) l.push(`  ${pago(p.metodo)}: ${pesos(p.importe)}`);
  if (c.ventas.devoluciones) l.push(`Devoluciones: ${pesos(-c.ventas.devoluciones)}`);
  l.push('', 'ARQUEO DE EFECTIVO', `  Fondo inicial: ${pesos(c.arqueo.fondo)}`);
  for (const r of c.efectivo) l.push(`  ${r.concepto || GRUPOS[r.grupo] || r.grupo}: ${pesos(r.total)}`);
  l.push(`  Debía haber: ${pesos(c.arqueo.esperado)}`, `  Contado: ${pesos(c.arqueo.contado)}`, `  Diferencia: ${pesos(c.arqueo.diferencia)}`);
  if (c.arqueo.dejaEnCaja != null) l.push(`  Se queda en caja: ${pesos(c.arqueo.dejaEnCaja)}`);
  if (c.nota) l.push('', `Nota: ${c.nota}`);
  l.push('', '— Wybix');
  return l.join('\n');
}

// ------------------------------------------------------------------ handler
export async function corteEmail(req: Request, deps: { rpc: Rpc; fetch: typeof fetch; key?: string; from?: string }): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'Método no permitido.' }, 405);
  const eq = await equipoDe(req, deps.rpc); if (!eq) return negado('BAD_TOKEN');
  if (!deps.key || !deps.from) return json({ success: false, code: 'MAIL_NOT_CONFIGURED', error: 'Falta configurar el remitente de correos.' }, 503);
  const raw = await req.text(); if (raw.length > 300000) return json({ success: false, error: 'El corte es demasiado grande.' }, 413);
  let b: any; try { b = JSON.parse(raw); } catch { return json({ success: false, error: 'Datos inválidos.' }, 400); }
  const corte = normalizarCorte(b?.corte);
  if (!UUID.test(b?.id ?? '') || !corte) return json({ success: false, error: 'Corte inválido.' }, 400);

  const a = await deps.rpc('corte_mail_reserve', { id: b.id, device_id: eq.device_id, closure_uuid: corte.uuid });
  if (!a?.ok) {
    const msg: Record<string, string> = {
      NO_RECIPIENTS: 'El negocio no tiene dueños con el aviso de cortes encendido en Owner.',
      RATE_LIMIT: 'Se alcanzó el límite de correos por hora. Reintenta más tarde.',
      BUSY: 'Este corte se está enviando en este momento.',
    };
    return json({ success: false, code: a?.code, error: msg[a?.code] ?? 'El envío no se pudo reservar.' }, a?.code === 'NO_RECIPIENTS' ? 422 : 409);
  }
  if (a.sent) return json({ success: true, accepted: true, recipients: a.recipients ?? 0, already: true });

  const destinos: string[] = (Array.isArray(a.destinos) ? a.destinos : []).filter((d: unknown) => typeof d === 'string' && /^\S+@\S+\.\S+$/.test(d)).slice(0, 10);
  const html = corteHtml(corte), text = corteTexto(corte), subject = asunto(corte);
  const ids: string[] = [];
  // Uno por destinatario: los dueños no ven el correo de los demás.
  for (const [i, to] of destinos.entries()) {
    const r = await deps.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `wybix-corte-${b.id}-${i}` },
      body: JSON.stringify({ from: deps.from, to: [to], subject, html, text }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return json({ success: false, code: 'MAIL_PROVIDER', error: 'El proveedor no confirmó el envío. Reintenta: no se duplicará.' }, 502);
    const out = await r.json().catch(() => ({}));
    if (out?.id) ids.push(String(out.id));
  }
  await deps.rpc('corte_mail_complete', { id: b.id, device_id: eq.device_id, recipients: destinos.length, provider_ids: ids });
  return json({ success: true, accepted: true, recipients: destinos.length });
}
