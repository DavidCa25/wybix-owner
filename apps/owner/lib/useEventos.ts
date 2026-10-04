import { supabase } from './supabase';
import { router } from 'expo-router';
import { esCodigoMfa, mensajeMfa } from './mfa';

/*
 * FASE 2 · EVENTOS (ferias) desde Wybix Owner.
 *
 * Todo pasa por funciones de la base que validan la membresía y el rol
 * (owner_*): la app no decide permisos ni cupos, solo los muestra. Los
 * códigos de error de la base se traducen aquí a frases para la dueña.
 */

export type EstadoEvento = 'PLANNED' | 'OPEN' | 'CLOSED' | 'RECONCILED';

export const ETIQUETA_ESTADO: Record<EstadoEvento, string> = {
  PLANNED: 'Planeado',
  OPEN: 'Abierto',
  CLOSED: 'Cerrado',
  RECONCILED: 'Conciliado',
};

export interface Empleado {
  id: string;
  nombre: string;
  rol_sucursal: string | null;
  sucursal: string | null;
  tiene_pin: boolean;
  eventos: { location_id: string; role: 'CASHIER' | 'SUPERVISOR' | 'ADMIN'; active: boolean }[];
}

export interface Equipo {
  id: string;
  kind: 'POS_PRIMARY' | 'POS_SECONDARY' | 'MOBILE_POS' | string;
  name: string | null;
  status: 'ACTIVE' | 'REVOKED' | string;
  location_id: string;
  location: string;
  tipo: string;
  app_version: string | null;
  last_seen_at: string | null;
  last_sync_at: string | null;
  pending_events: number | null;
  revoked_at: string | null;
  register: string | null;
  clock_skew_seconds: number | null;
  en_linea: boolean;
}

const MENSAJES: Record<string, string> = {
  DENIED: 'No tienes permiso para hacer esto en esta empresa.',
  HOME_REQUIRED: 'Elige la sucursal base del evento: de ahí salen su catálogo, su personal y su mercancía.',
  NO_LICENSE: 'La empresa no tiene una licencia ligada. Conciliala antes de crear ubicaciones.',
  LIMIT_LOCATIONS: 'Llegaste al número de sucursales de tu licencia.',
  NO_ENTITLEMENT_TEMPORARY_LOCATIONS: 'Tu licencia no incluye eventos. Necesitas el complemento Wybix POS Mobile.',
  NO_ENTITLEMENT_MOBILE_POS: 'Tu licencia no incluye Wybix POS Mobile.',
  LIMIT_MOBILE_POS: 'Ya usas todas las tablets de tu licencia. Da de baja una o amplía el complemento.',
  EVENT_NOT_OPEN: 'El evento ya está cerrado: no se pueden agregar tablets.',
  BAD_TRANSITION: 'Ese cambio de estado no es posible desde el estado actual.',
  SHIFTS_OPEN: 'Hay turnos abiertos en la feria. Hagan el corte en la tablet y sincronicen antes de conciliar.',
  TRANSFERS_IN_TRANSIT: 'Hay mercancía en camino (un envío o un retorno sin recibir). Recíbanla antes de conciliar.',
  STOCK_NOT_ZERO: 'La feria todavía tiene existencias. Regresen el sobrante a la sucursal o concilia con motivo.',
  REASON_REQUIRED: 'Explica la diferencia de inventario (entre 5 y 200 caracteres).',
  BAD_REQUEST: 'Faltan datos.',
  MFA_REQUIRED: mensajeMfa('MFA_REQUIRED'),
  MFA_ENROLL_REQUIRED: mensajeMfa('MFA_ENROLL_REQUIRED'),
};

export function mensaje(code: string | null | undefined): string {
  return (code && MENSAJES[code]) || 'No se pudo completar. Intenta de nuevo.';
}

type Resultado = { ok: true; [k: string]: unknown } | { ok: false; code: string; [k: string]: unknown };

async function llamar(fn: string, args: Record<string, unknown>): Promise<Resultado> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, code: error.code === '42501' ? 'DENIED' : 'ERROR', detalle: error.message };
  const r = (data ?? { ok: false, code: 'ERROR' }) as Resultado;
  // La nube exige el segundo factor para administrar: se lleva a la persona a
  // confirmarlo (o a activarlo) y la pantalla muestra el mensaje.
  if (!r.ok && esCodigoMfa(r.code)) router.push(r.code === 'MFA_REQUIRED' ? '/mfa/verificar?volver=1' : '/mfa');
  return r;
}

export const eventos = {
  crear: (company: string, p: { nombre: string; home_location_id: string; codigo?: string; starts_at?: string | null; ends_at?: string | null }) =>
    llamar('owner_crear_evento', { p_company: company, p }),
  estado: (company: string, location: string, status: EstadoEvento, forzar = false, motivo: string | null = null) =>
    llamar('owner_evento_estado', { p_company: company, p_location: location, p_status: status, p_forzar: forzar, p_motivo: motivo }),
  asignar: (company: string, location: string, employee: string, role: 'CASHIER' | 'SUPERVISOR', activo: boolean) =>
    llamar('owner_asignar_personal', { p_company: company, p_location: location, p_employee: employee, p_role: role, p_active: activo }),
  codigoTablet: (company: string, location: string, nombreCaja?: string) =>
    llamar('owner_codigo_tablet', { p_company: company, p_location: location, p_register_name: nombreCaja ?? null }),
  revocar: (company: string, device: string) =>
    llamar('owner_revocar_dispositivo', { p_company: company, p_device: device }),
  async empleados(company: string): Promise<Empleado[]> {
    const { data, error } = await supabase.rpc('owner_empleados', { p_company: company });
    if (error) throw new Error(error.message);
    return (data ?? []) as Empleado[];
  },
  async equipos(company: string): Promise<Equipo[]> {
    const { data, error } = await supabase.rpc('estado_dispositivos', { p_company: company });
    if (error) throw new Error(error.message);
    return (data ?? []) as Equipo[];
  },
};

/**
 * "Hace 3 min", "hace 2 h", "ayer 18:40". La nube solo sabe lo que ya llegó:
 * nunca se presenta como tiempo real.
 */
export function haceCuanto(iso: string | null | undefined, ahora = Date.now()): string {
  if (!iso) return 'nunca';
  const s = Math.max(0, Math.round((ahora - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
