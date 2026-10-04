// ============================================================
// Edge Function: notificaciones (Fase 3)
// Un ciclo de entrega del motor (_shared/notificaciones.ts). La dispara
// pg_cron cada minuto (migración 20261011130000) con el secreto de Vault.
//
//   supabase functions deploy notificaciones --no-verify-jwt
//
// Secretos:
//   WEBHOOK_SECRET      obligatorio (>= 32): sin él responde 503 a todo.
//   EXPO_ACCESS_TOKEN   opcional (si el proyecto de Expo exige push seguro).
//   RESEND_API_KEY      sin ella el correo no se manda (las entregas esperan
//   NOTIF_EMAIL_FROM    y vencen a las 48 h). Ej.: "Wybix <avisos@wybixpos.com.mx>"
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validarWebhook } from '../_shared/webhook.ts';
import { ejecutarCiclo, pushExpo, correoResend } from '../_shared/notificaciones.ts';

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'método no permitido' }, 405);
  const auth = await validarWebhook(Deno.env.get('WEBHOOK_SECRET'), req.headers.get('x-webhook-secret'));
  if (!auth.ok) { console.warn(`[notificaciones] rechazado: ${auth.motivo}`); return json({ error: 'no autorizado' }, auth.status); }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const resend = Deno.env.get('RESEND_API_KEY'), remitente = Deno.env.get('NOTIF_EMAIL_FROM');
  try {
    const resumen = await ejecutarCiclo({
      rpc: async (nombre, args) => {
        const { data, error } = await db.rpc(nombre, args ?? {});
        if (error) throw new Error(`${nombre}: ${error.message}`);
        return data;
      },
      push: pushExpo(fetch, Deno.env.get('EXPO_ACCESS_TOKEN')),
      correo: resend && remitente ? correoResend(fetch, resend, remitente) : null,
      log: (m) => console.warn(`[notificaciones] ${m}`),
    });
    return json({ ok: true, ...resumen, correo_configurado: !!(resend && remitente) });
  } catch (e) {
    console.error('[notificaciones] ciclo', e instanceof Error ? e.message : String(e));
    return json({ ok: false, error: 'error interno' }, 500);
  }
});
