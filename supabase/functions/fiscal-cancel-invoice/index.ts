// ============================================================
// Edge Function: fiscal-cancel-invoice
// Cancela un CFDI timbrado ante el SAT via Fiscalapi.
//   DELETE /api/v4/invoices
//   body: { id, cancellationReasonCode, replacementUuid? }
// Motivos SAT (c_MotivoCancelacion):
//   01 = Comprobante emitido con errores con relacion (requiere replacementUuid)
//   02 = Comprobante emitido con errores sin relacion
//   03 = No se llevo a cabo la operacion
// ============================================================

const FISCALAPI_URL = Deno.env.get('FISCALAPI_URL') ?? 'https://test.fiscalapi.com';
const FISCALAPI_API_KEY = Deno.env.get('FISCALAPI_API_KEY') ?? '';
const FISCALAPI_TENANT = Deno.env.get('FISCALAPI_TENANT') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function pacHeaders() {
  return {
    'X-TENANT-KEY': FISCALAPI_TENANT,
    'X-API-KEY': FISCALAPI_API_KEY,
    'X-TIME-ZONE': 'America/Mexico_City',
    'Content-Type': 'application/json'
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    if (!FISCALAPI_API_KEY || !FISCALAPI_TENANT) {
      return json({ success: false, error: 'Faltan credenciales del PAC.' }, 500);
    }

    const { invoiceId, motivo, folioSustitucion } = await req.json();

    if (!invoiceId) return json({ success: false, error: 'Falta el id de la factura en Fiscalapi.' }, 400);
    if (!motivo) return json({ success: false, error: 'Falta el motivo de cancelacion.' }, 400);
    if (motivo === '01' && !folioSustitucion) {
      return json({ success: false, error: 'El motivo 01 requiere el UUID de la factura que la sustituye.' }, 400);
    }

    const body: any = {
      id: invoiceId,
      cancellationReasonCode: motivo
    };
    if (motivo === '01' && folioSustitucion) {
      body.replacementUuid = folioSustitucion;
    }

    console.log(`[CANCEL] id=${invoiceId} motivo=${motivo} replacement=${folioSustitucion || '-'}`);

    // La cancelacion es DELETE sobre /api/v4/invoices
    const res = await fetch(`${FISCALAPI_URL}/api/v4/invoices`, {
      method: 'DELETE',
      headers: pacHeaders(),
      body: JSON.stringify(body)
    });
    const rawText = await res.text();
    console.log(`[CANCEL] DELETE /api/v4/invoices -> status ${res.status}`);
    console.log(`[CANCEL] respuesta cruda: ${rawText.slice(0, 900)}`);

    let out: any = {};
    try { out = JSON.parse(rawText); } catch { out = { message: rawText }; }

    if (!res.ok || out?.succeeded === false) {
      const detalleValidacion = Array.isArray(out?.data)
        ? out.data.map((d: any) => `${d.propertyName}: ${d.errorMessage}`).join(' | ')
        : null;
      const msg = out?.details || detalleValidacion || out?.message || `HTTP ${res.status}`;
      console.log(`[CANCEL] ERROR: ${msg}`);
      return json({ success: false, error: msg, detail: out }, 502);
    }

    // La respuesta trae el acuse de cancelacion en base64 y el estatus por UUID
    const data = out?.data ?? {};
    return json({
      success: true,
      acuseBase64: data.base64CancellationAcknowledgement ?? null,
      estatusPorUuid: data.invoiceUuids ?? null
    });
  } catch (e) {
    return json({ success: false, error: String(e) }, 500);
  }
});