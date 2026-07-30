// ============================================================
// Edge Function: license-check
// Activa y valida licencias de Wybix POS.
//
// Acciones:
//   activate  -> canjea la clave y registra la maquina
//   validate  -> verifica que la licencia y la maquina sigan vigentes
//   release   -> libera una maquina (cambio de equipo)
//
// Devuelve un token con el plan y la fecha de revalidacion.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LICENSE_SECRET
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const LICENSE_SECRET = Deno.env.get('LICENSE_SECRET') ?? '';

// Dias que el POS puede operar sin volver a validar contra el servidor
const GRACIA_OFFLINE_DIAS = 15;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Firma el token para que el POS pueda verificar que no fue alterado
async function firmar(payload: Record<string, unknown>): Promise<string> {
  const datos = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(LICENSE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(datos));
  const firma = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return btoa(datos) + '.' + firma;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    if (!SERVICE_KEY || !LICENSE_SECRET) {
      return json({ success: false, error: 'Backend mal configurado.' }, 500);
    }

    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const { action, licenseKey, machineId, machineAlias } = await req.json();

    if (!action || !machineId) {
      return json({ success: false, error: 'Faltan datos de la peticion.' }, 400);
    }

    // ---------- Buscar la licencia ----------
    let licencia: any = null;

    if (licenseKey) {
      const { data } = await db.from('licenses').select('*')
        .eq('license_key', String(licenseKey).trim().toUpperCase()).maybeSingle();
      licencia = data;
    } else {
      // Sin clave: se busca por la maquina ya activada
      const { data } = await db.from('license_activations')
        .select('license_id, active, licenses(*)')
        .eq('machine_id', machineId).eq('active', true).maybeSingle();
      licencia = data?.licenses ?? null;
    }

    if (!licencia) {
      return json({ success: false, error: 'Licencia no encontrada.', code: 'NOT_FOUND' }, 404);
    }
    if (licencia.status !== 'activa') {
      return json({ success: false, error: 'Esta licencia esta suspendida. Contacta a soporte.', code: 'SUSPENDED' }, 403);
    }

    // ---------- Liberar una maquina ----------
    if (action === 'release') {
      await db.from('license_activations').update({ active: false })
        .eq('license_id', licencia.id).eq('machine_id', machineId);
      return json({ success: true, released: true });
    }

    // ---------- Activar ----------
    if (action === 'activate') {
      // Ya activada? solo refresca
      const { data: existente } = await db.from('license_activations').select('*')
        .eq('license_id', licencia.id).eq('machine_id', machineId).maybeSingle();

      if (!existente) {
        // Cuenta cuantas maquinas vivas hay
        const { count } = await db.from('license_activations')
          .select('*', { count: 'exact', head: true })
          .eq('license_id', licencia.id).eq('active', true);

        const activas = count ?? 0;
        const limite = licencia.max_registers ?? 1;

        // limite 0 = ilimitado (plan multi)
        if (limite > 0 && activas >= limite) {
          return json({
            success: false,
            code: 'LIMIT_REACHED',
            error: licencia.plan === 'mono'
              ? 'Tu licencia MonoCaja ya esta usada en otra computadora. Mejora a MultiCaja para usar mas cajas.'
              : `Alcanzaste el limite de ${limite} cajas de tu licencia.`
          }, 403);
        }

        await db.from('license_activations').insert({
          license_id: licencia.id,
          machine_id: machineId,
          machine_alias: machineAlias ?? null
        });
      } else if (!existente.active) {
        await db.from('license_activations').update({ active: true, last_seen_at: new Date().toISOString() })
          .eq('id', existente.id);
      }
    }

    // ---------- Validar (y refrescar el visto) ----------
    if (action === 'validate') {
      const { data: act } = await db.from('license_activations').select('*')
        .eq('license_id', licencia.id).eq('machine_id', machineId).maybeSingle();

      if (!act || !act.active) {
        return json({ success: false, error: 'Esta computadora no esta activada.', code: 'NOT_ACTIVATED' }, 403);
      }
    }

    await db.from('license_activations')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('license_id', licencia.id).eq('machine_id', machineId);

    // ---------- Token firmado ----------
    const revalidar = new Date();
    revalidar.setDate(revalidar.getDate() + GRACIA_OFFLINE_DIAS);

    const soporteVigente = licencia.support_until
      ? new Date(licencia.support_until) >= new Date()
      : false;

    const payload = {
      plan: licencia.plan,                       
      maxRegisters: licencia.max_registers,     
      customerName: licencia.customer_name,
      machineId,
      supportUntil: licencia.support_until,
      supportActive: soporteVigente,
      revalidateBy: revalidar.toISOString(),
      issuedAt: new Date().toISOString()
    };

    const token = await firmar(payload);

    return json({ success: true, token, ...payload });
  } catch (e) {
    return json({ success: false, error: String(e) }, 500);
  }
});