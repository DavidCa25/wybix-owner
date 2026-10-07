import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {politicaVacia,type PoliticaComercial} from '@wybix/domain';
import {base,catalogo,snapshot,U,lupita,marta} from './fixture.ts';
import {aplicarSnapshot} from '../src/index.ts';
async function configured(policy:PoliticaComercial){const b=await base();const catalog={...catalogo(2),commercial:policy};await aplicarSnapshot(b.db,snapshot({snapshot_version:2,catalog}));await b.pos.recibirTransferencia(marta,U.transfer,{});await b.pos.abrirTurno(lupita,'100');return b;}
test('paridad: el motor móvil y Windows son exactamente el mismo archivo',()=>{
 const win=new URL('../../../../../filtros_lubs_rios/shared/comercial.ts',import.meta.url);
 // Fuera de este entorno la paridad se ejecuta con WYBIX_WINDOWS_ROOT explícito.
 const path=process.env.WYBIX_WINDOWS_ROOT?process.env.WYBIX_WINDOWS_ROOT+'/shared/comercial.ts':win;
 assert.equal(readFileSync(path,'utf8'),readFileSync(new URL('../../domain/src/comercial.ts',import.meta.url),'utf8'));
});
test('móvil: mismo producto, distinto canal, venta/pago/stock/outbox atómicos',async()=>{
 const p=politicaVacia();p.version=1;p.channels.push({id:'UBER',name:'Uber',active:true,inheritBase:false});p.prices.push({channel:'UBER',product:U.dona,price:'32.00'});
 const {pos,db}=await configured(p);const quote=await pos.cotizarVenta([{product_uuid:U.dona,quantity:2}],{channel:'UBER'});assert.equal(quote.total,'64.00');
 const sale=await pos.registrarVenta(lupita,[{product_uuid:U.dona,quantity:2}],[{method:'TARJETA',amount:'64.00'}],{commercial:{channel:'UBER'}});
 assert.equal(sale.total,'64.00');assert.equal((await pos.stock()).find(p=>p.product_uuid===U.dona)?.qty,'38');
 const row=await db.get<{commercial_snapshot:string}>('SELECT commercial_snapshot FROM sales WHERE uuid=?',[sale.sale_uuid]);assert.equal(JSON.parse(row!.commercial_snapshot).channel,'UBER');
 const events=await db.all<{payload:string}>("SELECT payload FROM outbox WHERE event_type='SALE_RECORDED'");assert.equal(JSON.parse(events[0].payload).commercial.total,'64.00');
 assert.equal((await pos.resumenTurno(marta))!.esperado,'100.00','no entra una venta de plataforma por tarjeta al cajón');
});
test('móvil: 2x1 cobra una unidad y descuenta dos; pago viejo no deja venta a medias',async()=>{
 const p=politicaVacia();p.version=1;p.promotions=[{id:'2x1',name:'Dos por uno',active:true,priority:1,kind:'BUY_PAY',selector:{products:[U.dona]},buy:2,pay:1}];
 const {pos,db}=await configured(p);const items=[{product_uuid:U.dona,quantity:2}];await assert.rejects(pos.registrarVenta(lupita,items,[{method:'TARJETA',amount:'50.00'}]));assert.equal((await db.get<{n:number}>('SELECT COUNT(*) n FROM sales'))!.n,0);assert.equal((await pos.stock()).find(p=>p.product_uuid===U.dona)?.qty,'40');
 const r=await pos.registrarVenta(lupita,items,[{method:'EFECTIVO',amount:'25.00',received:'50.00'}]);assert.equal(r.total,'25.00');assert.equal(r.cambio,'25.00');assert.equal((await pos.stock()).find(p=>p.product_uuid===U.dona)?.qty,'38');assert.equal((await pos.resumenTurno(marta))!.esperado,'125.00');
});
test('móvil: combo congela componentes, precio/consumos, no se acumula con porcentaje',async()=>{
 const p=politicaVacia();p.version=1;p.combos=[{id:'combo',name:'Dona y café',active:true,price:'59.00',groups:[{id:'d',name:'Dona',quantity:1,selector:{products:[U.dona]}},{id:'c',name:'Café',quantity:1,selector:{products:[U.cafe]}}]}];p.promotions=[{id:'pct',name:'Oferta general',active:true,priority:1,kind:'PERCENT',selector:{},value:'20.00'}];
 const {pos}=await configured(p);const items=[{product_uuid:U.dona,quantity:1,combo:{id:'combo',instance:'uno',group:'d'}},{product_uuid:U.cafe,quantity:1,combo:{id:'combo',instance:'uno',group:'c'}}];
 const r=await pos.registrarVenta(lupita,items,[{method:'TARJETA',amount:'59.00'}]);assert.equal(r.total,'59.00');assert.equal(r.lineas.length,2);assert.equal((await pos.stock()).find(p=>p.product_uuid===U.dona)?.qty,'39');assert.equal((await pos.stock()).find(p=>p.product_uuid===U.leche)?.qty,'4800');
});
test('móvil: cajero no confirma descuentos de elegibilidad por parámetros',async()=>{
 const p=politicaVacia();p.version=1;p.promotions=[{id:'estudiante',name:'Estudiante',active:true,priority:1,kind:'PERCENT',value:'20',selector:{products:[U.dona]},audience:'ESTUDIANTE'}];const {pos}=await configured(p);
 await assert.rejects(pos.registrarVenta(lupita,[{product_uuid:U.dona,quantity:1}],[{method:'TARJETA',amount:'20.00'}],{commercial:{audiences:['ESTUDIANTE']}}),/encargado/);
});
