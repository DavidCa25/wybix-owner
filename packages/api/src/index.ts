/**
 * CLIENTE DE LA NUBE PARA WYBIX POS MOBILE.
 *
 * Habla con la Edge Function `pos-sync` con la credencial del EQUIPO
 * (cabecera x-wybix-device), nunca con la sesión personal de nadie. La
 * empresa y el evento los decide la nube a partir de esa credencial; el sobre
 * solo los repite para que la nube detecte una tablet mal configurada.
 *
 * Errores:
 *   sin red / 5xx          -> se lanza un Error común: el motor lo trata como
 *                             "sin conexión" y reintenta con backoff.
 *   401 / 403 de equipo    -> ErrorNubeDenegada: la tablet fue dada de baja o
 *                             su credencial no existe. No se reintenta a ciegas.
 */
import { ErrorNubeDenegada, type Nube } from '@wybix/sync';
import type { EventoSalida, Snapshot } from '@wybix/database';

export interface OpcionesCliente {
  base: string;                       // https://www.wybixpos.com.mx/backend (o local en pruebas)
  anonKey: string;
  credencial: () => Promise<string | null>;
  version: string;
  identidad: () => Promise<{ company_uuid: string; location_uuid: string } | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ErrorNube extends Error {
  code: string | null; status: number;
  constructor(m: string, code: string | null, status: number) { super(m); this.code = code; this.status = status; }
}

/** Estado de una autorización a distancia, como la devuelve la nube. */
export interface EstadoAprobacion {
  id: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'CONSUMED';
  action: string; expires_at: string; decided_name: string | null; decision_note: string | null;
  approver?: { uuid: string; name: string | null; user_id: string | null };
}

export function crearClienteNube(o: OpcionesCliente) {
  const f = o.fetch ?? fetch;
  // Fase 3: desfase del reloj de la tablet contra el servidor (cabecera Date de
  // cada respuesta, al punto medio de la petición). Precisión de 1 s: sobra
  // para la fecha de negocio y para avisar de un reloj mal puesto.
  let ultimoDesfase: { ms: number; at: Date } | null = null;

  async function llamar(action: string, cuerpo: Record<string, unknown>, conCredencial = true): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: o.anonKey, Authorization: `Bearer ${o.anonKey}`, 'x-wybix-version': o.version };
    if (conCredencial) {
      const t = await o.credencial();
      if (!t) throw new ErrorNubeDenegada('NO_TOKEN', 'La tablet no está enrolada.');
      headers['x-wybix-device'] = t;
    }
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20_000);
    let res: Response;
    const t0 = Date.now();
    try {
      res = await f(`${o.base}/functions/v1/pos-sync`, { method: 'POST', headers, body: JSON.stringify({ action, ...cuerpo }), signal: ctrl.signal });
    } finally { clearTimeout(reloj); }
    const t1 = Date.now();
    const servidor = Date.parse(res.headers?.get?.('date') ?? '');
    if (Number.isFinite(servidor) && t1 - t0 < 10_000) ultimoDesfase = { ms: servidor - Math.round((t0 + t1) / 2), at: new Date(t1) };
    const data = await res.json().catch(() => null);
    if (res.ok && data?.success) return data;
    const code = data?.code ?? null;
    if (conCredencial && (res.status === 401 || code === 'DEVICE_REVOKED')) throw new ErrorNubeDenegada(code ?? 'DENIED', data?.error ?? 'Sin acceso.');
    throw new ErrorNube(data?.error ?? `HTTP ${res.status}`, code, res.status);
  }

  const nube: Nube & {
    enrolar(codigo: string, deviceUuid: string, nombre?: string): Promise<{ token: string; device_id: string; register_id: string | null; company_id: string; location_id: string }>;
    /** Último desfase medido (servidor - tablet), o null si aún no hay respuesta con hora. */
    desfase(): { ms: number; at: Date } | null;
    aprobaciones: {
      solicitar(a: { id: string; accion: string; solicita: { uuid: string; name: string; role: string }; payload: Record<string, unknown> }): Promise<EstadoAprobacion>;
      estado(id: string): Promise<EstadoAprobacion>;
      consumir(id: string, payload: Record<string, unknown>): Promise<EstadoAprobacion>;
      cancelar(id: string): Promise<EstadoAprobacion>;
    };
  } = {
    async enrolar(codigo, deviceUuid, nombre) {
      const limpio = String(codigo ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      return llamar('enroll', { code: limpio, device_uuid: deviceUuid, kind: 'MOBILE_POS', app_version: o.version, name: nombre ?? null }, false);
    },
    async enviarEventos(lote: { events: EventoSalida[]; device_now: string; last_seq: number }) {
      const id = await o.identidad();
      const r = await llamar('events', {
        envelope: { company_uuid: id?.company_uuid ?? null, location_uuid: id?.location_uuid ?? null, device_now: lote.device_now },
        events: lote.events.map((e) => ({
          event_uuid: e.event_uuid, event_type: e.event_type, aggregate_type: e.aggregate_type, aggregate_uuid: e.aggregate_uuid,
          // El orden y la versión de una tablet son su secuencia local, no su reloj.
          aggregate_version: e.local_seq, local_seq: e.local_seq,
          occurred_at: e.occurred_at, payload_version: e.schema_version, payload: e.payload,
        })),
      });
      return { results: r.results ?? [] };
    },
    async snapshot(): Promise<Snapshot> { return llamar('mobile_snapshot', {commercial_schema:2}); },
    async inbox(cursor: number) { const r = await llamar('mobile_inbox', { cursor }); return { events: r.events ?? [], cursor: Number(r.cursor ?? cursor) }; },
    async latido(info) { await llamar('mobile_heartbeat', info as Record<string, unknown>); },
    desfase: () => ultimoDesfase,
    // Fase 3: la credencial del equipo identifica a la tablet; aquí solo va lo que se pide.
    aprobaciones: {
      solicitar: (a) => llamar('approval_request', { id: a.id, approval_action: a.accion, requested_by: a.solicita, payload: a.payload }),
      estado: (id) => llamar('approval_status', { id }),
      consumir: (id, payload) => llamar('approval_consume', { id, payload }),
      cancelar: (id) => llamar('approval_cancel', { id }),
    },
  };
  return nube;
}
