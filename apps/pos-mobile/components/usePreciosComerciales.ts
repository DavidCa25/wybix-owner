import {useEffect,useState} from 'react';
import type {CatalogoIndexado,LineaCarrito} from '@wybix/domain';
import {Dec} from '@wybix/domain';
import type {PosLocal} from '@wybix/database';

export function usePreciosComerciales(pos:PosLocal|null,cat:CatalogoIndexado|null,carrito:Array<LineaCarrito&{key:string}>,channel:string,audiences:string[]){
 const [total,setTotal]=useState<string|null>(null);
 const [discount,setDiscount]=useState('0.00');
 const [pricing,setPricing]=useState(false);
 const [error,setError]=useState('');
 const [lines,setLines]=useState<Record<string,{amount:string;label:string}>>({});
 useEffect(()=>{
   let alive=true;
   if(!pos||!cat?.commercial){setTotal(null);setLines({});setDiscount('0.00');setPricing(false);setError('');return;}
   setPricing(true);setError('');
   void pos.cotizarVenta(carrito,{channel,audiences}).then(quote=>{
     if(!alive)return;
     const display:Record<string,{amount:string;label:string}>={};
     carrito.forEach((line,index)=>{
       const priced=quote.commercial?.lines.filter(x=>x.source===String(index))??[];
       if(!priced.length)return;
       const amount=Dec.suma(priced.map(x=>Dec.de(x.quantity).por(x.unitPrice)));
       display[line.key]={amount:amount.fijo(2),label:[...new Set(priced.map(x=>x.ruleName).filter(Boolean))].join(' · ')};
     });
     setTotal(quote.total);setDiscount(quote.commercial?.discount??'0.00');setLines(display);
   }).catch(e=>{if(alive){setTotal(null);setLines({});setDiscount('0.00');setError(e.message);}}).finally(()=>{if(alive)setPricing(false);});
   return()=>{alive=false;};
 },[pos,cat,carrito,channel,audiences]);
 return {total,discount,pricing,error,lines};
}
