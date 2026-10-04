// ============================================================
// Alerta en vivo -> push a los dueños (camino heredado de "robo hormiga").
//
// La llama la base al INSERTAR en public.alertas (trigger con el secreto en
// Vault, ver la migración 20261011100000_fase3_alerta_push_vault.sql). La
// sirven DOS slugs con el mismo código:
//   notificar-alerta  el nombre documentado (NOTIFICACIONES.md);
//   send-alert-push   el que usa el trigger de producción. Antes ese slug
//                     tenía la plantilla "Hello" de Supabase (no enviaba nada)
//                     y la copia del repo era el link-owner VIEJO, que dejaba
//                     reclamar un negocio sin dueño. Ya no.
//
// Destinatarios: los mismos que antes (negocios.owner_id + owner_apps). El
// motor de notificaciones de la Fase 3 los reemplaza por membresías y
// preferencias; aquí solo se cierra la autenticación.
// ============================================================

import { validarWebhook } from './webhook.ts';

export interface AdminAlertas {
  negocioDeSucursal(sucursalId: string): Promise<string | null>;
  duenos(negocioId: string): Promise<string[]>;
  tokens(duenos: string[]): Promise<string[]>;
}

export interface DepsAlertaPush {
  secreto: string | undefined;
  admin: () => AdminAlertas;
  enviar: (mensajes: unknown[]) => Promise<unknown>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function manejarAlertaPush(req: Request, d: DepsAlertaPush): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'método no permitido' }, 405);
  const auth = await validarWebhook(d.secreto, req.headers.get('x-webhook-secret'));
  if (!auth.ok) {
    // Sin el valor recibido ni el configurado: solo el motivo.
    console.warn(`[alerta-push] rechazado: ${auth.motivo}`);
    return json({ error: auth.motivo === 'SIN_CONFIGURAR' ? 'webhook sin configurar' : 'no autorizado' }, auth.status);
  }
  try {
    const payload = await req.json().catch(() => ({}));
    const record = payload?.record ?? payload;               // webhook de Supabase: { type, table, record }
    const sucursalId = typeof record?.sucursal_id === 'string' ? record.sucursal_id : null;
    if (!sucursalId) return json({ error: 'sin sucursal_id' }, 400);

    const admin = d.admin();
    const negocio = await admin.negocioDeSucursal(sucursalId);
    if (!negocio) return json({ ok: true, sent: 0, reason: 'sucursal sin negocio' });
    const duenos = await admin.duenos(negocio);
    if (!duenos.length) return json({ ok: true, sent: 0, reason: 'sin dueños' });
    const tokens = await admin.tokens(duenos);
    if (!tokens.length) return json({ ok: true, sent: 0, reason: 'sin tokens' });

    const mensajes = tokens.map((to) => ({
      to, sound: 'default', priority: 'high', channelId: 'default',
      title: String(record?.titulo ?? 'Alerta de Wybix'),
      body: String(record?.mensaje ?? ''),
      data: { tipo: String(record?.tipo ?? ''), sucursalId },
    }));
    const expo = await d.enviar(mensajes);
    return json({ ok: true, sent: tokens.length, expo });
  } catch (e) {
    console.error('[alerta-push] error', e instanceof Error ? e.message : String(e));
    return json({ error: 'error interno' }, 500);
  }
}
