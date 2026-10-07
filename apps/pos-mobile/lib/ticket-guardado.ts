import type { PosLocal, Persona } from '@wybix/database';
import type { Ticket } from './escpos.ts';
import { puede } from '@wybix/domain';

const dinero = (n: string) => Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

/** Solo lee la venta persistida; no depende del checkout ni del catálogo actual. */
export async function ticketGuardado(pos: PosLocal, saleUuid: string): Promise<Ticket> {
  const t = await pos.datosTicket(saleUuid);
  return {
    negocio: t.negocio, ubicacion: `Caja ${t.caja}`, folio: t.folio,
    fecha: new Date(t.occurred_at).toLocaleString('es-MX'), cajero: t.cajero,
    lineas: t.lineas.map(l => ({ cantidad: l.cantidad, nombre: l.nombre, importe: dinero(l.subtotal) })),
    total: dinero(t.total), pagos: t.pagos.map(p => ({ metodo: p.metodo, monto: dinero(p.monto) })),
    cambio: t.cambio, ...(t.copia ? { pie: 'COPIA' } : {}),
  };
}

/** El resultado se guarda incluso si el transporte falla. Sin impresora queda pendiente. */
export async function imprimirGuardado(pos: PosLocal, impresora: { tipo: string; imprimir(t: Ticket): Promise<void> }, saleUuid: string, reimprime?: Persona) {
  if (reimprime && !puede(reimprime.role, 'REIMPRIMIR')) throw new Error('No tienes permiso para reimprimir.');
  if (impresora.tipo === 'ninguna') throw new Error('Configura una impresora para imprimir el ticket.');
  const t = await ticketGuardado(pos, saleUuid);
  let error: Error | null = null;
  try { await impresora.imprimir(t); }
  catch (e) { error = e instanceof Error ? e : new Error(String(e)); }
  if (reimprime) await pos.registrarReimpresion(reimprime, saleUuid, !error, error?.message);
  else await pos.resultadoImpresion(saleUuid, !error, error?.message);
  if (error) throw error;
}
