// ============================================================
// Edge Function: whatsapp-avisos (la caja, con la credencial del equipo)
// Ver _shared/whatsapp.ts y la migración 20261028140000.
//
//   supabase functions deploy whatsapp-avisos --no-verify-jwt
//
// Secretos (falla cerrado: sin ellos no se conecta ni sale nada):
//   WHATSAPP_PROVEEDOR      meta | simulado
//   WHATSAPP_CLAVE_TOKENS   base64 de 32 bytes; cifra el token de cada negocio
//   WHATSAPP_APP_ID         app de Meta de Wybix (Tech Provider)          [meta]
//   WHATSAPP_APP_SECRET     secreto de esa app                            [meta]
//   WHATSAPP_CONFIG_ID      configuración de Embedded Signup              [meta]
//   WHATSAPP_CONECTAR_URL   opcional: la página «Conectar WhatsApp»
//   WHATSAPP_GRAPH_VERSION  opcional (v23.0)
// ============================================================
import { json, rpcPostgrest } from '../_shared/nube.ts';
import { avisosWhatsapp, entornoWhatsapp, rpcArgsPostgrest } from '../_shared/whatsapp.ts';

Deno.serve(async (req) => {
  try {
    const url = Deno.env.get('SUPABASE_URL')!, key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    return await avisosWhatsapp(req, {
      rpc: rpcPostgrest(url, key), rpcArgs: rpcArgsPostgrest(url, key),
      entorno: await entornoWhatsapp((k) => Deno.env.get(k)),
      log: (m) => console.warn(`[whatsapp-avisos] ${m}`),
    });
  } catch (e) {
    console.error('[whatsapp-avisos]', e instanceof Error ? e.message : String(e));
    return json({ success: false, error: 'No se pudo registrar el aviso. Reintenta más tarde.' }, 503);
  }
});
