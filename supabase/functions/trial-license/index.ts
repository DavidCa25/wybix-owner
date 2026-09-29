// Edge function: trial
// Gestiona la prueba gratis de 30 dias, UNA por machine_id (anti-reinstalacion).
// Acciones:
//   - start:  devuelve la prueba de la maquina; si no existe, la crea (30 dias).
//   - status: devuelve la prueba de la maquina (para revalidar en linea).
//   - rename: pone el nombre definitivo del negocio en una prueba ya emitida.
//   - select_vertical: el GIRO de la prueba (Comercios, Restaurantes y
//     Cafeterías o Servicios), que el negocio elige en su alta. Uno a la vez;
//     se puede cambiar mientras la prueba siga vigente, sin mover las fechas.
//
// LA PRUEBA ES DE UN GIRO. MonoCaja + el giro elegido + 3 Pantallas
// Operativas de ese giro, durante 30 días. Hasta que el alta elige el giro,
// el certificado solo trae lo de la edición (vender, cobrar, clientes,
// reportes). Nunca los tres giros a la vez. Lo que otorga lo resuelve
// license_trial_grants() desde el catálogo; el perfil del negocio en el POS
// solo PIDE el giro, no lo decide.
//
// POR QUE EXISTE `rename`
// -----------------------
// El License Gate ya no pregunta el nombre del negocio: lo preguntaba el, y
// despues el alta lo volvia a preguntar. La prueba se emite sin nombre y el
// alta lo manda cuando existe de verdad.
//
// Antes de esto, `rename` no estaba implementada y NO fallaba: caia en la rama
// de `start`, encontraba la prueba y respondia `success: true` sin cambiar
// nada. El cliente creia haber sincronizado el nombre. Un no-op que se anuncia
// como exito es peor que un error, porque nadie lo investiga.
//
// CERTIFICADO. Cada respuesta trae además `certificate`: el mismo formato
// firmado que las licencias compradas (kind TRIAL, ver _shared/certificado.ts),
// para que el POS valide la prueba sin Internet y sin poder editarla. La
// prueba sigue viviendo en device_trials: no hay un segundo sistema.
//
// Desplegar:  supabase functions deploy trial-license
// La tabla device_trials se crea con supabase/trial_schema.sql

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { payloadDePrueba, type GrantsDePrueba } from '../_shared/certificado.ts';
import { cargarFirma, type Firma } from '../_shared/llaves.ts';
import { TRIAL_DAYS } from '../_shared/politica.ts';

let firma: Promise<Firma> | null = null;
const laFirma = () => (firma ??= cargarFirma((n) => Deno.env.get(n)).then((f) => {
  if (!f.ok) console.error(`trial-license: no se firma (${f.motivo})`);
  return f;
}));

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};


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
      return json(await conCertificado(supabase, existing));
    }

    if (action === 'rename') {
      // Solo toca el nombre. NO crea la prueba y NO mueve las fechas: renombrar
      // no puede ser una forma de estrenar o estirar una prueba.
      if (!existing) return json({ success: false, code: 'NO_TRIAL', error: 'Esta maquina no tiene prueba.' }, 404);

      const nombre = String(businessName ?? '').trim();
      if (!nombre) return json({ success: false, error: 'Falta businessName' }, 400);

      const { data: updated, error: errUpd } = await supabase
        .from('device_trials')
        .update({ business_name: nombre })
        .eq('machine_id', machineId)
        .select()
        .single();

      if (errUpd) return json({ success: false, error: errUpd.message }, 500);
      return json(await conCertificado(supabase, updated));
    }

    if (action === 'select_vertical') {
      if (!existing) return json({ success: false, code: 'NO_TRIAL', error: 'Esta maquina no tiene prueba.' }, 404);
      const { data, error } = await supabase.rpc('license_trial_select_vertical',
        { p_machine_id: machineId, p_vertical: String(body.vertical ?? ''), p_actor: 'pos' });
      if (error) return json({ success: false, error: 'No se pudo elegir el giro.' }, 500);
      if (!data?.ok) return json({ success: false, code: data?.code, error: data?.error }, data?.code === 'BAD_VERTICAL' ? 400 : 409);
      const { data: t } = await supabase.from('device_trials').select('*').eq('machine_id', machineId).single();
      return json(await conCertificado(supabase, t));
    }

    // Una accion desconocida NO puede comportarse como `start`: asi es como
    // `rename` estuvo respondiendo que si durante todo este tiempo.
    if (action !== 'start') {
      return json({ success: false, error: `Accion desconocida: ${action}` }, 400);
    }

    if (existing) {
      // La maquina ya inicio su prueba antes: se devuelve la misma (aunque este vencida).
      // Asi, reinstalar NO reinicia los 30 dias.
      return json(await conCertificado(supabase, existing));
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
    return json(await conCertificado(supabase, created));
  } catch (e) {
    return json({ success: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});

/** MonoCaja + el giro elegido (o ninguno todavía): lo resuelve el catálogo. */
async function grantsDePrueba(supabase: ReturnType<typeof createClient>, vertical: string | null): Promise<GrantsDePrueba | null> {
  const { data, error } = await supabase.rpc('license_trial_grants', { p_vertical: vertical });
  return error || !data ? null : data as GrantsDePrueba;
}

async function conCertificado(supabase: ReturnType<typeof createClient>, t: Record<string, unknown>) {
  const base = buildLicense(t);
  try {
    const grants = await grantsDePrueba(supabase, (t.vertical as string) ?? null);
    if (!grants) return base;
    const certificate = await (await laFirma()).firmar(payloadDePrueba(t as any, grants));
    return certificate ? { ...base, certificate } : base;
  } catch {
    return base; // sin certificado: el POS nuevo no la guarda; el anterior sigue como antes
  }
}

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
    vertical: (t.vertical as string) ?? null,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}