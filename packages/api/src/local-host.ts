/**
 * CLIENTE DEL LOCAL HOST: LA TABLET COMO CAJA DE LA SUCURSAL (POS 0094).
 *
 * La computadora principal del negocio (Wybix POS de escritorio con Local
 * Host encendido, puerto 7427) habla con la tablet el MISMO contrato que la
 * nube: snapshot, eventos y latido. Así el motor de sincronización
 * (@wybix/sync) no sabe ni le importa a quién le entrega: vender, el outbox,
 * los reintentos y las métricas son idénticos.
 *
 * La diferencia es la red: la del local responde en milisegundos y no
 * necesita Internet. Sin la computadora principal la tablet sigue vendiendo y
 * entrega todo al volver (idempotente por event_uuid y por la clave de venta).
 *
 * Emparejar: la computadora muestra un QR con `http://<ip>:7427/pair/<token>`;
 * la tablet lo canjea una vez por su credencial y la manda como Bearer.
 */
import { ErrorNubeDenegada, type Nube } from '@wybix/sync';
import type { EventoSalida, Snapshot } from '@wybix/database';

export interface OpcionesLocalHost {
  /** http://192.168.1.20:7427 */
  base: string;
  credencial: () => Promise<string | null>;
  version: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ErrorLocalHost extends Error {
  status: number; motivo: string | null;
  constructor(m: string, status: number, motivo: string | null = null) { super(m); this.status = status; this.motivo = motivo; }
}

/** Lo que trae el QR de emparejar de la computadora: su dirección y el token. */
export function leerQrLocalHost(texto: string): { base: string; token: string } | null {
  const m = /^(https?:\/\/[^/\s]+)\/pair\/([A-Za-z0-9_-]{20,200})\/?$/.exec(String(texto ?? '').trim());
  return m ? { base: m[1], token: m[2] } : null;
}

/** Canjea el QR por la credencial de ESTA tablet. Una sola vez por QR. */
export async function emparejarLocalHost(qr: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const p = leerQrLocalHost(qr);
  if (!p) throw new ErrorLocalHost('Ese código no es de una computadora con Wybix. En la computadora: Configuración › Dispositivos locales › Conectar dispositivo › Caja móvil.', 400);
  const f = o.fetch ?? fetch;
  const ctrl = new AbortController();
  const reloj = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await f(`${p.base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: p.token }), signal: ctrl.signal });
  } catch {
    throw new ErrorLocalHost('No se alcanza la computadora principal. Revisa que la tablet esté en la misma red Wi-Fi del local.', 0);
  } finally { clearTimeout(reloj); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ErrorLocalHost(data?.error ?? `HTTP ${res.status}`, res.status, data?.motivo ?? null);
  if (data?.dispositivo?.superficie !== 'CAJA_MOVIL' || !data?.credencial) {
    throw new ErrorLocalHost('Ese QR es de otra función. En la computadora elige «Caja móvil» al agregar el dispositivo.', 409, 'FUNCION');
  }
  return { base: p.base, credencial: String(data.credencial), device_id: String(data.dispositivo.id), nombre: String(data.dispositivo.nombre ?? '') };
}

export function crearClienteLocalHost(o: OpcionesLocalHost) {
  const f = o.fetch ?? fetch;

  async function llamar(ruta: string, cuerpo: Record<string, unknown>): Promise<any> {
    const t = await o.credencial();
    if (!t) throw new ErrorNubeDenegada('NO_TOKEN', 'La tablet no está emparejada.');
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await f(`${o.base}${ruta}`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'x-wybix-version': o.version },
        body: JSON.stringify(cuerpo),
      });
    } finally { clearTimeout(reloj); }
    const data = await res.json().catch(() => null);
    if (res.ok) return data;
    // Revocada en la computadora (o credencial desconocida): no se reintenta a ciegas.
    if (res.status === 401) throw new ErrorNubeDenegada('DEVICE_REVOKED', data?.error ?? 'Esta tablet ya no está conectada a la caja principal.');
    throw new ErrorLocalHost(data?.error ?? `HTTP ${res.status}`, res.status, data?.motivo ?? null);
  }

  const nube: Nube = {
    async enviarEventos(lote: { events: EventoSalida[]; device_now: string; last_seq: number }) {
      const r = await llamar('/api/caja/eventos', {
        events: lote.events.map((e) => ({
          event_uuid: e.event_uuid, event_type: e.event_type, aggregate_type: e.aggregate_type, aggregate_uuid: e.aggregate_uuid,
          local_seq: e.local_seq, occurred_at: e.occurred_at, payload: e.payload,
        })),
      });
      return { results: r?.results ?? [] };
    },
    async snapshot(desde): Promise<Snapshot> {
      const s = await llamar('/api/caja/snapshot', { catalog_version: desde?.catalog_version ?? 0, security_revision: desde?.security_revision ?? 0 });
      return s as Snapshot;
    },
    async inbox(cursor: number) { return { events: [], cursor }; },
    async latido(info) { await llamar('/api/caja/latido', info as unknown as Record<string, unknown>).catch(() => undefined); },
  };
  return nube;
}
