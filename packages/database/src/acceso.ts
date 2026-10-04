/**
 * QUIÉN ESTÁ EN LA TABLET: persona elegida + su PIN, sin Internet.
 *
 * El rol que devuelve es el que esa persona tiene EN ESTE EVENT (viene del
 * snapshot por ubicación), no el de su sucursal. Cada intento, bueno o malo,
 * queda en la auditoría local — sin el PIN.
 */
import { evaluarIntento, pinCoincide, bloqueoVigente, type ResultadoPin } from '@wybix/auth';
import type { RolEvento } from '@wybix/domain';
import type { BaseLocal } from './adaptador.ts';
import type { Persona } from './pos.ts';

export async function personal(db: BaseLocal): Promise<Array<{ uuid: string; name: string; role: RolEvento }>> {
  return db.all(`SELECT uuid, name, role FROM staff WHERE active = 1 ORDER BY name`);
}

/** Tiempo de cada etapa (ms), para medir en el dispositivo. Nunca incluye el PIN. */
export interface MedicionPin { lectura: number; scrypt: number; escritura: number; total: number }

export async function identificar(db: BaseLocal, staffUuid: string, pin: string, ahora: Date = new Date(),
  medir?: (m: MedicionPin) => void): Promise<{ ok: true; persona: Persona } | (ResultadoPin & { ok: false })> {
  const reloj = () => (globalThis.performance?.now?.() ?? Date.now());
  const t0 = reloj();
  type Fila = { uuid: string; name: string; role: RolEvento; pin_hash: string; pin_sal: string; pin_algo: string; active: number };
  const p = await db.get<Fila>('SELECT uuid, name, role, pin_hash, pin_sal, pin_algo, active FROM staff WHERE uuid = ?', [staffUuid]);
  const previo = await db.get<{ failures: number; locked_until: string | null }>('SELECT failures, locked_until FROM pin_attempts WHERE staff_uuid = ?', [staffUuid]);
  const t1 = reloj();
  // El scrypt va FUERA de la transacción: no retiene la base ni la pantalla.
  // Bloqueado: no se calcula nada.
  const persona = p ? { ...p, active: p.active === 1 } : null;
  const coincide = bloqueoVigente(previo, ahora) ? false : await pinCoincide(pin, persona);
  const t2 = reloj();
  const salida = await db.transaccion(async (tx) => {
    // Se releen los intentos: dos intentos a la vez no se saltan el límite.
    const intentos = await tx.get<{ failures: number; locked_until: string | null }>('SELECT failures, locked_until FROM pin_attempts WHERE staff_uuid = ?', [staffUuid]);
    const r = evaluarIntento(coincide, persona, intentos, ahora);
    await tx.run(`INSERT INTO pin_attempts (staff_uuid, failures, locked_until) VALUES (?, ?, ?)
                  ON CONFLICT (staff_uuid) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`,
      [staffUuid, r.intentos.failures, r.intentos.locked_until]);
    await tx.run('INSERT INTO audit_local (at, employee_uuid, action, result, detail) VALUES (?, ?, ?, ?, ?)',
      [ahora.toISOString(), staffUuid, 'PIN', r.resultado.ok ? 'OK' : (r.resultado.bloqueado ? 'BLOQUEADO' : 'FALLO'), null]);
    if (!r.resultado.ok || !p) return { ...(r.resultado as Exclude<ResultadoPin, { ok: true }>), ok: false as const };
    return { ok: true as const, persona: { uuid: p.uuid, name: p.name, role: p.role } };
  });
  const t3 = reloj();
  medir?.({ lectura: t1 - t0, scrypt: t2 - t1, escritura: t3 - t2, total: t3 - t0 });
  return salida;
}
