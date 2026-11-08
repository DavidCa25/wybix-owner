// ============================================================
// Edge Function: whatsapp-conectar (la página «Conectar WhatsApp»)
// El negocio entra con el enlace de un solo uso que abrió la caja principal,
// hace el Embedded Signup de Meta y aquí se canjea el código, se suscribe la
// app a su WABA, se registra el número, se dan de alta las plantillas y se
// guarda el token cifrado. Ver _shared/whatsapp.ts.
//
//   supabase functions deploy whatsapp-conectar --no-verify-jwt
//
// Mismos secretos que whatsapp-avisos.
// ============================================================
import { json } from '../_shared/nube.ts';
import { conectarWhatsapp, entornoWhatsapp, rpcArgsPostgrest } from '../_shared/whatsapp.ts';

Deno.serve(async (req) => {
  try {
    const url = Deno.env.get('SUPABASE_URL')!, key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    return await conectarWhatsapp(req, {
      rpcArgs: rpcArgsPostgrest(url, key),
      entorno: await entornoWhatsapp((k) => Deno.env.get(k)),
      log: (m) => console.warn(`[whatsapp-conectar] ${m}`),
    });
  } catch (e) {
    console.error('[whatsapp-conectar]', e instanceof Error ? e.message : String(e));
    return json({ success: false, error: 'No se pudo conectar. Reintenta más tarde.' }, 503);
  }
});
