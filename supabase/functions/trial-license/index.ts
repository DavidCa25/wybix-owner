// Edge function: trial
// Gestiona la prueba gratis de 30 dias, UNA por machine_id (anti-reinstalacion).
// Acciones:
//   - start:  devuelve la prueba de la maquina; si no existe, la crea (30 dias).
//   - status: devuelve la prueba de la maquina (para revalidar en linea).
//
// Desplegar:  supabase functions deploy trial
// La tabla device_trials se crea con supabase/trial_schema.sql

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TRIAL_DAYS = 30;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action ?? 'start';
    const machineId = String(body.machineId ?? '').trim();
    const businessName = body.businessName ?? null;
    const email = body.email ?? null;

    if (!machineId) return json({ success: false, error: 'Falta machineId' }, 400);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: existing } = await supabase
      .from('device_trials')
      .select('*')
      .eq('machine_id', machineId)
      .maybeSingle();

    if (action === 'status') {
      if (!existing) return json({ success: false, code: 'NO_TRIAL', error: 'Esta maquina no tiene prueba.' }, 404);
      return json(buildLicense(existing));
    }

    // action === 'start'
    if (existing) {
      // La maquina ya inicio su prueba antes: se devuelve la misma (aunque este vencida).
      // Asi, reinstalar NO reinicia los 30 dias.
      return json(buildLicense(existing));
    }

    const now = new Date();
    const expires = new Date(now.getTime() + TRIAL_DAYS * 86400000);

    const { data: created, error } = await supabase
      .from('device_trials')
      .insert({
        machine_id: machineId,
        business_name: businessName,
        email,
        started_at: now.toISOString(),
        expires_at: expires.toISOString(),
        status: 'active',
      })
      .select()
      .single();

    if (error) return json({ success: false, error: error.message }, 500);
    return json(buildLicense(created));
  } catch (e) {
    return json({ success: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});

function buildLicense(t: Record<string, unknown>) {
  const expiresAt = String(t.expires_at);
  const vencida = new Date(expiresAt).getTime() < Date.now();
  return {
    success: true,
    type: 'trial',
    plan: 'trial',
    maxRegisters: 1,
    customerName: (t.business_name as string) ?? 'Prueba',
    machineId: t.machine_id,
    startedAt: t.started_at,
    expiresAt,
    revalidateBy: expiresAt,
    issuedAt: new Date().toISOString(),
    trialExpired: vencida,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}