/**
 * INVENTARIO COMO LEDGER: el stock es una PROYECCIÓN de movimientos.
 *
 * Nunca se sincroniza "stock = 8". Se sincronizan hechos (TRANSFER_IN 40,
 * SALE 1, WASTE 1...) y el stock se recalcula sumándolos. Así dos tablets que
 * venden sin Internet no se pisan: cada una manda SUS movimientos.
 *
 *   EVENT   TRANSFER_IN · SALE · SALE_RETURN · CONSUMPTION · WASTE · ADJUSTMENT · RETURN_TRANSFER_OUT
 *   BRANCH  TRANSFER_OUT · RETURN_TRANSFER_IN
 *
 * La cantidad siempre es positiva salvo en ADJUSTMENT, que lleva signo.
 */
import { Dec } from './decimal.ts';

export type TipoMovimiento =
  | 'TRANSFER_IN' | 'SALE' | 'SALE_RETURN' | 'CONSUMPTION' | 'WASTE' | 'ADJUSTMENT' | 'RETURN_TRANSFER_OUT'
  | 'TRANSFER_OUT' | 'RETURN_TRANSFER_IN';

export const ENTRADAS: TipoMovimiento[] = ['TRANSFER_IN', 'SALE_RETURN', 'RETURN_TRANSFER_IN'];
export const SALIDAS: TipoMovimiento[] = ['SALE', 'CONSUMPTION', 'WASTE', 'RETURN_TRANSFER_OUT', 'TRANSFER_OUT'];
export const TIPOS_EVENT: TipoMovimiento[] = ['TRANSFER_IN', 'SALE', 'SALE_RETURN', 'CONSUMPTION', 'WASTE', 'ADJUSTMENT', 'RETURN_TRANSFER_OUT'];
export const TIPOS_BRANCH: TipoMovimiento[] = ['TRANSFER_OUT', 'RETURN_TRANSFER_IN'];

export interface Movimiento { product_uuid: string; type: TipoMovimiento; quantity: string; }

/** Efecto con signo de un movimiento sobre el stock. */
export function efecto(m: Movimiento): Dec {
  const q = Dec.de(m.quantity);
  if (m.type === 'ADJUSTMENT') return q;
  if (ENTRADAS.includes(m.type)) return q;
  if (SALIDAS.includes(m.type)) return q.neg();
  throw new Error(`Tipo de movimiento desconocido: ${m.type}`);
}

/** Valida un movimiento antes de guardarlo (los de la ubicación equivocada no entran). */
export function validarMovimiento(m: Movimiento, tipoUbicacion: 'EVENT' | 'BRANCH'): void {
  const permitidos = tipoUbicacion === 'EVENT' ? TIPOS_EVENT : TIPOS_BRANCH;
  if (!permitidos.includes(m.type)) throw new Error(`${m.type} no corresponde a una ubicación ${tipoUbicacion}.`);
  const q = Dec.de(m.quantity);
  if (m.type === 'ADJUSTMENT' ? q.esCero() : !q.esPositivo()) throw new Error('La cantidad del movimiento no es válida.');
}

/** Proyección: stock por producto a partir de los movimientos (reconstruible). */
export function proyectarStock(movs: Movimiento[]): Map<string, Dec> {
  const s = new Map<string, Dec>();
  for (const m of movs) s.set(m.product_uuid, (s.get(m.product_uuid) ?? Dec.cero).mas(efecto(m)));
  return s;
}

/** Recepción de transferencia: lo enviado, lo recibido y la diferencia, sin maquillar. */
export function diferenciaTransferencia(enviado: string, recibido: string): { sent: string; received: string; difference: string } {
  const e = Dec.de(enviado), r = Dec.de(recibido);
  if (r.esNegativo()) throw new Error('Lo recibido no puede ser negativo.');
  return { sent: e.fijo(2), received: r.fijo(2), difference: e.menos(r).fijo(2) };
}
