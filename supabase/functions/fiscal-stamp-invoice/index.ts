// ============================================================
// Edge Function: fiscal-stamp-invoice
// Timbra una factura CFDI 4.0 en Fiscalapi (POST /api/v4/invoices)
// Estructura segun documentacion oficial de Fiscalapi.
//   - Emisor: tin + legalName + taxRegimeCode (el CSD ya esta en boveda)
//   - Receptor: por valores completos
//   - Items: por valores completos con impuestos
// Secrets: FISCALAPI_URL, FISCALAPI_API_KEY, FISCALAPI_TENANT
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

    const body = await req.json();
    const {
      issuerId, issuerRfc, issuerLegalName, issuerRegimen,
      expeditionZipCode, series,
      receptor, formaPago, metodoPago, items
    } = body ?? {};

    // Validaciones
    if (!issuerId || !issuerRegimen) {
      return json({ success: false, error: 'Falta el id o el regimen fiscal del emisor.' }, 400);
    }
    if (!receptor?.rfc || !receptor?.razonSocial || !receptor?.regimenFiscal || !receptor?.usoCfdi || !receptor?.zipCode) {
      return json({ success: false, error: 'Faltan datos fiscales del receptor.' }, 400);
    }
    if (!Array.isArray(items) || items.length === 0) {
      return json({ success: false, error: 'La factura no tiene conceptos.' }, 400);
    }

    // Registrar (o crear) el receptor como persona para usarlo por referencia.
    // El email de la "persona" debe ser unico en Fiscalapi, asi que se genera
    // uno interno. El correo real del cliente se usa aparte para enviar la factura.
    // Si es publico en general (RFC generico), el CP del receptor DEBE ser
    // igual al lugar de expedicion (regla SAT CFDI40149 de factura global).
    const esPublicoGeneral = String(receptor.rfc).trim().toUpperCase() === 'XAXX010101000';
    const cpReceptor = esPublicoGeneral
      ? String(expeditionZipCode || '')
      : String(receptor.zipCode);

    const recipientBody = {
      legalName: receptor.razonSocial,
      email: `rec.${String(receptor.rfc).toLowerCase()}.${crypto.randomUUID().slice(0, 10)}@wybix.local`,
      password: `Wy_${crypto.randomUUID().slice(0, 10)}!`,
      tin: String(receptor.rfc).trim().toUpperCase(),
      taxRegimeCode: receptor.regimenFiscal,
      satTaxRegimeId: receptor.regimenFiscal,          // nombre correcto en Fiscalapi
      cfdiUseCode: receptor.usoCfdi,
      satCfdiUseId: receptor.usoCfdi,                  // nombre correcto en Fiscalapi
      zipCode: cpReceptor
    };
    const recRes = await fetch(`${FISCALAPI_URL}/api/v4/people`, {
      method: 'POST', headers: pacHeaders(), body: JSON.stringify(recipientBody)
    });
    const recText = await recRes.text();
    console.log(`[RECIPIENT] POST /people -> ${recRes.status}: ${recText.slice(0, 400)}`);
    let recOut: any = {};
    try { recOut = JSON.parse(recText); } catch { /* noop */ }
    const recipientId = recOut?.data?.id;
    if (!recipientId) {
      return json({ success: false, error: recOut?.details || recOut?.message || 'No se pudo registrar el receptor.', detail: recOut }, 502);
    }

    // Conceptos por valores
    const invoiceItems = items.map((it: any, idx: number) => {
      const quantity = Number(it.quantity || 0);
      const unitPrice = Number(it.unitPrice || 0);
      const discount = Number(it.discount || 0);
      const taxRate = it.taxRate != null ? Number(it.taxRate) : 0.16;
      const taxObject = it.taxObject || '02';

      const item: any = {
        itemCode: it.claveProdServ || '01010101',       // ClaveProdServ
        itemSku: it.sku || `SKU-${idx + 1}`,              // SKU interno
        quantity,
        unitOfMeasurementCode: it.claveUnidad || 'H87',   // ClaveUnidad
        description: it.description || 'Producto',
        unitPrice,
        taxObjectCode: taxObject,
        discount
      };

      // Impuestos: solo si el objeto es "02" (si objeto) y hay tasa
      if (taxObject === '02' && taxRate > 0) {
        item.itemTaxes = [{
          taxCode: '002',          // IVA
          taxTypeCode: 'Tasa',
          taxRate: taxRate.toFixed(6),
          taxFlagCode: 'T'         // Traslado
        }];
      }
      return item;
    });

    // Factura completa segun doc oficial
    const invoice: any = {
      versionCode: '4.0',
      series: series || 'F',
      date: new Date().toLocaleString("sv-SE", { timeZone: "America/Mexico_City" }).replace(" ", "T"),
      paymentFormCode: formaPago || '01',
      paymentConditions: 'Contado',
      currencyCode: 'MXN',
      typeCode: 'I',
      expeditionZipCode: String(expeditionZipCode || ''),
      paymentMethodCode: metodoPago || 'PUE',
      exchangeRate: 1,
      exportCode: '01',                               // 01 = No aplica exportacion
      issuer: {
        id: issuerId,
        taxRegimeCode: issuerRegimen,
        satTaxRegimeId: issuerRegimen                 // Fiscalapi usa este nombre para el regimen
      },
      recipient: {
        id: recipientId
      },
      items: invoiceItems
    };

    // Regla SAT: si el receptor es el publico en general (RFC generico),
    // la factura debe llevar el nodo de Informacion Global (factura global).
    const rfcReceptor = String(receptor.rfc).trim().toUpperCase();
    if (rfcReceptor === 'XAXX010101000') {
      const ahora = new Date();
      invoice.globalInformation = {
        periodicityCode: '01',                          // 01 = Diario
        monthCode: String(ahora.getMonth() + 1).padStart(2, '0'),
        year: ahora.getFullYear()
      };
      // Regla CFDI40149: en factura global el CP del receptor debe ser
      // igual al lugar de expedicion (CP del emisor). Se reregistra el
      // receptor con el CP correcto.
      const cpEmisor = String(expeditionZipCode || '');
      if (recipientBody.zipCode !== cpEmisor) {
        console.log(`[DIAG] ajustando CP receptor ${recipientBody.zipCode} -> ${cpEmisor} (factura global)`);
      }
      console.log(`[DIAG] factura global activada (publico en general)`);
    }

    console.log(`[DIAG] emisor id=${issuerId} regimen=${issuerRegimen}`);
    console.log(`[DIAG] receptor id=${recipientId} rfc=${receptor.rfc}`);
    console.log(`[DIAG] factura=${JSON.stringify(invoice).slice(0, 1000)}`);

    const res = await fetch(`${FISCALAPI_URL}/api/v4/invoices`, {
      method: 'POST',
      headers: pacHeaders(),
      body: JSON.stringify(invoice)
    });
    const rawText = await res.text();
    console.log(`[FISCALAPI] /api/v4/invoices -> status ${res.status}`);
    console.log(`[FISCALAPI] respuesta cruda: ${rawText.slice(0, 1800)}`);

    let out: any = {};
    try { out = JSON.parse(rawText); } catch { out = { message: rawText }; }

    if (!res.ok || out?.succeeded === false) {
      // Fiscalapi devuelve el detalle util en "details" o "data[].errorMessage"
      const detalleValidacion = Array.isArray(out?.data)
        ? out.data.map((d: any) => `${d.propertyName}: ${d.errorMessage}`).join(' | ')
        : null;
      const msg = out?.details || detalleValidacion || out?.message || `HTTP ${res.status}`;
      console.log(`[FISCALAPI] ERROR: ${msg}`);
      return json({ success: false, error: msg, detail: out }, 502);
    }

    const data = out?.data ?? {};
    return json({
      success: true,
      invoiceId: data.id ?? null,
      uuid: data.uuid ?? data.invoiceUuid ?? null,
      serie: data.series ?? invoice.series,
      folio: data.folio ?? null,
      total: data.total ?? null,
      xml: data.xml ?? data.base64Xml ?? null
    });
  } catch (e) {
    return json({ success: false, error: String(e) }, 500);
  }
});