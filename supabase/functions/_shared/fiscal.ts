// ============================================================================
//  CFDI: identidad -> empresa -> emisor -> factura
// ----------------------------------------------------------------------------
//  ANTES (P0): las funciones fiscales usaban el `issuerId`, `existingPersonId`
//  e `invoiceId` que mandara la petición, con la llave anónima pública. Con
//  conocer un id se podía timbrar a nombre de otro RFC, cancelar o descargar
//  facturas ajenas.
//
//  AHORA: la petición trae la credencial del EQUIPO (cabecera x-wybix-device).
//  La base decide (fiscal_autorizar): el emisor sale de la empresa del equipo;
//  la factura tiene que ser de esa empresa. RFC, razón social, régimen y
//  persona de Fiscalapi NO se toman del cuerpo.
//
//  TRANSICIÓN. Los POS anteriores llaman sin credencial de equipo. Por omisión
//  se rechazan. Solo si el backend tiene FISCAL_PERMITIR_LEGADO=1 (mientras se
//  actualizan) se atienden, y aun así NUNCA sobre un emisor o factura que ya
//  tenga empresa en la nube: esas quedan protegidas en cuanto su dueño se
//  actualiza. Ver docs/fase1-nube.md.
//
//  Este módulo no importa nada de Deno: scripts/probar-fase1.mjs lo prueba en
//  Node contra Postgres real y un Fiscalapi simulado.
// ============================================================================
import { CORS, equipoDe, json, negado, rpcPostgrest, type Rpc } from './nube.ts';

export interface Fiscalapi {
  (path: string, init: { method: string; body?: unknown }): Promise<{ ok: boolean; status: number; out: any }>;
}

export interface DepsFiscal {
  rpc: Rpc;
  fapi: Fiscalapi;
  permitirLegado: boolean;
  log?: (m: string) => void;
}

/** Cliente de Fiscalapi con las llaves del tenant (solo en el servidor). */
export function fiscalapiHttp(base: string, apiKey: string, tenant: string, f: typeof fetch = fetch): Fiscalapi {
  return async (path, init) => {
    const r = await f(`${base}${path}`, {
      method: init.method,
      headers: { 'X-TENANT-KEY': tenant, 'X-API-KEY': apiKey, 'X-TIME-ZONE': 'America/Mexico_City', 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await r.text();
    let out: any;
    try { out = JSON.parse(text); } catch { out = text; }
    return { ok: r.ok && out?.succeeded !== false, status: r.status, out };
  };
}

function errorDe(out: any, status: number): string {
  const val = Array.isArray(out?.data) ? out.data.map((d: any) => `${d.propertyName}: ${d.errorMessage}`).join(' | ') : null;
  return out?.details || val || out?.message || `HTTP ${status}`;
}

/** Lo que sea que mande un POS anterior sin credencial: ¿ya tiene dueño en la nube? */
async function legadoPermitido(deps: DepsFiscal, ids: { person?: string; invoice?: string }): Promise<boolean> {
  if (!deps.permitirLegado) return false;
  const r = await deps.rpc('fiscal_legado_libre', { person_id: ids.person ?? null, invoice_id: ids.invoice ?? null });
  return r?.libre === true;
}

// --------------------------------------------------------------- registrar
export async function registrarEmisor(req: Request, deps: DepsFiscal): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const { razonSocial, regimenFiscal, zipCode, email, cerBase64, keyBase64, password } = body ?? {};
  const tin = String(body?.rfc ?? '').trim().toUpperCase();
  if (!tin || !razonSocial || !regimenFiscal || !cerBase64 || !keyBase64 || !password) {
    return json({ success: false, error: 'Faltan datos del emisor o certificados.' }, 400);
  }
  const eq = await equipoDe(req, deps.rpc);
  if (!eq) return negado('NO_TOKEN');
  const a = await deps.rpc('fiscal_autorizar', { device_id: eq.device_id, action: 'REGISTER' });
  if (!a?.ok) return negado(a?.code);

  // La persona: la que YA usa esta empresa para este RFC, o una nueva. El
  // `existingPersonId` del cuerpo se ignora (era la puerta para reusar la ajena).
  let personId: string | null = (await deps.rpc('fiscal_persona_de_empresa', { device_id: eq.device_id, rfc: tin }))?.person_id ?? null;
  if (!personId) {
    const p = await deps.fapi('/api/v4/people', { method: 'POST', body: {
      legalName: razonSocial,
      email: email || `${tin.toLowerCase()}.${crypto.randomUUID().slice(0, 6)}@wybix.local`,
      password: `Wy_${tin}_${crypto.randomUUID().slice(0, 8)}!`,
      tin, taxRegimeCode: regimenFiscal, satTaxRegimeId: regimenFiscal, zipCode: zipCode || undefined,
    } });
    if (!p.ok || !p.out?.data?.id) return json({ success: false, error: errorDe(p.out, p.status), step: 'person' }, 502);
    personId = String(p.out.data.id);
  }
  const cer = await deps.fapi('/api/v4/tax-files', { method: 'POST', body: { personId, tin, base64File: cerBase64, fileType: 0, password } });
  if (!cer.ok) return json({ success: false, error: errorDe(cer.out, cer.status), step: 'cer' }, 502);
  const key = await deps.fapi('/api/v4/tax-files', { method: 'POST', body: { personId, tin, base64File: keyBase64, fileType: 1, password } });
  if (!key.ok) return json({ success: false, error: errorDe(key.out, key.status), step: 'key' }, 502);

  const reg = await deps.rpc('fiscal_registrar_emisor', {
    device_id: eq.device_id, person_id: personId, rfc: tin, legal_name: razonSocial, tax_regime: regimenFiscal, zip_code: zipCode ?? null,
  });
  if (!reg?.ok) return negado(reg?.code);
  return json({ success: true, issuerId: personId, cloudIssuerId: reg.issuer_id });
}

// --------------------------------------------------------------- timbrar
export async function timbrar(req: Request, deps: DepsFiscal): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const { series, receptor, formaPago, metodoPago, items } = body ?? {};
  if (!receptor?.rfc || !receptor?.razonSocial || !receptor?.regimenFiscal || !receptor?.usoCfdi || !receptor?.zipCode) {
    return json({ success: false, error: 'Faltan datos fiscales del receptor.' }, 400);
  }
  if (!Array.isArray(items) || items.length === 0) return json({ success: false, error: 'La factura no tiene conceptos.' }, 400);

  let emisor: { id: string | null; person_id: string; tax_regime: string; zip_code: string | null };
  const eq = await equipoDe(req, deps.rpc);
  if (eq) {
    const a = await deps.rpc('fiscal_autorizar', { device_id: eq.device_id, action: 'STAMP', issuer_id: body?.issuerId ?? null });
    if (!a?.ok) return negado(a?.code);
    emisor = a.issuer;
  } else {
    // POS anterior: solo en transición y solo si ese emisor no tiene empresa.
    if (!body?.issuerId || !body?.issuerRegimen) return negado('NO_TOKEN');
    if (!(await legadoPermitido(deps, { person: String(body.issuerId) }))) return negado('NO_TOKEN');
    emisor = { id: null, person_id: String(body.issuerId), tax_regime: String(body.issuerRegimen), zip_code: null };
  }

  const expedicion = /^\d{5}$/.test(String(body?.expeditionZipCode ?? '')) ? String(body.expeditionZipCode) : String(emisor.zip_code ?? '');
  const rfcReceptor = String(receptor.rfc).trim().toUpperCase();
  const publicoGeneral = rfcReceptor === 'XAXX010101000';
  const rec = await deps.fapi('/api/v4/people', { method: 'POST', body: {
    legalName: receptor.razonSocial,
    email: `rec.${rfcReceptor.toLowerCase()}.${crypto.randomUUID().slice(0, 10)}@wybix.local`,
    password: `Wy_${crypto.randomUUID().slice(0, 10)}!`,
    tin: rfcReceptor, taxRegimeCode: receptor.regimenFiscal, satTaxRegimeId: receptor.regimenFiscal,
    cfdiUseCode: receptor.usoCfdi, satCfdiUseId: receptor.usoCfdi,
    // CFDI40149: en factura global el CP del receptor = lugar de expedición.
    zipCode: publicoGeneral ? expedicion : String(receptor.zipCode),
  } });
  const recipientId = rec.out?.data?.id;
  if (!recipientId) return json({ success: false, error: errorDe(rec.out, rec.status) || 'No se pudo registrar el receptor.' }, 502);

  const invoice: any = {
    versionCode: '4.0',
    series: series || 'F',
    date: new Date().toLocaleString('sv-SE', { timeZone: 'America/Mexico_City' }).replace(' ', 'T'),
    paymentFormCode: formaPago || '01',
    paymentConditions: 'Contado',
    currencyCode: 'MXN',
    typeCode: 'I',
    expeditionZipCode: expedicion,
    paymentMethodCode: metodoPago || 'PUE',
    exchangeRate: 1,
    exportCode: '01',
    // El emisor SALE DE LA NUBE: persona y régimen del emisor de la empresa.
    issuer: { id: emisor.person_id, taxRegimeCode: emisor.tax_regime, satTaxRegimeId: emisor.tax_regime },
    recipient: { id: recipientId },
    items: items.map((it: any, idx: number) => {
      const taxRate = it.taxRate != null ? Number(it.taxRate) : 0.16;
      const taxObject = it.taxObject || '02';
      const item: any = {
        itemCode: it.claveProdServ || '01010101', itemSku: it.sku || `SKU-${idx + 1}`,
        quantity: Number(it.quantity || 0), unitOfMeasurementCode: it.claveUnidad || 'H87',
        description: it.description || 'Producto', unitPrice: Number(it.unitPrice || 0),
        taxObjectCode: taxObject, discount: Number(it.discount || 0),
      };
      if (taxObject === '02' && taxRate > 0) {
        item.itemTaxes = [{ taxCode: '002', taxTypeCode: 'Tasa', taxRate: taxRate.toFixed(6), taxFlagCode: 'T' }];
      }
      return item;
    }),
  };
  if (publicoGeneral) {
    const ahora = new Date();
    invoice.globalInformation = { periodicityCode: '01', monthCode: String(ahora.getMonth() + 1).padStart(2, '0'), year: ahora.getFullYear() };
  }

  const r = await deps.fapi('/api/v4/invoices', { method: 'POST', body: invoice });
  if (!r.ok) return json({ success: false, error: errorDe(r.out, r.status) }, 502);
  const data = r.out?.data ?? {};

  if (eq && emisor.id && data.id) {
    // La factura queda con SU empresa: es lo que después permite (o niega)
    // cancelarla y descargarla.
    await deps.rpc('fiscal_registrar_factura', {
      device_id: eq.device_id, issuer_id: emisor.id, invoice_id: String(data.id),
      sat_uuid: data.uuid ?? data.invoiceUuid ?? null, series: data.series ?? invoice.series, folio: data.folio ?? null, total: data.total ?? null,
    });
  }
  return json({
    success: true, invoiceId: data.id ?? null, uuid: data.uuid ?? data.invoiceUuid ?? null,
    serie: data.series ?? invoice.series, folio: data.folio ?? null, total: data.total ?? null,
    xml: data.xml ?? data.base64Xml ?? null, issuerId: emisor.person_id,
  });
}

/** Factura -> autorizada para ESTE equipo (o transición legada). */
async function facturaAutorizada(req: Request, deps: DepsFiscal, accion: 'CANCEL' | 'FILES', invoiceId: string) {
  const eq = await equipoDe(req, deps.rpc);
  if (eq) {
    const a = await deps.rpc('fiscal_autorizar', { device_id: eq.device_id, action: accion, invoice_id: invoiceId });
    if (!a?.ok) return { error: negado(a?.code) };
    return { eq, fiscalapiId: String(a.invoice.fiscalapi_invoice_id) };
  }
  if (await legadoPermitido(deps, { invoice: invoiceId })) return { eq: null, fiscalapiId: invoiceId };
  return { error: negado('NO_TOKEN') };
}

// --------------------------------------------------------------- cancelar
export async function cancelar(req: Request, deps: DepsFiscal): Promise<Response> {
  const { invoiceId, motivo, folioSustitucion } = await req.json().catch(() => ({}));
  if (!invoiceId) return json({ success: false, error: 'Falta el id de la factura.' }, 400);
  if (!motivo) return json({ success: false, error: 'Falta el motivo de cancelacion.' }, 400);
  if (motivo === '01' && !folioSustitucion) return json({ success: false, error: 'El motivo 01 requiere el UUID de la factura que la sustituye.' }, 400);
  const z = await facturaAutorizada(req, deps, 'CANCEL', String(invoiceId));
  if ('error' in z) return z.error!;

  const cuerpo: any = { id: z.fiscalapiId, cancellationReasonCode: motivo };
  if (motivo === '01') cuerpo.replacementUuid = folioSustitucion;
  const r = await deps.fapi('/api/v4/invoices', { method: 'DELETE', body: cuerpo });
  if (!r.ok) return json({ success: false, error: errorDe(r.out, r.status) }, 502);
  if (z.eq) await deps.rpc('fiscal_marcar_cancelacion', { device_id: z.eq.device_id, invoice_id: z.fiscalapiId, cancelled: true });
  const data = r.out?.data ?? {};
  return json({ success: true, acuseBase64: data.base64CancellationAcknowledgement ?? null, estatusPorUuid: data.invoiceUuids ?? null });
}

// --------------------------------------------------------------- archivos
function extraerBase64(data: any, claves: string[]): string | null {
  const cont = data?.data ?? data;
  if (!cont) return null;
  for (const k of claves) if (typeof cont[k] === 'string' && cont[k].length > 100) return cont[k];
  return null;
}

export async function archivos(req: Request, deps: DepsFiscal): Promise<Response> {
  const { invoiceId } = await req.json().catch(() => ({}));
  if (!invoiceId) return json({ success: false, error: 'Falta invoiceId.' }, 400);
  const z = await facturaAutorizada(req, deps, 'FILES', String(invoiceId));
  if ('error' in z) return z.error!;
  const id = encodeURIComponent(z.fiscalapiId);

  let pdfBase64: string | null = null;
  for (const p of [`/api/v4/invoices/${id}/pdf`, `/api/v4/invoices/${id}/file/pdf`, `/api/v4/invoices/pdf/${id}`]) {
    const r = await deps.fapi(p, { method: 'GET' });
    if (r.ok) {
      pdfBase64 = extraerBase64(r.out, ['base64File', 'pdf', 'base64Pdf', 'content', 'file'])
        ?? (typeof r.out === 'string' && r.out.length > 100 ? r.out : null);
      if (pdfBase64) break;
    }
  }
  let xmlBase64: string | null = null;
  for (const p of [`/api/v4/invoices/${id}/xml`, `/api/v4/invoices/${id}/file/xml`, `/api/v4/invoices/xml/${id}`]) {
    const r = await deps.fapi(p, { method: 'GET' });
    if (r.ok) {
      xmlBase64 = extraerBase64(r.out, ['base64File', 'xml', 'base64Xml', 'content', 'file'])
        ?? (typeof r.out === 'string' && r.out.length > 100 ? btoa(r.out) : null);
      if (xmlBase64) break;
    }
  }
  if (!pdfBase64 && !xmlBase64) return json({ success: false, error: 'No se pudieron obtener los archivos.' }, 502);
  return json({ success: true, pdfBase64, xmlBase64 });
}

// --------------------------------------------------------------- histórico
/**
 * TRANSICIÓN: el POS reclama el emisor y las facturas que tiene en su base
 * local (anteriores a la Fase 1). El RFC se toma de Fiscalapi, no del cuerpo:
 * si la persona no existe en el tenant, no hay nada que reclamar.
 */
export async function reclamarHistorico(req: Request, deps: DepsFiscal): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const personId = String(body?.issuerId ?? '').trim();
  if (!personId) return json({ success: false, error: 'Falta el emisor.' }, 400);
  const eq = await equipoDe(req, deps.rpc);
  if (!eq) return negado('NO_TOKEN');
  const p = await deps.fapi(`/api/v4/people/${encodeURIComponent(personId)}`, { method: 'GET' });
  const tin = p.ok ? String(p.out?.data?.tin ?? '').toUpperCase() : '';
  if (!tin) return json({ success: false, code: 'UNKNOWN_PERSON', error: 'Ese emisor no existe en Wybix Facturación.' }, 404);
  const facturas = (Array.isArray(body?.invoices) ? body.invoices : []).slice(0, 5000).map((f: any) => ({
    invoice_id: String(f?.invoiceId ?? ''), sat_uuid: f?.uuid ?? null, series: f?.serie ?? null, folio: f?.folio ?? null,
    total: f?.total ?? null, cancelled: !!f?.cancelada,
  }));
  const r = await deps.rpc('fiscal_reclamar_historico', {
    device_id: eq.device_id, person_id: personId, rfc: tin, legal_name: p.out?.data?.legalName ?? null,
    tax_regime: p.out?.data?.satTaxRegimeId ?? p.out?.data?.taxRegimeCode ?? null, zip_code: p.out?.data?.zipCode ?? null, invoices: facturas,
  });
  if (!r?.ok) return negado(r?.code);
  return json({ success: true, issuerStatus: r.issuer_status, invoices: r.invoices });
}

/** Envoltura HTTP común (CORS, método, errores). */
export function servir(manejador: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ success: false, error: 'Método no permitido.' }, 405);
    try { return await manejador(req); } catch (_e) { return json({ success: false, error: 'Error del servicio de facturación.' }, 500); }
  };
}

/** Dependencias reales a partir de los secrets de la función (null si falta alguno). */
export function depsFiscalDelEntorno(env: (k: string) => string | undefined): DepsFiscal | null {
  const url = env('SUPABASE_URL'), service = env('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = env('FISCALAPI_API_KEY'), tenant = env('FISCALAPI_TENANT');
  if (!url || !service || !apiKey || !tenant) return null;
  return {
    rpc: rpcPostgrest(url, service),
    fapi: fiscalapiHttp(env('FISCALAPI_URL') ?? 'https://test.fiscalapi.com', apiKey, tenant),
    permitirLegado: env('FISCAL_PERMITIR_LEGADO') === '1',
  };
}

export const sinConfiguracion = () => json({ success: false, error: 'Faltan credenciales del PAC o del backend.' }, 500);
