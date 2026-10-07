import {ticketHtml,type Ticket} from './escpos';
export interface Impresora {tipo:'red'|'sistema'|'ninguna';imprimir(t:Ticket):Promise<void>;}
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
