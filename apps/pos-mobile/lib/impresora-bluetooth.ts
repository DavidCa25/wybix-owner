/**
 * IMPRESORA BLUETOOTH (lógica pura: sin React Native, se prueba en Node).
 *
 * El transporte nativo (modules/wybix-bluetooth) solo conecta, escribe y
 * cierra. Aquí se decide lo demás:
 *   - Formato: ESC/POS de 58 mm (32 columnas) por omisión.
 *   - Cola: un ticket a la vez; una prueba y una venta nunca se mezclan.
 *   - Reconexión: cada ticket abre su propia conexión. Si la impresora estaba
 *     dormida o recién encendida, el primer intento suele fallar; se reintenta
 *     SOLO cuando el error ocurrió antes de enviar un byte (BT_CONEXION,
 *     BT_TIEMPO). A media impresión (BT_ENVIO) no: saldría el ticket doble;
 *     queda FAILED y se reimprime desde Estado.
 *   - Mensajes: en español para el cajero; se guardan como motivo del fallo.
 */
import { ticketEscPos, ANCHO_58, type Ticket } from './escpos.ts';

export interface TransporteBt {
  enviar(direccion: string, datos: number[], timeoutMs: number): Promise<void>;
}

export interface OpcionesBt {
  ancho?: number;
  /** Intentos totales por ticket (1 = sin reintento). */
  intentos?: number;
  /** Espera entre intentos: la impresora tarda en aceptar otra conexión. */
  esperaMs?: number;
  timeoutMs?: number;
  dormir?: (ms: number) => Promise<void>;
}

const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

/** "00:11:22:aa:bb:cc" o "00-11-22-AA-BB-CC" → "00:11:22:AA:BB:CC"; inválida → null. */
export function normalizarDireccion(s: string | null | undefined): string | null {
  const d = (s ?? '').trim().toUpperCase().replace(/-/g, ':');
  return MAC.test(d) ? d : null;
}

const MENSAJES: Record<string, string> = {
  BT_NO_SOPORTADO: 'Esta tablet no tiene Bluetooth.',
  BT_APAGADO: 'El Bluetooth de la tablet está apagado. Enciéndelo y reimprime desde Estado.',
  BT_PERMISO: 'Falta el permiso de Bluetooth. Ábrelo en Estado > Impresora y busca la impresora de nuevo.',
  BT_DIRECCION: 'La impresora Bluetooth guardada no es válida. Elígela de nuevo en Estado.',
  BT_NO_EMPAREJADA: 'La impresora ya no está emparejada con la tablet. Emparéjala en Ajustes de Android.',
  BT_CONEXION: 'No se pudo conectar con la impresora Bluetooth. Revisa que esté encendida, con papel y cerca.',
  BT_TIEMPO: 'La impresora Bluetooth no respondió. Revisa que esté encendida y cerca.',
  BT_ENVIO: 'Se cortó la conexión mientras imprimía. Reimprime el ticket desde Estado.',
};

const codigo = (e: unknown): string | undefined =>
  e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : undefined;

export function mensajeBluetooth(e: unknown): string {
  const c = codigo(e);
  if (c && MENSAJES[c]) return MENSAJES[c];
  const m = e instanceof Error ? e.message : String(e);
  return m ? `Impresora Bluetooth: ${m}` : MENSAJES.BT_CONEXION;
}

/** Solo errores en los que no salió ningún byte. */
export const esReintentable = (e: unknown) => codigo(e) === 'BT_CONEXION' || codigo(e) === 'BT_TIEMPO';

export class ErrorBluetooth extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ErrorBluetooth'; }
}

export function impresoraBluetooth(direccion: string, transporte: TransporteBt | null, o: OpcionesBt = {}) {
  const ancho = o.ancho ?? ANCHO_58;
  const intentos = Math.max(1, o.intentos ?? 2);
  const esperaMs = o.esperaMs ?? 1500;
  const timeoutMs = o.timeoutMs ?? 12000;
  const dormir = o.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dir = normalizarDireccion(direccion);
  let cola: Promise<unknown> = Promise.resolve();

  const enviarUno = async (t: Ticket) => {
    if (!transporte) throw new ErrorBluetooth('BT_NO_SOPORTADO', MENSAJES.BT_NO_SOPORTADO);
    if (!dir) throw new ErrorBluetooth('BT_DIRECCION', MENSAJES.BT_DIRECCION);
    const datos = Array.from(ticketEscPos(t, ancho));
    for (let i = 1; ; i++) {
      try { await transporte.enviar(dir, datos, timeoutMs); return; }
      catch (e) {
        if (i < intentos && esReintentable(e)) { await dormir(esperaMs); continue; }
        throw new ErrorBluetooth(codigo(e) ?? 'BT_ENVIO', mensajeBluetooth(e));
      }
    }
  };

  return {
    tipo: 'bluetooth' as const,
    direccion: dir ?? direccion,
    imprimir(t: Ticket): Promise<void> {
      const trabajo = cola.then(() => enviarUno(t));
      cola = trabajo.catch(() => undefined);
      return trabajo;
    },
  };
}
