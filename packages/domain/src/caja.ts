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

export interface ResultadoCorte { expected: string; counted: string; difference: string; }
export function corte(movs: MovCaja[], contado: string): ResultadoCorte {
  const e = efectivoEsperado(movs), c = Dec.de(contado).redondear(2);
  if (c.esNegativo()) throw new Error('El efectivo contado no puede ser negativo.');
  return { expected: e.fijo(2), counted: c.fijo(2), difference: c.menos(e).fijo(2) };
}
