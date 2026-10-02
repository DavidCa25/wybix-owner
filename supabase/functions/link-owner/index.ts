// link-owner: vincula al dueño autenticado con su negocio.
// Regla de negocio: la 1a app va incluida. Cada app adicional para el mismo
// negocio requiere cupo pagado (negocio_app_quota.total_apps).
// Desplegar: supabase functions deploy link-owner --no-verify-jwt
// (la funcion valida el usuario con el token que manda la app).
//
// FASE 1. El ACCESO a los datos lo da una MEMBRESÍA (company_memberships), y
// una membresía solo nace de una INVITACIÓN de un solo uso (`codigo`, 30 min)
// que genera el POS principal (primer dueño) o el dueño desde su app. Conocer
// el id del negocio —que venía en un QR sin secreto— ya no basta: sin `codigo`
// se sigue registrando la app (cupo, como antes) pero no ve nada.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { negocioId: negocioPedido, deviceId, codigo } = await req.json().catch(() => ({}));
    if (!negocioPedido && !codigo) return json({ error: 'Falta el codigo de tu negocio.' }, 400);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Usuario autenticado (token que manda la app)
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'No autenticado.' }, 401);
    const userId = userData.user.id;

    // Invitacion -> membresia (la base valida el codigo: un solo uso, vigente).
    let negocioId = negocioPedido as string;
    if (codigo) {
      const { data: inv, error: invErr } = await admin.rpc('membresia_aceptar_invitacion', { p: { code: String(codigo), user_id: userId } });
      if (invErr || !inv?.ok) return json({ error: 'INVITE_INVALID', message: 'El codigo ya se uso o vencio. Genera uno nuevo en el POS.' }, 403);
      negocioId = inv.company_id;
    }

    // Ya esta vinculado este dueño a este negocio -> idempotente
    const { data: existing } = await admin
      .from('owner_apps')
      .select('id, active')
      .eq('negocio_id', negocioId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      if (!existing.active) {
        await admin.from('owner_apps')
          .update({ active: true, device_id: deviceId ?? null })
          .eq('id', existing.id);
      }
      return json({ ok: true, linked: true, reactivated: !existing.active, negocioId });
    }

    // Cupo del negocio (1 incluida por defecto)
    const { data: quota } = await admin
      .from('negocio_app_quota')
      .select('total_apps')
      .eq('negocio_id', negocioId)
      .maybeSingle();
    const allowed = quota?.total_apps ?? 1;

    const { count } = await admin
      .from('owner_apps')
      .select('*', { count: 'exact', head: true })
      .eq('negocio_id', negocioId)
      .eq('active', true);
    const used = count ?? 0;

    // Con invitacion, el acceso ya lo decidio quien invito (dueño o POS); el
    // cupo queda registrado como app extra para cobranza, no bloquea.
    if (used >= allowed && !codigo) {
      return json({
        error: 'APP_LIMIT',
        message: 'Este negocio ya alcanzo su limite de apps. Contacta a Wybix para habilitar otra (con costo).',
        used, allowed
      }, 402);
    }

    const isExtra = used >= 1; // la 1a es la incluida; de la 2a en adelante es extra pagada
    const { error: insErr } = await admin.from('owner_apps').insert({
      negocio_id: negocioId,
      user_id: userId,
      device_id: deviceId ?? null,
      is_paid_extra: isExtra,
      active: true
    });
    if (insErr) return json({ error: insErr.message }, 500);

    return json({ ok: true, linked: true, extra: isExtra, negocioId });
  } catch (e) {
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
