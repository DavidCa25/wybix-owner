// ============================================================
// Edge Function: fiscal-stamp-invoice
// Timbra un CFDI 4.0 con el emisor de la EMPRESA del equipo.
//
// FASE 1 (P0 fiscal): la autorización es identidad -> empresa -> emisor ->
// factura. La petición trae la credencial del EQUIPO (cabecera
// x-wybix-device, la emite pos-sync); el emisor y la factura salen de la
// empresa de ese equipo. Lógica completa y probada en _shared/fiscal.ts
// (scripts/probar-fase1.mjs).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FISCALAPI_URL,
//          FISCALAPI_API_KEY, FISCALAPI_TENANT,
//          FISCAL_PERMITIR_LEGADO=1 (opcional, SOLO mientras se actualizan los POS)
// ============================================================
import { depsFiscalDelEntorno, timbrar, servir, sinConfiguracion } from '../_shared/fiscal.ts';

const deps = depsFiscalDelEntorno((k) => Deno.env.get(k));

Deno.serve(servir((req) => (deps ? timbrar(req, deps) : Promise.resolve(sinConfiguracion()))));
