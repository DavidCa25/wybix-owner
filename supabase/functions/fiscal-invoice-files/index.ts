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

async function tryGet(path: string) {
  try {
    const res = await fetch(`${FISCALAPI_URL}${path}`, { method: 'GET', headers: pacHeaders() });
    const text = await res.text();
    console.log(`[FILES] GET ${path} -> ${res.status}`);
    console.log(`[FILES] body(300): ${text.slice(0, 300)}`);
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    console.log(`[FILES] GET ${path} -> ERROR ${String(e)}`);
    return { ok: false, status: 0, data: null };
  }
}

function extraerBase64(data: any, claves: string[]): string | null {
  const cont = data?.data ?? data;
  if (!cont) return null;
  for (const k of claves) {
    if (typeof cont[k] === 'string' && cont[k].length > 100) return cont[k];
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    if (!FISCALAPI_API_KEY || !FISCALAPI_TENANT) {
      return json({ success: false, error: 'Faltan credenciales del PAC.' }, 500);
    }

    const { invoiceId } = await req.json();
    if (!invoiceId) return json({ success: false, error: 'Falta invoiceId.' }, 400);

    // Rutas candidatas (probamos en orden hasta que una responda 200)
    const pdfPaths = [
      `/api/v4/invoices/${invoiceId}/pdf`,
      `/api/v4/invoices/${invoiceId}/file/pdf`,
      `/api/v4/invoices/pdf/${invoiceId}`
    ];
    const xmlPaths = [
      `/api/v4/invoices/${invoiceId}/xml`,
      `/api/v4/invoices/${invoiceId}/file/xml`,
      `/api/v4/invoices/xml/${invoiceId}`
    ];

    let pdfBase64: string | null = null;
    for (const p of pdfPaths) {
      const r = await tryGet(p);
      if (r.ok) {
        pdfBase64 = extraerBase64(r.data, ['base64File', 'pdf', 'base64Pdf', 'content', 'file']) ??
                    (typeof r.data === 'string' && r.data.length > 100 ? r.data : null);
        if (pdfBase64) break;
      }
    }

    let xmlBase64: string | null = null;
    for (const p of xmlPaths) {
      const r = await tryGet(p);
      if (r.ok) {
        xmlBase64 = extraerBase64(r.data, ['base64File', 'xml', 'base64Xml', 'content', 'file']) ??
                    (typeof r.data === 'string' && r.data.length > 100 ? btoa(r.data) : null);
        if (xmlBase64) break;
      }
    }

    if (!pdfBase64 && !xmlBase64) {
      return json({ success: false, error: 'No se pudieron obtener los archivos. Revisa los logs de la funcion.' }, 502);
    }

    return json({ success: true, pdfBase64, xmlBase64 });
  } catch (e) {
    return json({ success: false, error: String(e) }, 500);
  }
});