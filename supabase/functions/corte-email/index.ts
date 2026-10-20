import {rpcPostgrest,json} from '../_shared/nube.ts';
import {corteEmail} from '../_shared/corte-email.ts';
Deno.serve(async(req)=>{try{return await corteEmail(req,{rpc:rpcPostgrest(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),fetch,key:Deno.env.get('RESEND_API_KEY'),from:Deno.env.get('CORTE_EMAIL_FROM')||Deno.env.get('TICKET_EMAIL_FROM')||Deno.env.get('NOTIF_EMAIL_FROM')});}catch{return json({success:false,error:'No se pudo confirmar el envío. Reintenta más tarde.'},503);}});
