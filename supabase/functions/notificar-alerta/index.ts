// ============================================================
// Edge Function: notificar-alerta
// Se dispara con un Database Webhook al INSERTAR en public.alertas.
// Manda una notificación push (Expo) al/los dueño(s) del negocio
// de esa sucursal, en segundos.
//
// Mapa: alertas.sucursal_id → sucursales.negocio_id → dueños
//       (negocios.owner_id + owner_apps.user_id) → push_tokens.token
//
// Env (Supabase → Edge Functions → Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (ya existen)
//   WEBHOOK_SECRET  (un texto secreto; el webhook lo envía en x-webhook-secret)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  try {
    // Seguridad: secreto compartido con el webhook
    const secret = Deno.env.get('WEBHOOK_SECRET') ?? '';
    if (secret) {
      const got = req.headers.get('x-webhook-secret') ?? '';
      if (got !== secret) return json({ error: 'no autorizado' }, 401);
    }

    const payload = await req.json().catch(() => ({}));
    // El webhook manda { type, table, record, old_record }
    const record = payload?.record ?? payload;
    const sucursalId = record?.sucursal_id;
    const titulo = String(record?.titulo ?? 'Alerta de Wybix');
    const mensaje = String(record?.mensaje ?? '');
    const tipo = String(record?.tipo ?? '');
    if (!sucursalId) return json({ error: 'sin sucursal_id' }, 400);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // 1) sucursal → negocio
    const { data: suc } = await admin
      .from('sucursales').select('negocio_id').eq('id', sucursalId).single();
    if (!suc?.negocio_id) return json({ ok: true, sent: 0, reason: 'sucursal sin negocio' });

    // 2) dueño(s) del negocio: owner_id + owner_apps
    const owners = new Set<string>();
    const { data: neg } = await admin
      .from('negocios').select('owner_id').eq('id', suc.negocio_id).single();
    if (neg?.owner_id) owners.add(neg.owner_id);
    const { data: apps } = await admin
      .from('owner_apps').select('user_id').eq('negocio_id', suc.negocio_id);
    (apps ?? []).forEach((a: any) => a?.user_id && owners.add(a.user_id));
    if (owners.size === 0) return json({ ok: true, sent: 0, reason: 'sin dueños' });

    // 3) tokens de push de esos dueños
    const { data: toks } = await admin
      .from('push_tokens').select('token').in('owner_id', Array.from(owners));
    const tokens = (toks ?? []).map((t: any) => t.token).filter(Boolean);
    if (tokens.length === 0) return json({ ok: true, sent: 0, reason: 'sin tokens' });

    // 4) enviar a Expo Push
    const messages = tokens.map((to: string) => ({
      to,
      sound: 'default',
      title: titulo,
      body: mensaje,
      priority: 'high',
      channelId: 'default',
      data: { tipo, sucursalId }
    }));

    const r = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(messages)
    });
    const out = await r.json().catch(() => ({}));

    return json({ ok: true, sent: tokens.length, expo: out });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
