// ============================================================
// Motor de notificaciones: un ciclo de entrega (lo corre la función
// `notificaciones` cada minuto). La lógica de qué avisar y a quién vive en
// SQL (notif_planear); aquí solo se ENTREGA y se reporta.
//
//   planear -> vencer viejas -> push (Expo, en lotes de 100) -> correo
//   (Resend, uno por uno con llave de idempotencia) -> recibos de Expo
//
// Los proveedores son interfaces: el motor no sabe de Expo ni de Resend.
// ============================================================

export interface Entrega {
  id: number; canal: 'push' | 'email'; destino: string; titulo: string; cuerpo: string;
  datos: Record<string, unknown>; attempts: number;
}

/** Resultado de un envío: ok, o error transitorio/permanente/token inválido. */
export type ResultadoEnvio =
  | { ok: true; ref: string | null }
  | { ok: false; error: string; permanente: boolean; tokenInvalido?: boolean };

export interface ProveedorPush {
  enviar(lote: Entrega[]): Promise<ResultadoEnvio[]>;               // mismo orden que el lote
  recibos(refs: string[]): Promise<Map<string, ResultadoEnvio>>;    // ref -> estado final
}
export interface ProveedorCorreo {
  enviar(e: Entrega): Promise<ResultadoEnvio>;
}

export interface DepsMotor {
  rpc(nombre: string, args?: Record<string, unknown>): Promise<any>;
  push: ProveedorPush | null;     // null = no configurado: sus entregas esperan
  correo: ProveedorCorreo | null;
  log?: (m: string) => void;
}

export interface Resumen { planeadas: number; vencidas: number; push: { ok: number; fallo: number }; correo: { ok: number; fallo: number }; recibos: number }

async function reportar(d: DepsMotor, e: Entrega, r: ResultadoEnvio) {
  if (r.ok) await d.rpc('notif_resultado', { p_id: e.id, p_ok: true, p_ref: r.ref });
  else await d.rpc('notif_resultado', { p_id: e.id, p_ok: false, p_error: r.error, p_permanente: r.permanente, p_token_invalido: !!r.tokenInvalido });
}

export async function ejecutarCiclo(d: DepsMotor): Promise<Resumen> {
  const res: Resumen = { planeadas: 0, vencidas: 0, push: { ok: 0, fallo: 0 }, correo: { ok: 0, fallo: 0 }, recibos: 0 };
  res.planeadas = Number(await d.rpc('notif_planear', { p_limite: 200 })) || 0;
  res.vencidas = Number(await d.rpc('notif_vencer', { p_horas: 48 })) || 0;

  if (d.push) {
    const lote = ((await d.rpc('notif_tomar', { p_canal: 'push', p_limite: 100 })) ?? []) as Entrega[];
    if (lote.length) {
      let resultados: ResultadoEnvio[];
      try { resultados = await d.push.enviar(lote); }
      catch (e) { resultados = lote.map(() => ({ ok: false, error: `push: ${e instanceof Error ? e.message : String(e)}`, permanente: false })); }
      for (let i = 0; i < lote.length; i++) {
        const r = resultados[i] ?? { ok: false, error: 'sin respuesta del proveedor', permanente: false };
        await reportar(d, lote[i], r);
        if (r.ok) res.push.ok++; else res.push.fallo++;
      }
    }
    const pend = ((await d.rpc('notif_por_recibo', { p_limite: 300 })) ?? []) as Array<{ id: number; provider_ref: string }>;
    if (pend.length) {
      try {
        const estados = await d.push.recibos(pend.map((p) => p.provider_ref));
        for (const p of pend) {
          const r = estados.get(p.provider_ref);
          if (!r) continue;                         // Expo aún no lo tiene: se revisa en otro ciclo
          if (r.ok) await d.rpc('notif_recibo', { p_id: p.id, p_ok: true });
          else await d.rpc('notif_recibo', { p_id: p.id, p_ok: false, p_error: r.error, p_token_invalido: !!r.tokenInvalido });
          res.recibos++;
        }
      } catch (e) { d.log?.(`recibos: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  if (d.correo) {
    const lote = ((await d.rpc('notif_tomar', { p_canal: 'email', p_limite: 50 })) ?? []) as Entrega[];
    for (const e of lote) {
      let r: ResultadoEnvio;
      try { r = await d.correo.enviar(e); }
      catch (x) { r = { ok: false, error: `correo: ${x instanceof Error ? x.message : String(x)}`, permanente: false }; }
      await reportar(d, e, r);
      if (r.ok) res.correo.ok++; else res.correo.fallo++;
    }
  }
  return res;
}

// ------------------------------------------------------------ Expo Push
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const EXPO_PERMANENTES = new Set(['MessageTooBig', 'InvalidCredentials', 'MismatchSenderId', 'InvalidProviderToken']);

function deExpo(item: any): ResultadoEnvio {
  if (item?.status === 'ok') return { ok: true, ref: item.id ?? null };
  const tipo = String(item?.details?.error ?? '');
  const error = `${tipo || 'error'}: ${String(item?.message ?? '').slice(0, 200)}`;
  if (tipo === 'DeviceNotRegistered') return { ok: false, error, permanente: true, tokenInvalido: true };
  return { ok: false, error, permanente: EXPO_PERMANENTES.has(tipo) };
}

export function pushExpo(f: Fetch, tokenAcceso?: string | null): ProveedorPush {
  const cab: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (tokenAcceso) cab.Authorization = `Bearer ${tokenAcceso}`;
  return {
    async enviar(lote) {
      const mensajes = lote.map((e) => ({ to: e.destino, title: e.titulo, body: e.cuerpo, data: e.datos, sound: 'default', priority: 'high', channelId: 'default' }));
      const r = await f('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: cab, body: JSON.stringify(mensajes) });
      if (!r.ok) {
        const permanente = r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408;
        return lote.map(() => ({ ok: false, error: `HTTP ${r.status}`, permanente }));
      }
      const j = await r.json();
      return lote.map((_, i) => deExpo(j?.data?.[i]));
    },
    async recibos(refs) {
      const out = new Map<string, ResultadoEnvio>();
      for (let i = 0; i < refs.length; i += 300) {
        const r = await f('https://exp.host/--/api/v2/push/getReceipts', { method: 'POST', headers: cab, body: JSON.stringify({ ids: refs.slice(i, i + 300) }) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        for (const [id, v] of Object.entries(j?.data ?? {})) out.set(id, deExpo(v));
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- correo
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Misma estructura que el correo aprobado de Wybix (wybix-landing/emails/reset-password.html). */
export function correoHtml(titulo: string, cuerpo: string): string {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(titulo)}</title></head>
<body style="margin:0;padding:0;background-color:#F1F5F9;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F1F5F9;padding:32px 0;"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:92%;background-color:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td align="center" style="background-color:#0F2A3F;padding:28px 24px 22px 24px;">
<img src="https://wybixpos.com.mx/logo-wybix.png" alt="Wybix" width="48" height="48" style="display:block;border:0;outline:none;">
<div style="color:#ffffff;font-size:18px;font-weight:bold;margin-top:10px;">Wybix</div></td></tr>
<tr><td style="padding:30px 36px 8px 36px;"><h1 style="color:#0F2A3F;font-size:20px;margin:0 0 12px 0;">${esc(titulo)}</h1>
<p style="color:#475569;font-size:15px;line-height:23px;margin:0 0 18px 0;">${esc(cuerpo)}</p></td></tr>
<tr><td style="padding:0 36px 28px 36px;"><p style="color:#94A3B8;font-size:12px;line-height:18px;margin:0;">Recibes este aviso porque administras este negocio en Wybix. Puedes apagarlo desde la app: Avisos.</p></td></tr>
</table></td></tr></table></body></html>`;
}

export function correoResend(f: Fetch, apiKey: string, remitente: string): ProveedorCorreo {
  return {
    async enviar(e) {
      const r = await f('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `wybix-entrega-${e.id}` },
        body: JSON.stringify({ from: remitente, to: [e.destino], subject: e.titulo, text: `${e.titulo}\n\n${e.cuerpo}\n\n— Wybix`, html: correoHtml(e.titulo, e.cuerpo) }),
      });
      if (r.ok) { const j = await r.json().catch(() => ({})); return { ok: true, ref: j?.id ?? null }; }
      const texto = (await r.text().catch(() => '')).slice(0, 200);
      // 400/422: el mensaje está mal (no mejora reintentando). 401/403: configuración (dominio, llave): reintentar con espera.
      const permanente = r.status === 400 || r.status === 422;
      return { ok: false, error: `HTTP ${r.status} ${texto}`, permanente };
    },
  };
}
