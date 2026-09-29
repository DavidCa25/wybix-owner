// ============================================================
// Edge Function: license-check
// Activa, valida y libera licencias de Wybix POS, y emite su CERTIFICADO
// FIRMADO (ES256) para que el POS valide sin Internet.
//
// Acciones:
//   activate     { licenseKey, machineId, machineAlias }  -> activa la PC
//   validate     { machineId }                            -> refresca el certificado
//   release      { machineId, certificate | licenseKey }  -> libera la PC (cambio de equipo)
//   certificate  { licenseKey, machineId }                -> descarga el archivo offline
//                                                            (desde otro dispositivo con Internet)
//
// La lógica vive en Postgres (license_activate, license_for_machine,
// license_release: atómicas, idempotentes y auditadas). Aquí solo se llama,
// se firma y se responde.
//
// Compatibilidad: la respuesta conserva los campos que leían las versiones
// anteriores del POS (plan, maxRegisters, customerName, supportUntil,
// supportActive, revalidateBy, issuedAt) y AGREGA `certificate`.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y la firma
//          (LICENSE_SIGNING_KEY, LICENSE_SIGNING_KID, LICENSE_PUBLIC_KEYS,
//          LICENSE_REVOKED_KIDS): ver _shared/llaves.ts.
// Si la firma no está bien configurada responde como antes, SIN certificado
// (los POS anteriores siguen funcionando; el POS nuevo no guarda una
// respuesta sin certificado) y la descarga del archivo responde 503.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { payloadDeLicencia, type Certificado, type Runtime } from '../_shared/certificado.ts';
import { cargarFirma, type Firma } from '../_shared/llaves.ts';
import { OFFLINE_DAYS } from '../_shared/politica.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

let firma: Promise<Firma> | null = null;
const laFirma = () => (firma ??= cargarFirma((n) => Deno.env.get(n)).then((f) => {
  // Solo el motivo, nunca la clave.
  if (!f.ok) console.error(`license-check: no se firma (${f.motivo})`);
  return f;
}));
async function certificadoDe(rt: Runtime, machineId: string): Promise<Certificado | null> {
  return await (await laFirma()).firmar(payloadDeLicencia(rt, machineId));
}

/** La respuesta de siempre + el certificado. */
async function respuesta(db: ReturnType<typeof createClient>, rt: Runtime, machineId: string) {
  const { data: lic } = await db.from('licenses').select('support_until').eq('id', rt.license_id).maybeSingle();
  const supportUntil = lic?.support_until ?? null;
  const certificate = await certificadoDe(rt, machineId);
  return {
    success: true,
    certificate,
    // ---- compatibilidad con POS anteriores ----
    plan: rt.edition,
    maxRegisters: rt.registers_max ?? 0,          // 0 = ilimitado (contrato anterior)
    customerName: rt.customer,
    machineId,
    supportUntil,
    supportActive: supportUntil ? new Date(supportUntil) >= new Date() : false,
    revalidateBy: new Date(Date.now() + OFFLINE_DAYS * 86400000).toISOString(),
    issuedAt: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'Método no permitido.' }, 405);

  try {
    if (!SERVICE_KEY) return json({ success: false, error: 'Backend mal configurado.' }, 500);
    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? '');
    const machineId = String(body.machineId ?? '').trim();
    const licenseKey = body.licenseKey ? String(body.licenseKey).trim().toUpperCase() : '';

    if (!action || !machineId || machineId.length > 128) {
      return json({ success: false, error: 'Faltan datos de la petición.' }, 400);
    }

    // ---------- Activar ----------
    if (action === 'activate') {
      if (!licenseKey) return json({ success: false, error: 'Falta la clave de licencia.' }, 400);
      const { data, error } = await db.rpc('license_activate', {
        p_license_key: licenseKey, p_machine_id: machineId, p_alias: body.machineAlias ? String(body.machineAlias).slice(0, 80) : null,
      });
      if (error) return json({ success: false, error: 'No se pudo activar. Intenta más tarde.' }, 500);
      if (!data?.ok) return json({ success: false, error: data?.error, code: data?.code }, data?.code === 'NOT_FOUND' ? 404 : 403);
      return json(await respuesta(db, data.runtime as Runtime, machineId));
    }

    // ---------- Validar / refrescar el certificado ----------
    if (action === 'validate') {
      const { data, error } = await db.rpc('license_for_machine', { p_machine_id: machineId });
      if (error) return json({ success: false, error: 'No se pudo validar. Intenta más tarde.' }, 500);
      if (!data?.ok) return json({ success: false, error: data?.error, code: data?.code }, 403);
      return json(await respuesta(db, data.runtime as Runtime, machineId));
    }

    // ---------- Descargar el certificado desde OTRO dispositivo ----------
    // Para el negocio sin Internet: con la clave y el código del equipo se
    // obtiene su archivo firmado, que se lleva por USB. Solo para una
    // computadora YA activada con esa clave: no activa nada nuevo.
    if (action === 'certificate') {
      if (!licenseKey) return json({ success: false, error: 'Falta la clave de licencia.' }, 400);
      const { data: lic } = await db.from('licenses').select('id').eq('license_key', licenseKey).maybeSingle();
      const { data, error } = await db.rpc('license_for_machine', { p_machine_id: machineId });
      if (error) return json({ success: false, error: 'No se pudo generar el archivo.' }, 500);
      if (!lic || !data?.ok || data.runtime?.license_id !== lic.id) {
        return json({ success: false, code: 'NOT_ACTIVATED', error: 'Esa computadora no está activada con esta clave.' }, 403);
      }
      const r = await respuesta(db, data.runtime as Runtime, machineId);
      if (!r.certificate) return json({ success: false, error: 'La firma de licencias no está configurada.' }, 503);
      // Descargar el archivo NO cambia fechas ni periodos: solo se registra.
      await db.rpc('license_log', { p_license: lic.id, p_type: 'CERTIFICATE_DOWNLOADED',
        p_data: { machine_id: machineId }, p_actor: 'web' });
      return json({ success: true, certificate: r.certificate });
    }

    // ---------- Liberar (cambio de computadora) ----------
    // Hace falta demostrar que se tiene la licencia: el certificado firmado de
    // ESA computadora o la clave. Antes bastaba conocer el machineId.
    if (action === 'release') {
      let licenseId: string | null = null;
      if (body.certificate) {
        const p = await (await laFirma()).verificar(body.certificate as Certificado);
        if (p && p.machine_id === machineId && p.license_id) licenseId = p.license_id;
      }
      if (!licenseId && licenseKey) {
        const { data: lic } = await db.from('licenses').select('id').eq('license_key', licenseKey).maybeSingle();
        licenseId = lic?.id ?? null;
      }
      if (!licenseId) return json({ success: false, code: 'PROOF_REQUIRED', error: 'Para liberar esta computadora hace falta su licencia.' }, 403);
      const { data, error } = await db.rpc('license_release', { p_license_id: licenseId, p_machine_id: machineId, p_actor: 'pos' });
      if (error || !data?.ok) return json({ success: false, error: 'No se pudo liberar la computadora.' }, 500);
      return json({ success: true, released: !!data.released });
    }

    return json({ success: false, error: `Acción desconocida: ${action}` }, 400);
  } catch (_e) {
    return json({ success: false, error: 'Error del servicio de licencias.' }, 500);
  }
});
