/**
 * SPIKE 2.2 · IMPRESIÓN DETRÁS DE UNA INTERFAZ.
 *
 * La venta NO depende de la impresora: se confirma primero (con su trabajo de
 * impresión PENDING en la misma transacción) y se imprime después. Si falla,
 * queda FAILED con su motivo (Estado los cuenta); la venta sigue siendo válida.
 * Reimprimir un ticket fallido: pendiente (Fase 3).
 *
 *   red      ESC/POS por TCP 9100 (impresoras térmicas Ethernet/Wi-Fi). Probado
 *            de punta a punta en el emulador contra un receptor TCP.
 *   sistema  servicio de impresión de Android (expo-print): cualquier impresora
 *            que Android ya vea (Mopria, plug-ins de marca). Respaldo universal.
 *   bluetooth  ESC/POS por Bluetooth clásico (SPP) a térmicas de 58 mm (32
 *            columnas), p. ej. SUZWIP 58 mm. No necesita Internet ni WiFi.
 *            Transporte: módulo Expo propio, modules/wybix-bluetooth (Kotlin).
 *            Se eligió en vez de react-native-bluetooth-classic y similares
 *            porque esos son módulos del puente antiguo, sin config plugin y
 *            con mantenimiento irregular, y la app corre con la arquitectura
 *            nueva; imprimir solo requiere listar emparejados, abrir un socket
 *            SPP, escribir y cerrar. Permisos (Android 12+: BLUETOOTH_CONNECT,
 *            BLUETOOTH_SCAN) por plugins/with-bluetooth-impresora.js y
 *            permisoBluetooth() en tiempo de ejecución. Reintentos, cola y
 *            mensajes: lib/impresora-bluetooth.ts (probado en Node).
 */
import TcpSocket from 'react-native-tcp-socket';
import * as Print from 'expo-print';
import { PermissionsAndroid, Platform } from 'react-native';
import type { ConfigImpresora } from '@wybix/database';
import { ticketEscPos, ticketHtml, type Ticket } from './escpos';
import { impresoraBluetooth as bluetoothSobre, ErrorBluetooth } from './impresora-bluetooth';
import { bluetoothNativo, type DispositivoBt } from '../modules/wybix-bluetooth';

export type TipoImpresora = 'red' | 'sistema' | 'ninguna' | 'bluetooth';
export interface Impresora {
  tipo: TipoImpresora; imprimir(t: Ticket): Promise<void>;
  /** Solo Bluetooth: dispositivo elegido, para mostrarlo en Estado. */
  direccion?: string; nombre?: string;
}
export type { ConfigImpresora, DispositivoBt };

export function impresoraRed(host: string, puerto = 9100, ancho = 32, timeoutMs = 5000): Impresora {
  return {
    tipo: 'red',
    imprimir: (t) => new Promise<void>((resolver, rechazar) => {
      const datos = ticketEscPos(t, ancho);
      let listo = false;
      const fin = (e?: Error) => { if (listo) return; listo = true; clearTimeout(reloj); try { s.destroy(); } catch { /* noop */ } e ? rechazar(e) : resolver(); };
      const reloj = setTimeout(() => fin(new Error('La impresora no respondió.')), timeoutMs);
      const s = TcpSocket.createConnection({ host, port: puerto }, () => {
        s.write(datos as never, undefined, (err?: Error | null) => { if (err) fin(err); else s.end(); });
      });
      s.on('error', (e: Error) => fin(e));
      s.on('close', () => fin());
    }),
  };
}

export const impresoraSistema: Impresora = { tipo: 'sistema', imprimir: async (t) => { await Print.printAsync({ html: ticketHtml(t) }); } };
export const sinImpresora: Impresora = { tipo: 'ninguna', imprimir: async () => {} };

/** Bluetooth solo existe en el APK de Android (no en web ni en Expo Go). */
export const bluetoothDisponible = Platform.OS === 'android' && !!bluetoothNativo;

export function impresoraBluetooth(direccion: string, nombre?: string): Impresora {
  return { ...bluetoothSobre(direccion, bluetoothNativo), nombre };
}

/** Pide BLUETOOTH_CONNECT y BLUETOOTH_SCAN (Android 12+). Antes de 12 no hay diálogo. */
export async function permisoBluetooth(): Promise<void> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 31) return;
  const P = PermissionsAndroid.PERMISSIONS;
  const r = await PermissionsAndroid.requestMultiple([P.BLUETOOTH_CONNECT, P.BLUETOOTH_SCAN]);
  // SCAN solo sirve para cancelar una búsqueda en curso; sin él igual se imprime.
  if (r[P.BLUETOOTH_CONNECT] !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new ErrorBluetooth('BT_PERMISO', r[P.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
      ? 'El permiso de Bluetooth está bloqueado. Actívalo en Ajustes > Apps > Wybix POS > Permisos > Dispositivos cercanos.'
      : 'Sin el permiso de Bluetooth la tablet no puede usar la impresora.');
  }
}

/** Dispositivos ya emparejados en Ajustes de Android (primero los que se anuncian como impresora). */
export async function impresorasEmparejadas(): Promise<DispositivoBt[]> {
  if (!bluetoothNativo) throw new ErrorBluetooth('BT_NO_SOPORTADO', 'Bluetooth solo está disponible en la app de Android.');
  await permisoBluetooth();
  const estado = await bluetoothNativo.estado();
  if (estado === 'NO_SOPORTADO') throw new ErrorBluetooth('BT_NO_SOPORTADO', 'Esta tablet no tiene Bluetooth.');
  if (estado === 'APAGADO') throw new ErrorBluetooth('BT_APAGADO', 'Enciende el Bluetooth de la tablet y vuelve a buscar.');
  return bluetoothNativo.emparejados();
}

export function impresoraDesdeConfig(c: ConfigImpresora | null | undefined): Impresora {
  if (!c) return sinImpresora;
  if (c.tipo === 'red' && c.host) return impresoraRed(c.host);
  if (c.tipo === 'bluetooth' && c.direccion) return impresoraBluetooth(c.direccion, c.nombre ?? undefined);
  if (c.tipo === 'ninguna') return sinImpresora;
  return impresoraSistema;
}
