/**
 * MOTOR DE SINCRONIZACIÓN DEL POS MOBILE.
 *
 * La integridad NO depende de que esto corra en segundo plano. Se dispara:
 *   - al abrir la app,
 *   - al recuperar la red,
 *   - cada minuto mientras la app está activa,
 *   - con el botón "Sincronizar",
 *   - y, si Android lo permite, como tarea en segundo plano (mejora, no requisito).
 * Correr dos veces a la vez no puede pasar (una sola ejecución en curso), y
 * correr de más no hace daño: la nube es idempotente por event_uuid.
 *
 * Orden: los eventos salen por `local_seq`. La nube devuelve un resultado por
 * evento; un lote con unos aceptados y otros no se procesa evento por evento.
 *
 * Reintentos: backoff exponencial con jitter (5 s ... 15 min), por evento. Un
 * turno abierto nunca se bloquea porque la nube no conteste: vender no espera
 * a nada de esto.
 */
import {
  pendientes, aplicarResultados, reprogramar, resumen, marcarSincronizado, aplicarInbox, aplicarSnapshot,
  type BaseLocal, type EventoSalida, type Resultado, type Snapshot,
} from '@wybix/database';

export interface Nube {
  enviarEventos(lote: { events: EventoSalida[]; device_now: string; last_seq: number }): Promise<{ results: Array<{ event_uuid: string; result: Resultado; error?: string | null }> }>;
  /** brand_hash: la marca que la tablet ya tiene; la nube no reenvía su logo si no cambió. */
  /** catalog_version / security_revision: lo que la tablet ya tiene; la nube no reenvía lo que no cambió. */
  snapshot(desde: { snapshot_version: number; catalog_version: number; security_revision: number; brand_hash?: string | null }): Promise<Snapshot>;
  inbox(cursor: number): Promise<{ events: Array<{ event_uuid: string; origin_device: string; aggregate_type: string; payload: unknown }>; cursor: number }>;
  latido?(info: { pendientes: number; app_version: string; last_seq: number; stats?: MetricasCiclo }): Promise<void>;
}

/** La nube dijo NO a la credencial: la tablet fue dada de baja (o no existe). */
export class ErrorNubeDenegada extends Error {
  code: string;
  constructor(code: string, m: string) { super(m); this.code = code; }
}

export const BACKOFF = { baseMs: 5_000, maxMs: 15 * 60_000 };

/**
 * MODOS DEL CICLO.
 *   rapido    después de vender: solo sube lo pendiente (un viaje, o ninguno
 *             si no hay nada). El catálogo no se toca.
 *   completo  al abrir, al volver la red, con el botón y cuando el último
 *             snapshot tiene más de SNAPSHOT_CADA_MS: sube, baja lo de otras
 *             tablets y pide el snapshot (que solo trae lo que cambió).
 */
export type ModoCiclo = 'rapido' | 'completo';
export const SNAPSHOT_CADA_MS = 5 * 60_000;

/** Lo que tardó el último ciclo, por fase. Se guarda en kv y viaja en el latido. */
export interface MetricasCiclo {
  modo: ModoCiclo;
  total_ms: number;
  subir_ms: number;
  inbox_ms: number;
  snapshot_ms: number;
  enviados: number;
  /** 'sin_cambios' | 'actualizado' | 'no_pedido' */
  catalogo: string;
  error?: string;
}

export function espera(intentos: number, aleatorio: () => number = Math.random): number {
  const exp = Math.min(BACKOFF.maxMs, BACKOFF.baseMs * 2 ** Math.max(0, intentos - 1));
  return Math.round(exp * (0.5 + aleatorio() * 0.5));   // jitter: entre la mitad y el total
}

export interface EstadoSync {
  texto: string;              // lo que ve el cajero
  pendientes: number;
  rechazados: number;
  cuarentena: number;
  ultima_sincronizacion: string | null;
  en_linea: boolean;
  revocado: boolean;
}

export function textoEstado(r: { pendientes: number; rechazados: number; cuarentena: number }, enLinea: boolean, revocado: boolean): string {
  if (revocado) return 'Esta tablet fue dada de baja. Avisa al encargado.';
  if (r.pendientes === 0 && r.rechazados === 0 && r.cuarentena === 0) return enLinea ? 'Todo sincronizado' : 'Sin conexión · todo guardado en la tablet';
  const partes = [];
  if (r.pendientes) partes.push(`${r.pendientes} ${r.pendientes === 1 ? 'operación pendiente' : 'operaciones pendientes'}`);
  if (r.rechazados + r.cuarentena) partes.push(`${r.rechazados + r.cuarentena} en revisión`);
  return (enLinea ? '' : 'Sin conexión · ') + partes.join(' · ');
}

export function crearSincronizador(o: {
  db: BaseLocal; nube: Nube; dispositivo: () => Promise<string>; version: string;
  reloj?: () => Date; aleatorio?: () => number; lote?: number; maxLotes?: number;
  alCambiar?: (e: EstadoSync) => void;
}) {
  const ahora = o.reloj ?? (() => new Date());
  const lote = o.lote ?? 50;
  let enCurso: Promise<EstadoSync> | null = null;
  let enLinea = true;
  let revocado = false;

  const siguiente = (n: number) => new Date(ahora().getTime() + espera(n, o.aleatorio)).toISOString();

  async function estado(): Promise<EstadoSync> {
    const r = await resumen(o.db);
    const kv = await o.db.get<{ v: string }>(`SELECT v FROM kv WHERE k = 'device_status'`);
    revocado = kv?.v === 'REVOKED';
    const e = { ...r, en_linea: enLinea, revocado, texto: textoEstado(r, enLinea, revocado) };
    o.alCambiar?.(e);
    return e;
  }

  const kvNum = async (k: string) => Number((await o.db.get<{ v: string }>('SELECT v FROM kv WHERE k = ?', [k]))?.v ?? 0);
  const ms = () => ahora().getTime();

  async function guardarMetricas(m: MetricasCiclo) {
    await o.db.run(`INSERT INTO kv (k, v) VALUES ('ultimo_ciclo', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
      [JSON.stringify({ ...m, at: ahora().toISOString() })]).catch(() => undefined);
  }

  async function ciclo(forzar: boolean, modoPedido: ModoCiclo): Promise<EstadoSync> {
    const t0 = ms();
    const m: MetricasCiclo = { modo: modoPedido, total_ms: 0, subir_ms: 0, inbox_ms: 0, snapshot_ms: 0, enviados: 0, catalogo: 'no_pedido' };
    // Un ciclo rápido se vuelve completo si el último snapshot ya es viejo.
    const snapAt = Date.parse((await o.db.get<{ v: string }>(`SELECT v FROM kv WHERE k = 'snapshot_at'`))?.v ?? '');
    const modo: ModoCiclo = modoPedido === 'rapido' && Number.isFinite(snapAt) && t0 - snapAt < SNAPSHOT_CADA_MS ? 'rapido' : 'completo';
    m.modo = modo;
    const cerrar = async (e: EstadoSync, error?: string) => {
      m.total_ms = ms() - t0;
      if (error) m.error = error;
      await guardarMetricas(m);
      return e;
    };
    try {
      // 1) Subir lo pendiente, en orden.
      for (let i = 0; i < (o.maxLotes ?? 20); i++) {
        const evs = await pendientes(o.db, lote, forzar ? '9999' : ahora().toISOString());
        if (!evs.length) break;
        let res;
        try {
          res = await o.nube.enviarEventos({ events: evs, device_now: ahora().toISOString(), last_seq: evs[evs.length - 1].local_seq });
        } catch (e) {
          if (e instanceof ErrorNubeDenegada) throw e;
          enLinea = false;
          await reprogramar(o.db, evs.map((x) => x.event_uuid), 'sin conexión', siguiente);
          m.subir_ms = ms() - t0;
          return cerrar(await estado(), 'sin conexión');
        }
        enLinea = true;
        const r = await aplicarResultados(o.db, res.results, ahora().toISOString(), siguiente);
        m.enviados += r.enviados;
        if (r.enviados === 0 && r.rechazados === 0 && r.cuarentena === 0) break;   // nada avanzó: espera al siguiente ciclo
      }
      m.subir_ms = ms() - t0;

      if (modo === 'rapido') {
        if (m.enviados) await marcarSincronizado(o.db, ahora().toISOString());
        return cerrar(await estado());
      }

      // 2) Bajar lo de otras tablets del mismo evento.
      const t1 = ms();
      try {
        const cur = Number((await o.db.get<{ v: string }>(`SELECT v FROM kv WHERE k = 'inbox_cursor'`))?.v ?? 0);
        const ib = await o.nube.inbox(cur);
        if (ib.events.length) await aplicarInbox(o.db, ib.events as never, await o.dispositivo(), ahora().toISOString());
        await o.db.run(`INSERT INTO kv (k, v) VALUES ('inbox_cursor', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, [String(ib.cursor)]);
      } catch (e) { if (e instanceof ErrorNubeDenegada) throw e; enLinea = false; m.inbox_ms = ms() - t1; return cerrar(await estado(), 'sin conexión'); }
      m.inbox_ms = ms() - t1;

      // 3) Maestros nuevos (catálogo, personal, transferencias). La nube solo
      //    manda el catálogo y el personal si cambiaron.
      const t2 = ms();
      try {
        const v = kvNum;
        const marca = (await o.db.get<{ v: string }>(`SELECT v FROM kv WHERE k = 'marca'`))?.v;
        const brand_hash = marca ? (JSON.parse(marca) as { hash?: string }).hash ?? null : null;
        const s = await o.nube.snapshot({ snapshot_version: await v('snapshot_version'), catalog_version: await v('catalog_version'), security_revision: await v('security_revision'), brand_hash });
        const c = await aplicarSnapshot(o.db, s, () => ahora().toISOString());
        m.catalogo = c.catalogo ? 'actualizado' : 'sin_cambios';
      } catch (e) { if (e instanceof ErrorNubeDenegada) throw e; enLinea = false; m.snapshot_ms = ms() - t2; return cerrar(await estado(), 'sin conexión'); }
      m.snapshot_ms = ms() - t2;

      await marcarSincronizado(o.db, ahora().toISOString());
      m.total_ms = ms() - t0;
      try { const r = await resumen(o.db); await o.nube.latido?.({ pendientes: r.pendientes, app_version: o.version, last_seq: 0, stats: m }); } catch { /* el latido es opcional */ }
      return cerrar(await estado());
    } catch (e) {
      if (e instanceof ErrorNubeDenegada) {
        // La tablet ya no obtiene maestros. NO se borra nada local: lo
        // pendiente se queda (la nube clasifica en cuarentena lo posterior).
        await o.db.run(`INSERT INTO kv (k, v) VALUES ('device_status', 'REVOKED') ON CONFLICT (k) DO UPDATE SET v = excluded.v`);
        return cerrar(await estado(), 'tablet dada de baja');
      }
      throw e;
    }
  }

  return {
    /**
     * Una sola ejecución a la vez; si ya hay una, se devuelve esa.
     * `modo` 'rapido' solo sube lo pendiente (después de vender).
     */
    sincronizar(forzar = false, modo: ModoCiclo = 'completo'): Promise<EstadoSync> {
      if (!enCurso) enCurso = ciclo(forzar, modo).finally(() => { enCurso = null; });
      return enCurso;
    },
    /** Lo que tardó el último ciclo (kv 'ultimo_ciclo'). */
    async metricas(): Promise<(MetricasCiclo & { at: string }) | null> {
      const r = await o.db.get<{ v: string }>(`SELECT v FROM kv WHERE k = 'ultimo_ciclo'`).catch(() => null);
      return r ? JSON.parse(r.v) : null;
    },
    estado,
    marcarSinRed() { enLinea = false; return estado(); },
  };
}
