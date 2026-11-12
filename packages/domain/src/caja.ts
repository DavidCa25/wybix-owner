/**
 * CAJA Y CORTE: el mismo concepto de turno (Shift) de la Fase 1.
 *
 * Esperado = fondo + efectivo neto de ventas + entradas - retiros - egresos.
 * Solo el EFECTIVO toca la caja: una venta con tarjeta o transferencia no
 * cambia lo que debe haber en el cajón.
 */
import { Dec } from './decimal.ts';

export type TipoCaja = 'OPENING' | 'SALE_CASH' | 'CASH_IN' | 'CASH_OUT' | 'EXPENSE' | 'SALE_RETURN_CASH';
export interface MovCaja { type: TipoCaja; amount: string; }

export function efectivoEsperado(movs: MovCaja[]): Dec {
  let t = Dec.cero;
  for (const m of movs) {
    const a = Dec.de(m.amount);
    if (m.type === 'OPENING' || m.type === 'SALE_CASH' || m.type === 'CASH_IN') t = t.mas(a);
    else if (m.type === 'CASH_OUT' || m.type === 'EXPENSE' || m.type === 'SALE_RETURN_CASH') t = t.menos(a);
  }
  return t.redondear(2);
}

/** Las partes del esperado, para mostrar de dónde sale (mismas reglas que efectivoEsperado). */
export interface DesgloseCaja { fondo: string; ventas_efectivo: string; entradas: string; retiros: string; egresos: string; devoluciones: string; }
export function desgloseCaja(movs: MovCaja[]): DesgloseCaja {
  const suma = (t: TipoCaja) => Dec.suma(movs.filter((m) => m.type === t).map((m) => m.amount)).fijo(2);
  return { fondo: suma('OPENING'), ventas_efectivo: suma('SALE_CASH'), entradas: suma('CASH_IN'), retiros: suma('CASH_OUT'), egresos: suma('EXPENSE'), devoluciones: suma('SALE_RETURN_CASH') };
}

export interface ResultadoCorte { expected: string; counted: string; difference: string; }
export function corte(movs: MovCaja[], contado: string): ResultadoCorte {
  const e = efectivoEsperado(movs), c = Dec.de(contado).redondear(2);
  if (c.esNegativo()) throw new Error('El efectivo contado no puede ser negativo.');
  return { expected: e.fijo(2), counted: c.fijo(2), difference: c.menos(e).fijo(2) };
}
