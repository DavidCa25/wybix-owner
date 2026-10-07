/**
 * LADO LOCAL DE LA SINCRONIZACIÓN: outbox e inbox en SQLite.
 *
 *   outbox  lo que ESTA tablet hizo. Sale en orden de `local_seq` (no del
 *           reloj: un reloj mal puesto no reordena nada). Un evento:
 *             APPLIED / DUPLICATE  -> SENT (ya está en la nube)
 *             REJECTED             -> REJECTED (no se borra: queda para diagnóstico)
 *             QUARANTINED          -> QUARANTINED (revisión; no se pierde evidencia)
 *             ERROR / sin red      -> sigue PENDING con reintento programado
 *   inbox   hechos de OTRAS tablets del mismo evento (sus movimientos de
 *           inventario), aplicados una sola vez por event_uuid.
 */
import { Dec, efecto, type TipoMovimiento } from '@wybix/domain';
import type { BaseLocal } from './adaptador.ts';

export interface EventoSalida {
  local_seq: number; event_uuid: string; aggregate_type: string; aggregate_uuid: string; event_type: string;
  occurred_at: string; schema_version: number; payload: unknown; attempts: number;
}

export type Resultado = 'APPLIED' | 'DUPLICATE' | 'REJECTED' | 'QUARANTINED' | 'ERROR';

export async function pendientes(db: BaseLocal, limite: number, ahora: string): Promise<EventoSalida[]> {
  const filas = await db.all<{ local_seq: number; event_uuid: string; aggregate_type: string; aggregate_uuid: string; event_type: string; occurred_at: string; schema_version: number; payload: string; attempts: number }>(
    `SELECT local_seq, event_uuid, aggregate_type, aggregate_uuid, event_type, occurred_at, schema_version, payload, attempts
       FROM outbox WHERE status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY local_seq LIMIT ?`, [ahora, limite]);
  return filas.map((f) => ({ ...f, payload: JSON.parse(f.payload) }));
}

/** Aplica la respuesta de la nube, evento por evento, en una transacción. */
export async function aplicarResultados(db: BaseLocal, res: Array<{ event_uuid: string; result: Resultado; error?: string | null }>,
  ahora: string, siguienteIntento: (intentos: number) => string) {
  return db.transaccion(async (tx) => {
    let enviados = 0, rechazados = 0, cuarentena = 0, reintentar = 0;
    for (const r of res) {
      if (r.result === 'APPLIED' || r.result === 'DUPLICATE') {
        enviados += (await tx.run(`UPDATE outbox SET status = 'SENT', sent_at = ?, last_error = NULL WHERE event_uuid = ? AND status = 'PENDING'`, [ahora, r.event_uuid])).changes;
      } else if (r.result === 'REJECTED' || r.result === 'QUARANTINED') {
        const n = (await tx.run(`UPDATE outbox SET status = ?, last_error = ?, attempts = attempts + 1 WHERE event_uuid = ? AND status = 'PENDING'`,
          [r.result, r.error ?? r.result, r.event_uuid])).changes;
        if (r.result === 'REJECTED') rechazados += n; else cuarentena += n;
      } else {
        const f = await tx.get<{ attempts: number }>('SELECT attempts FROM outbox WHERE event_uuid = ?', [r.event_uuid]);
        const intentos = (f?.attempts ?? 0) + 1;
        reintentar += (await tx.run(`UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE event_uuid = ? AND status = 'PENDING'`,
          [intentos, r.error ?? 'error', siguienteIntento(intentos), r.event_uuid])).changes;
      }
    }
    return { enviados, rechazados, cuarentena, reintentar };
  });
}

/** Sin red: todo el lote se reprograma (no cuenta como rechazo). */
export async function reprogramar(db: BaseLocal, eventos: string[], error: string, siguienteIntento: (intentos: number) => string) {
  if (!eventos.length) return;
  await db.transaccion(async (tx) => {
    for (const e of eventos) {
      const f = await tx.get<{ attempts: number }>('SELECT attempts FROM outbox WHERE event_uuid = ?', [e]);
      const n = (f?.attempts ?? 0) + 1;
      await tx.run(`UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE event_uuid = ? AND status = 'PENDING'`, [n, error, siguienteIntento(n), e]);
    }
  });
}

export async function resumen(db: BaseLocal) {
  const filas = await db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status');
  const c: Record<string, number> = { PENDING: 0, SENT: 0, REJECTED: 0, QUARANTINED: 0 };
  for (const f of filas) c[f.status] = Number(f.n);
  const ultimo = await db.get<{ v: string }>(`SELECT v FROM kv WHERE k = 'last_sync_at'`);
  return { pendientes: c.PENDING, enviados: c.SENT, rechazados: c.REJECTED, cuarentena: c.QUARANTINED, ultima_sincronizacion: ultimo?.v ?? null };
}

export async function marcarSincronizado(db: BaseLocal, ahora: string) {
  await db.run(`INSERT INTO kv (k, v) VALUES ('last_sync_at', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, [ahora]);
}

/**
 * Hechos de OTRAS tablets del mismo evento: sus movimientos de inventario
 * entran a la proyección local (una sola vez). No se bloquea nada: si el
 * stock queda negativo, se avisa y se concilia después; nunca se borra una venta.
 */
export async function aplicarInbox(db: BaseLocal, eventos: Array<{ event_uuid: string; origin_device: string; aggregate_type: string; payload: any }>,
  miDispositivo: string, ahora: string) {
  return db.transaccion(async (tx) => {
    let aplicados = 0;
    for (const e of eventos) {
      if (e.origin_device === miDispositivo) continue;
      if (await tx.get('SELECT 1 FROM inbox WHERE event_uuid = ?', [e.event_uuid])) continue;
      await tx.run('INSERT INTO inbox (event_uuid, origin_device, aggregate_type, received_at, payload) VALUES (?, ?, ?, ?, ?)',
        [e.event_uuid, e.origin_device, e.aggregate_type, ahora, JSON.stringify(e.payload)]);
      const movs: Array<{ uuid: string; product_uuid: string; type: TipoMovimiento; quantity: string }> =
        e.payload?.movements ?? (e.payload?.movement ? [e.payload.movement] : []);
      for (const m of movs) {
        if (await tx.get('SELECT 1 FROM inventory_movements WHERE uuid = ?', [m.uuid])) continue;
        await tx.run(`INSERT INTO inventory_movements (uuid, product_uuid, type, quantity, ref_type, ref_uuid, occurred_at, origin_device) VALUES (?, ?, ?, ?, 'INBOX', ?, ?, ?)`,
          [m.uuid, m.product_uuid, m.type, m.quantity, e.event_uuid, ahora, e.origin_device]);
        const a = await tx.get<{ qty: string }>('SELECT qty FROM stock_projection WHERE product_uuid = ?', [m.product_uuid]);
        await tx.run('INSERT INTO stock_projection (product_uuid, qty) VALUES (?, ?) ON CONFLICT (product_uuid) DO UPDATE SET qty = excluded.qty',
          [m.product_uuid, Dec.de(a?.qty ?? '0').mas(efecto(m)).toString()]);
      }
      aplicados++;
    }
    const negativos = await tx.all<{ product_uuid: string; qty: string }>(`SELECT product_uuid, qty FROM stock_projection`);
    return { aplicados, negativos: negativos.filter((n) => Dec.de(n.qty).esNegativo()) };
  });
}
