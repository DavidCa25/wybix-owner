import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace('Bearer ', '');
    if (!jwt) return json({ error: 'sin token' }, 401);

    const { negocioId } = await req.json();
    if (!negocioId) return json({ error: 'falta negocioId' }, 400);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'token invalido' }, 401);
    const ownerId = userData.user.id;

    const { data: negocio, error: negErr } = await admin
      .from('negocios')
      .select('id, owner_id')
      .eq('id', negocioId)
      .single();

    if (negErr || !negocio) return json({ error: 'negocio no encontrado' }, 404);

    if (negocio.owner_id && negocio.owner_id !== ownerId) {
      return json({ error: 'el negocio ya tiene otro dueno' }, 403);
    }

    const { error: updErr } = await admin
      .from('negocios')
      .update({ owner_id: ownerId })
      .eq('id', negocioId);

    if (updErr) return json({ error: updErr.message }, 500);

    return json({ ok: true, negocioId, ownerId }, 200);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}