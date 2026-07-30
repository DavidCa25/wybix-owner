// ============================================================
// Edge Function: fiscal-register-issuer
// Registra al emisor en Fiscalapi y sube sus certificados CSD.
//   1) POST /api/v4/persons        -> crea la persona (emisor)
//   2) POST /api/v4/tax-files (.cer, CertificateCsd)
//   3) POST /api/v4/tax-files (.key, PrivateKeyCsd)
// Secrets: FISCALAPI_URL, FISCALAPI_API_KEY, FISCALAPI_TENANT
// ============================================================

const FISCALAPI_URL = Deno.env.get('FISCALAPI_URL') ?? 'https://test.fiscalapi.com';
const FISCALAPI_API_KEY = Deno.env.get('FISCALAPI_API_KEY') ?? '';
const FISCALAPI_TENANT = Deno.env.get('FISCALAPI_TENANT') ?? '';

// Headers CORS reutilizables
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

function pacHeaders() {
  return {
    'X-TENANT-KEY': FISCALAPI_TENANT,
    'X-API-KEY': FISCALAPI_API_KEY,
    'X-TIME-ZONE': 'America/Mexico_City',
    'Content-Type': 'application/json'
  };
}

async function fiscalapi(path: string, body: unknown) {
  const res = await fetch(`${FISCALAPI_URL}${path}`, {
    method: 'POST',
    headers: pacHeaders(),
    body: JSON.stringify(body)
  });
  const out = await res.json().catch(() => ({}));
  // Log para depurar: que respondio Fiscalapi
  console.log(`[FISCALAPI] ${path} -> status ${res.status}`);
  console.log(`[FISCALAPI] respuesta:`, JSON.stringify(out));
  return { ok: res.ok && out?.succeeded !== false, status: res.status, out };
}

Deno.serve(async (req) => {
  // Preflight CORS: responde de inmediato
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  try {
    if (!FISCALAPI_API_KEY || !FISCALAPI_TENANT) {
      return json({ success: false, error: 'Faltan credenciales del PAC en el backend.' }, 500);
    }

    const body = await req.json();
    const {
      rfc, razonSocial, regimenFiscal, zipCode, email,
      cerBase64, keyBase64, password, existingPersonId
    } = body ?? {};

    if (!rfc || !razonSocial || !regimenFiscal || !cerBase64 || !keyBase64 || !password) {
      return json({ success: false, error: 'Faltan datos del emisor o certificados.' }, 400);
    }

    const tin = String(rfc).trim().toUpperCase();
    let personId = existingPersonId as string | undefined;

    // Log de diagnostico (no expone secretos completos)
    console.log(`[DIAG] tin=${tin} regimen=${regimenFiscal} zip=${zipCode} razon=${razonSocial}`);
    console.log(`[DIAG] apiKey presente=${!!FISCALAPI_API_KEY} tenant presente=${!!FISCALAPI_TENANT} url=${FISCALAPI_URL}`);
    console.log(`[DIAG] cer len=${cerBase64?.length} key len=${keyBase64?.length}`);

    // 1) Crear la persona (emisor) si no existe
    if (!personId) {
      const person = await fiscalapi('/api/v4/people', {
        legalName: razonSocial,
        email: email || `${tin.toLowerCase()}.${crypto.randomUUID().slice(0, 6)}@wybix.local`,
        password: `Wy_${tin}_${crypto.randomUUID().slice(0, 8)}!`,
        tin: tin,
        taxRegimeCode: regimenFiscal,
        satTaxRegimeId: regimenFiscal,     // nombre correcto: guarda el regimen en la persona
        zipCode: zipCode || undefined
      });
      if (!person.ok) {
        return json({ success: false, error: person.out?.message || 'No se pudo crear el emisor.', step: 'person', detail: person.out }, 502);
      }
      personId = person.out?.data?.id;
      if (!personId) {
        return json({ success: false, error: 'Fiscalapi no devolvio el id del emisor.', step: 'person', detail: person.out }, 502);
      }
    }

    // 2) Subir el certificado .cer (fileType 0 = certificado)
    const cer = await fiscalapi('/api/v4/tax-files', {
      personId, tin, base64File: cerBase64, fileType: 0, password
    });
    if (!cer.ok) {
      return json({ success: false, error: cer.out?.message || 'No se pudo subir el certificado (.cer).', step: 'cer', personId, detail: cer.out }, 502);
    }

    // 3) Subir la llave .key (fileType 1 = llave privada)
    const key = await fiscalapi('/api/v4/tax-files', {
      personId, tin, base64File: keyBase64, fileType: 1, password
    });
    if (!key.ok) {
      return json({ success: false, error: key.out?.message || 'No se pudo subir la llave (.key).', step: 'key', personId, detail: key.out }, 502);
    }

    return json({ success: true, issuerId: personId });
  } catch (e) {
    return json({ success: false, error: String(e) }, 500);
  }
});