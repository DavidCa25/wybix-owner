/**
 * SPIKE 2.5 · COBRO CON TERMINAL (Mercado Pago Point u otro) SIN DOBLE COBRO.
 *
 * El riesgo real: la terminal aprueba el pago y justo entonces la tablet pierde
 * la red. Si la app "reintenta" creando OTRO cobro, el cliente paga dos veces.
 *
 * Reglas (todas persistidas en `payment_intents` ANTES de hablar con nadie):
 *   1. Una intención por venta: `sale_uuid` es la referencia externa.
 *   2. Llave de idempotencia ESTABLE por intento: `wx-<sale_uuid>-<n>`. Si la
 *      app reenvía la misma intención, el proveedor la reconoce y no cobra otra.
 *   3. Sin respuesta (red caída) NO es "falló": es UNKNOWN. Mientras haya una
 *      intención CREATED / PENDING / UNKNOWN / APPROVED, no se puede crear otra
 *      para esa venta (índice único `ux_payment_intents_activa`).
 *   4. Una UNKNOWN se resuelve CONSULTANDO al proveedor (por la llave o la
 *      referencia), nunca cobrando de nuevo.
 *   5. Solo un REJECTED o CANCELLED confirmado permite un intento nuevo.
 *
 * La venta se registra hasta que el cobro esté APPROVED. Sin red no hay cobro
 * con terminal: el cajero ve el estado y puede cobrar en efectivo.
 *
 * El proveedor real (Mercado Pago) se llama a través de la nube (la llave de
 * acceso NUNCA vive en la tablet). Ver docs/fase2-spikes.md: bloqueo por
 * credenciales y terminal física.
 */
import { Dec, uuidv7 } from '@wybix/domain';
import type { BaseLocal } from './adaptador.ts';

export type EstadoCobro = 'CREATED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'UNKNOWN';

export interface ProveedorCobro {
  nombre: string;
  crear(i: { sale_uuid: string; amount: string; idempotency_key: string }): Promise<{ status: 'PENDING' | 'APPROVED' | 'REJECTED'; external_id?: string | null }>;
  consultar(i: { sale_uuid: string; idempotency_key: string; external_id: string | null }): Promise<{ status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'NOT_FOUND'; external_id?: string | null }>;
}

export interface Intento { intent_uuid: string; sale_uuid: string; status: EstadoCobro; idempotency_key: string; external_id: string | null; amount: string; }

const activa = (s: EstadoCobro) => s === 'CREATED' || s === 'PENDING' || s === 'UNKNOWN' || s === 'APPROVED';

async function guardar(db: BaseLocal, i: Intento, error: string | null, ahora: string) {
  await db.run('UPDATE payment_intents SET status = ?, external_id = ?, last_error = ?, updated_at = ? WHERE intent_uuid = ?', [i.status, i.external_id, error, ahora, i.intent_uuid]);
}

export async function intentosDe(db: BaseLocal, saleUuid: string): Promise<Intento[]> {
  return db.all('SELECT intent_uuid, sale_uuid, status, idempotency_key, external_id, amount FROM payment_intents WHERE sale_uuid = ? ORDER BY created_at', [saleUuid]);
}

/** Inicia (o retoma) el cobro de una venta. Nunca crea un segundo cobro activo. */
export async function iniciarCobro(db: BaseLocal, prov: ProveedorCobro, saleUuid: string, monto: string, ahora = () => new Date().toISOString()): Promise<Intento> {
  const previos = await intentosDe(db, saleUuid);
  const vigente = previos.find((p) => activa(p.status));
  if (vigente) return vigente.status === 'UNKNOWN' || vigente.status === 'CREATED' || vigente.status === 'PENDING' ? reconciliarCobro(db, prov, vigente, ahora) : vigente;

  const i: Intento = { intent_uuid: uuidv7(), sale_uuid: saleUuid, status: 'CREATED', idempotency_key: `wx-${saleUuid}-${previos.length + 1}`,
                       external_id: null, amount: Dec.de(monto).fijo(2) };
  // Persistido ANTES de llamar: si la app muere aquí, al volver se ve el intento.
  await db.run(`INSERT INTO payment_intents (intent_uuid, sale_uuid, provider, amount, idempotency_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'CREATED', ?, ?)`,
    [i.intent_uuid, saleUuid, prov.nombre, i.amount, i.idempotency_key, ahora(), ahora()]);
  try {
    const r = await prov.crear({ sale_uuid: saleUuid, amount: i.amount, idempotency_key: i.idempotency_key });
    i.status = r.status; i.external_id = r.external_id ?? null;
    await guardar(db, i, null, ahora());
  } catch (e) {
    // No sabemos si cobró: UNKNOWN, y se consulta después. Jamás se reintenta "a ciegas".
    i.status = 'UNKNOWN';
    await guardar(db, i, (e as Error).message, ahora());
  }
  return i;
}

/** Pregunta al proveedor por un intento sin respuesta clara. */
export async function reconciliarCobro(db: BaseLocal, prov: ProveedorCobro, i: Intento, ahora = () => new Date().toISOString()): Promise<Intento> {
  try {
    const r = await prov.consultar({ sale_uuid: i.sale_uuid, idempotency_key: i.idempotency_key, external_id: i.external_id });
    if (r.status === 'NOT_FOUND') {
      // El proveedor nunca lo recibió: reenviar con LA MISMA llave es seguro.
      const c = await prov.crear({ sale_uuid: i.sale_uuid, amount: i.amount, idempotency_key: i.idempotency_key });
      i.status = c.status; i.external_id = c.external_id ?? i.external_id;
    } else {
      i.status = r.status; i.external_id = r.external_id ?? i.external_id;
    }
    await guardar(db, i, null, ahora());
  } catch (e) {
    i.status = 'UNKNOWN';
    await guardar(db, i, (e as Error).message, ahora());
  }
  return i;
}
