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
 *   bluetooth  pendiente de conocer el modelo de I Do Nut (requiere módulo
 *            nativo y prueba con hardware real). La interfaz ya lo admite.
 */
import TcpSocket from 'react-native-tcp-socket';
import * as Print from 'expo-print';
import { ticketEscPos, ticketHtml, type Ticket } from './escpos';

export interface Impresora { tipo: 'red' | 'sistema' | 'ninguna'; imprimir(t: Ticket): Promise<void>; }

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
