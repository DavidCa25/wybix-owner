import {ticketHtml,type Ticket} from './escpos';
import type {ConfigImpresora} from '@wybix/database';
export type TipoImpresora='red'|'sistema'|'ninguna'|'bluetooth';
export interface Impresora {tipo:TipoImpresora;imprimir(t:Ticket):Promise<void>;direccion?:string;nombre?:string;}
export type DispositivoBt={nombre:string;direccion:string;esImpresora:boolean};
export type {ConfigImpresora};
export function impresoraRed(_host:string):Impresora {return {tipo:'red',imprimir:async()=>{throw new Error('En la versión web usa la impresión del sistema. La conexión directa de red está disponible en Android.');}};}
export const impresoraSistema:Impresora={tipo:'sistema',imprimir:async t=>{
  const w=window.open('','_blank');if(!w)throw new Error('Permite abrir ventanas para mostrar el ticket. Puedes reimprimirlo desde Estado.');
  w.document.open();w.document.write(ticketHtml(t));w.document.close();
  await new Promise<void>(resolve=>{if(w.document.readyState==='complete')resolve();else w.addEventListener('load',()=>resolve(),{once:true});});
  w.focus();w.print();
  // El navegador no confirma impresión física. Mantener el ticket pendiente.
  throw new Error('Ticket abierto para imprimir. El navegador no confirma si se imprimió; la venta ya está guardada.');
}};
export const sinImpresora:Impresora={tipo:'ninguna',imprimir:async()=>{}};
// Bluetooth clásico no existe en el navegador: la opción no se ofrece en web.
export const bluetoothDisponible=false;
export function impresoraBluetooth(_direccion:string):Impresora {return {tipo:'bluetooth',imprimir:async()=>{throw new Error('La impresora Bluetooth solo funciona en la app de Android.');}};}
export async function permisoBluetooth():Promise<void> {}
export async function impresorasEmparejadas():Promise<DispositivoBt[]> {throw new Error('Bluetooth solo está disponible en la app de Android.');}
export function impresoraDesdeConfig(c:ConfigImpresora|null|undefined):Impresora {
  if(!c)return sinImpresora;
  if(c.tipo==='red'&&c.host)return impresoraRed(c.host);
  if(c.tipo==='bluetooth'&&c.direccion)return impresoraBluetooth(c.direccion);
  if(c.tipo==='ninguna')return sinImpresora;
  return impresoraSistema;
}
