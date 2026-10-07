/**
 * TICKET ESC/POS (puro: sin dependencias nativas, se prueba en Node).
 *
 * ESC/POS es el lenguaje común de las impresoras térmicas de 58/80 mm
 * (Epson, Xprinter, Bixolon, 3nStar...). Los acentos se transliteran: muchas
 * impresoras genéricas no tienen la página de códigos correcta y un "é"
 * impreso como basura es peor que una "e".
 */
export interface Ticket {
  negocio: string; ubicacion: string; folio: string; fecha: string; cajero: string;
  lineas: Array<{ cantidad: string; nombre: string; importe: string }>;
  total: string; pagos: Array<{ metodo: string; monto: string }>; cambio: string; pie?: string;
}

const ESC = 0x1b, GS = 0x1d;
export const ANCHO_58 = 32, ANCHO_80 = 48;

export function ascii(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ñ/g, 'n').replace(/Ñ/g, 'N')
    // Android formatea la hora con espacios angostos (U+202F: "7:05 p.m."): son espacios, no "?".
    .replace(/[  -​  　]/g, ' ').replace(/[^\x20-\x7e]/g, '?');
}

function fila(izq: string, der: string, ancho: number): string {
  const d = ascii(der), i = ascii(izq).slice(0, Math.max(1, ancho - d.length - 1));
  return i + ' '.repeat(Math.max(1, ancho - i.length - d.length)) + d;
}

export function ticketEscPos(t: Ticket, ancho = ANCHO_58): Uint8Array {
  const b: number[] = [];
  const txt = (s: string) => { for (const c of ascii(s)) b.push(c.charCodeAt(0)); b.push(0x0a); };
  const cmd = (...x: number[]) => b.push(...x);
  cmd(ESC, 0x40);                 // inicializar
  cmd(ESC, 0x61, 1);              // centrado
  cmd(ESC, 0x45, 1); txt(t.negocio); cmd(ESC, 0x45, 0);
  txt(t.ubicacion);
  txt(`${t.folio}  ${t.fecha}`);
  txt(`Atendio: ${t.cajero}`);
  cmd(ESC, 0x61, 0);              // izquierda
  txt('-'.repeat(ancho));
  for (const l of t.lineas) txt(fila(`${l.cantidad} ${l.nombre}`, l.importe, ancho));
  txt('-'.repeat(ancho));
  cmd(ESC, 0x45, 1); txt(fila('TOTAL', t.total, ancho)); cmd(ESC, 0x45, 0);
  for (const p of t.pagos) txt(fila(p.metodo, p.monto, ancho));
  if (Number(t.cambio) > 0) txt(fila('Cambio', t.cambio, ancho));
  cmd(ESC, 0x61, 1);
  txt(t.pie ?? 'Gracias por su compra');
  cmd(ESC, 0x64, 4);              // avanzar 4 líneas
  cmd(GS, 0x56, 66, 0);           // corte parcial
  return Uint8Array.from(b);
}

export function ticketHtml(t: Ticket): string {
  const e = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  return `<html><body style="font-family:monospace;width:280px">
<h3 style="text-align:center;margin:0">${e(t.negocio)}</h3><p style="text-align:center;margin:0">${e(t.ubicacion)}<br>${e(t.folio)} · ${e(t.fecha)}<br>Atendió: ${e(t.cajero)}</p><hr>
${t.lineas.map((l) => `<div style="display:flex;justify-content:space-between"><span>${e(l.cantidad)} ${e(l.nombre)}</span><span>${e(l.importe)}</span></div>`).join('')}
<hr><div style="display:flex;justify-content:space-between;font-weight:bold"><span>TOTAL</span><span>${e(t.total)}</span></div>
${t.pagos.map((p) => `<div style="display:flex;justify-content:space-between"><span>${e(p.metodo)}</span><span>${e(p.monto)}</span></div>`).join('')}
${Number(t.cambio) > 0 ? `<div style="display:flex;justify-content:space-between"><span>Cambio</span><span>${e(t.cambio)}</span></div>` : ''}
<p style="text-align:center">${e(t.pie ?? 'Gracias por su compra')}</p></body></html>`;
}
