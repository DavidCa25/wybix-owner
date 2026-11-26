/**
 * DESVINCULAR LA TABLET DEL NEGOCIO.
 *
 * Deja la base como recién instalada (mismo esquema, cero filas) para que la
 * tablet se pueda enrolar en OTRO negocio. Lo hecho en la tablet solo existe
 * aquí hasta que sube: por eso no se borra mientras haya operaciones sin
 * enviar o un turno abierto. La única excepción (`forzar`) es una tablet que
 * el negocio ya dio de baja: lo suyo nunca va a poder subir.
 */
import type { BaseLocal } from './adaptador.ts';
import { ErrorPos } from './pos.ts';

export interface EstadoDesvincular {
  /** Operaciones que todavía no llegan a Wybix. */
  pendientes: number;
  /** Rechazadas o en cuarentena: se pierden al desvincular. */
  enRevision: number;
  turnoAbierto: boolean;
}

export async function estadoDesvincular(db: BaseLocal): Promise<EstadoDesvincular> {
  const o = await db.get<{ p: number; r: number }>(
    `SELECT COALESCE(SUM(status = 'PENDING'), 0) AS p, COALESCE(SUM(status IN ('REJECTED', 'QUARANTINED')), 0) AS r FROM outbox`);
  const t = await db.get<{ n: number }>(`SELECT count(*) AS n FROM shifts WHERE status = 'OPEN'`);
  return { pendientes: Number(o?.p ?? 0), enRevision: Number(o?.r ?? 0), turnoAbierto: Number(t?.n ?? 0) > 0 };
}

export async function borrarDatosLocales(db: BaseLocal, o: { forzar?: boolean } = {}): Promise<void> {
  if (!o.forzar) {
    const e = await estadoDesvincular(db);
    if (e.turnoAbierto) throw new ErrorPos('DESVINCULAR_TURNO', 'Cierra el turno antes de desvincular la tablet.');
    if (e.pendientes) throw new ErrorPos('DESVINCULAR_PENDIENTES', `Hay ${e.pendientes} ${e.pendientes === 1 ? 'operación' : 'operaciones'} sin enviar. Sincroniza con Internet antes de desvincular.`);
  }
  await db.transaccion(async (tx) => {
    await tx.exec('PRAGMA defer_foreign_keys = ON');
    const tablas = await tx.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'`);
    for (const { name } of tablas) await tx.exec(`DELETE FROM "${name.replace(/"/g, '""')}"`);
    const seq = await tx.get<{ n: number }>(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_sequence'`);
    if (seq?.n) await tx.exec('DELETE FROM sqlite_sequence');
  });
}
