// ============================================================================
//  NÚCLEO DEL PANEL DE ADMINISTRACIÓN: tipos, roles y patrón COMANDO
// ----------------------------------------------------------------------------
//  Cada operación del panel es un `Comando`: nombre, rol mínimo, esquema de
//  entrada y un `ejecutar` que llama a UNA función de Postgres. El manejador
//  HTTP no conoce ninguna operación: busca el comando en el `Registro`,
//  autoriza, valida, ejecuta y audita. Agregar una operación = declarar un
//  comando; nada más cambia (abierto/cerrado).
//
//  La lógica de negocio y sus invariantes viven en Postgres (SECURITY
//  DEFINER, solo service_role). Aquí no se decide nada del negocio.
// ============================================================================
import type { Infer, Validador } from './validar.ts';

export type Rol = 'VIEWER' | 'OPERATOR' | 'OWNER';
const RANGO: Record<Rol, number> = { VIEWER: 1, OPERATOR: 2, OWNER: 3 };
export const alcanza = (tiene: Rol, pide: Rol): boolean => RANGO[tiene] >= RANGO[pide];

export interface Actor { id: string; email: string | null; rol: Rol }

/** Puerto hacia Postgres: una función con argumentos con nombre. */
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

export interface Contexto {
  actor: Actor;
  rpc: Rpc;
  /** Lo que queda escrito como autor en license_events / cloud_audit. */
  firma: string;
  /** Comandos que este actor puede ejecutar (el panel oculta los demás). */
  permitidos: string[];
}

export type Resultado =
  | { ok: true; data: unknown }
  | { ok: false; code: string; error: string };

export interface Comando<I = any> {
  nombre: string;
  /** `consulta` no cambia nada y no se audita salvo si se niega. */
  tipo: 'consulta' | 'cambio';
  rol: Rol;
  entrada: Validador<I>;
  /** Qué toca (licencia, negocio, equipo…): para la bitácora y su filtro. */
  objetivo?: (i: I) => string | null;
  motivo?: (i: I) => string | null;
  ejecutar: (i: I, ctx: Contexto) => Promise<Resultado>;
}

/** Fábrica tipada: `I` se infiere SOLO del esquema de entrada. */
export const comando = <V extends Validador<any>>(c: { entrada: V } & Omit<Comando<Infer<V>>, 'entrada'>): Comando<Infer<V>> => c;

export class Registro {
  private readonly mapa = new Map<string, Comando>();
  constructor(comandos: Comando[]) {
    for (const c of comandos) {
      if (this.mapa.has(c.nombre)) throw new Error(`Comando duplicado: ${c.nombre}`);
      this.mapa.set(c.nombre, c);
    }
  }
  obtener(nombre: string): Comando | undefined { return this.mapa.get(nombre); }
  nombres(): string[] { return [...this.mapa.keys()].sort(); }
  /** Lo que un rol puede hacer (el panel oculta lo demás). */
  permitidos(rol: Rol): string[] { return this.nombres().filter((n) => alcanza(rol, this.mapa.get(n)!.rol)); }
}

/**
 * Llama a una función de Postgres y normaliza su respuesta:
 *   - error de PostgREST          -> DB_ERROR (el detalle va a la bitácora, no al navegador)
 *   - `{ ok: false, code, error }` -> el mismo código y mensaje (son para el usuario)
 *   - `null` en una consulta       -> NOT_FOUND
 *   - lo demás                    -> ok
 */
export async function llamar(ctx: Contexto, fn: string, args: Record<string, unknown>, vacioEsNoEncontrado = false): Promise<Resultado> {
  const { data, error } = await ctx.rpc(fn, args);
  if (error) return { ok: false, code: 'DB_ERROR', error: error.message };
  if (data && typeof data === 'object' && (data as { ok?: unknown }).ok === false) {
    const d = data as { code?: string; error?: string };
    return { ok: false, code: d.code ?? 'REJECTED', error: d.error ?? 'La operación no se pudo completar.' };
  }
  if (data == null && vacioEsNoEncontrado) return { ok: false, code: 'NOT_FOUND', error: 'No encontrado.' };
  return { ok: true, data };
}
