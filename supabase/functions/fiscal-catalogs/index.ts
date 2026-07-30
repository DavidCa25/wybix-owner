
const FISCALAPI_URL = Deno.env.get('FISCALAPI_URL') ?? 'https://test.fiscalapi.com';
const FISCALAPI_API_KEY = Deno.env.get('FISCALAPI_API_KEY') ?? '';
const FISCALAPI_TENANT = Deno.env.get('FISCALAPI_TENANT') ?? '';

const CATALOGOS_VALIDOS = new Set([
  'SatTaxRegimes',    
  'SatCfdiUses',       
  'SatPaymentForms',   
  'SatPaymentMethods', 
  'SatUnitMeasurements',
  'SatProductCodes',   
  'SatTaxObjects'      
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
    }
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
      }
    });
  }

  try {
    const url = new URL(req.url);
    const catalogo = url.searchParams.get('catalog') ?? '';
    const search = url.searchParams.get('search') ?? '';
    const page = url.searchParams.get('page') ?? '1';
    const pageSize = url.searchParams.get('pageSize') ?? '100';

    if (!CATALOGOS_VALIDOS.has(catalogo)) {
      return json({ success: false, error: 'Catalogo no permitido.' }, 400);
    }
    if (!FISCALAPI_API_KEY || !FISCALAPI_TENANT) {
      return json({ success: false, error: 'Faltan credenciales del PAC en el backend.' }, 500);
    }

    // Si hay termino de busqueda usa el endpoint de search, si no, lista
    const endpoint = search
      ? `${FISCALAPI_URL}/api/v4/catalogs/${catalogo}/${encodeURIComponent(search)}/${page}/${pageSize}`
      : `${FISCALAPI_URL}/api/v4/catalogs/${catalogo}`;

    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'X-TENANT-KEY': FISCALAPI_TENANT,
        'X-API-KEY': FISCALAPI_API_KEY,
        'X-TIME-ZONE': 'America/Mexico_City'
      }
    });

    const out = await res.json();
    if (!res.ok || out?.succeeded === false) {
      return json({ success: false, error: out?.message || `HTTP ${res.status}` }, 502);
    }

    // Normaliza a { code, description }
    const raw = Array.isArray(out?.data) ? out.data : (out?.data?.items ?? []);
    const items = raw.map((r: any) => ({
      code: r.id ?? r.code ?? r.key,
      description: r.description ?? r.name ?? ''
    }));

    return json({ success: true, catalog: catalogo, items });
  } catch (e) {
    return json({ success: false, error: String(e) }, 500);
  }
});