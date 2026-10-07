/**
 * QUÉ PUEDE HACER CADA ROL EN UN EVENT (autorización LOCAL, sin Internet).
 *
 * El PIN identifica a la persona; el ROL que tiene EN ESTE EVENT decide qué
 * puede hacer. Ser encargado de Centro no da permisos en la feria: el rol se
 * asigna por ubicación (location_staff en la nube) y viaja en el snapshot.
 *
 * Mismo criterio que los tres roles del POS de Windows (cajero, encargado,
 * administrador): el cajero vende y cierra su turno A CIEGAS; mermas,
 * ajustes, retiros, recepciones y ver el esperado son de encargado.
 */
export type RolEvento = 'CASHIER' | 'SUPERVISOR' | 'ADMIN';

export type Accion =
  | 'VENDER' | 'ABRIR_TURNO' | 'CERRAR_TURNO_PROPIO' | 'CERRAR_TURNO_AJENO' | 'VER_ESPERADO'
  | 'MERMA' | 'AJUSTE' | 'RECIBIR_TRANSFERENCIA' | 'RETORNO' | 'RETIRO' | 'EGRESO' | 'DEVOLUCION'
  | 'CONFIGURAR_IMPRESORA' | 'REIMPRIMIR';

const CAJERO: Accion[] = ['VENDER', 'ABRIR_TURNO', 'CERRAR_TURNO_PROPIO', 'REIMPRIMIR'];
const ENCARGADO: Accion[] = [...CAJERO, 'CERRAR_TURNO_AJENO', 'VER_ESPERADO', 'MERMA', 'AJUSTE',
  'RECIBIR_TRANSFERENCIA', 'RETORNO', 'RETIRO', 'EGRESO', 'DEVOLUCION', 'CONFIGURAR_IMPRESORA'];

const PERMISOS: Record<RolEvento, ReadonlySet<Accion>> = {
  CASHIER: new Set(CAJERO),
  SUPERVISOR: new Set(ENCARGADO),
  ADMIN: new Set(ENCARGADO),
};

export function puede(rol: RolEvento | null | undefined, accion: Accion): boolean {
  return !!rol && !!PERMISOS[rol]?.has(accion);
}

/** Corte a ciegas: quien no puede ver el esperado cuenta sin verlo. */
export function corteCiego(rol: RolEvento | null | undefined): boolean {
  return !puede(rol, 'VER_ESPERADO');
}

export const ETIQUETA_ROL: Record<RolEvento, string> = { CASHIER: 'Cajero', SUPERVISOR: 'Encargado', ADMIN: 'Administrador' };
