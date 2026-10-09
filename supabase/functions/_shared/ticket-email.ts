import {CORS,equipoDe,json,negado,type Rpc} from './nube.ts';
export async function ticketEmail(req:Request,deps:{rpc:Rpc;fetch:typeof fetch;key?:string;from?:string}):Promise<Response>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:CORS});if(req.method!=='POST')return json({success:false,error:'Método no permitido.'},405);
 const eq=await equipoDe(req,deps.rpc);if(!eq)return negado('BAD_TOKEN');
 if(!deps.key||!deps.from)return json({success:false,code:'MAIL_NOT_CONFIGURED',error:'Falta configurar el remitente de tickets.'},503);
 const raw=await req.text();if(raw.length>2800000)return json({success:false,error:'Ticket demasiado grande.'},413);
 let b:any;try{b=JSON.parse(raw);}catch{return json({success:false,error:'Datos inválidos.'},400);}
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(b.id??'')||!Number.isSafeInteger(b.saleId)||b.saleId<1||typeof b.email!=='string'||b.email.length>254||!/^\S+@\S+\.\S+$/.test(b.email)||typeof b.pdf!=='string'||!/^JVBERi0[A-Za-z0-9+/=]+$/.test(b.pdf))return json({success:false,error:'Destino o PDF inválido.'},400);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([b.saleId,b.email.toLowerCase(),b.pdf])));
 const fingerprint=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
 const a=await deps.rpc('ticket_mail_reserve',{id:b.id,device_id:eq.device_id,fingerprint});
 if(!a?.ok)return json({success:false,code:a?.code,error:'El envío está pendiente, excede el límite o requiere revisión.'},409);
 if(a.sent)return json({success:true,accepted:true});
 const r=await deps.fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${deps.key}`,'Content-Type':'application/json','Idempotency-Key':`wybix-ticket-${b.id}`},body:JSON.stringify({from:deps.from,to:[b.email],subject:`Ticket de compra #${b.saleId}`,text:`Adjuntamos tu ticket de compra #${b.saleId}. Gracias por tu compra.`,attachments:[{filename:`ticket-${b.saleId}.pdf`,content:b.pdf}] }),signal:AbortSignal.timeout(20000)});
 if(!r.ok)return json({success:false,code:'MAIL_PROVIDER',error:'El proveedor no confirmó el envío. Puedes reintentarlo sin repetir la venta.'},502);
 const out=await r.json();await deps.rpc('ticket_mail_complete',{id:b.id,device_id:eq.device_id,provider_id:out.id});
 return json({success:true,accepted:true});
}
