// ============================================================
// Edge Function: whatsapp-webhook (Meta -> Wybix)
// Estados de entrega (enviado, entregado, leído, fallido), bajas del
// cliente (botón «Ya no recibir avisos», texto BAJA / ALTA), plantillas
// aprobadas/rechazadas y cuentas que el negocio desconectó. Uno solo para
// las WABA de todos los negocios (es el webhook de la app de Wybix).
//
//   supabase functions deploy whatsapp-webhook --no-verify-jwt
//
// Secretos (sin ellos responde 503 a todo):
//   WHATSAPP_APP_SECRET     secreto de la app de Meta (firma X-Hub-Signature-256)
//   WHATSAPP_VERIFY_TOKEN   el que se escribe al dar de alta el webhook (>= 16)
// ============================================================
import { rpcPostgrest } from '../_shared/nube.ts';
import { rpcArgsPostgrest, webhookWhatsapp } from '../_shared/whatsapp.ts';

Deno.serve(async (req) => {
  try {
    const url = Deno.env.get('SUPABASE_URL')!, key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    return await webhookWhatsapp(req, {
      appSecret: Deno.env.get('WHATSAPP_APP_SECRET'), verifyToken: Deno.env.get('WHATSAPP_VERIFY_TOKEN'),
      rpc: rpcPostgrest(url, key), rpcArgs: rpcArgsPostgrest(url, key),
      log: (m) => console.warn(`[whatsapp-webhook] ${m}`),
    });
  } catch (e) {
    console.error('[whatsapp-webhook]', e instanceof Error ? e.message : String(e));
    return new Response('error', { status: 500 });
  }
});
