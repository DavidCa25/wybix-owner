/**
 * Bluetooth clásico (SPP) para impresoras térmicas. Solo Android; en otra
 * plataforma el módulo no existe y la app no ofrece la opción Bluetooth.
 * La lógica (reintentos, cola, mensajes) vive en lib/impresora-bluetooth.ts.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export type DispositivoBt = { nombre: string; direccion: string; esImpresora: boolean };
export type Nativo = {
  /** 'NO_SOPORTADO' | 'APAGADO' | 'ENCENDIDO' */
  estado(): Promise<string>;
  /** Solo dispositivos ya emparejados en Ajustes de Android (no escanea). */
  emparejados(): Promise<DispositivoBt[]>;
  /** Conecta, envía los bytes y cierra. Errores con `code` BT_*: BT_CONEXION y BT_TIEMPO
   *  ocurren antes de enviar un solo byte; BT_ENVIO, a media impresión. */
  enviar(direccion: string, datos: number[], timeoutMs: number): Promise<void>;
};

export const bluetoothNativo: Nativo | null = requireOptionalNativeModule<Nativo>('WybixBluetooth');
