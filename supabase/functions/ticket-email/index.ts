import {rpcPostgrest,json} from '../_shared/nube.ts';
import {ticketEmail} from '../_shared/ticket-email.ts';
Deno.serve(async(req)=>{try{return await ticketEmail(req,{rpc:rpcPostgrest(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),fetch,key:Deno.env.get('RESEND_API_KEY'),from:Deno.env.get('TICKET_EMAIL_FROM')||Deno.env.get('NOTIF_EMAIL_FROM')});}catch{return json({success:false,error:'No se pudo confirmar el envío. Reintenta más tarde.'},503);}});
