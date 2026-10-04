/**
 * ESTADO DE LA APP: base cifrada abierta, quién está en la caja y la sincronización.
 *
 * La sincronización corre: al abrir, al recuperar la red, cada minuto mientras
 * la app está al frente y con el botón. La tarea en segundo plano (lib/fondo)
 * es una mejora: nada depende de ella.
 *
 * La persona identificada vive SOLO en memoria: cerrar la app la saca (el
 * turno y las ventas, en cambio, viven en la base y sobreviven a todo).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import { crearPos, guardarEnrolamiento, guardarDesfase, desfaseGuardado, type BaseLocal, type Identidad, type Persona, type PosLocal } from '@wybix/database';
import { crearSincronizador, type EstadoSync } from '@wybix/sync';
import { crearClienteNube, type EstadoAprobacion } from '@wybix/api';
import { abrirBase } from './base';
import { CONFIG, cumpleVersion } from './config';
import { credencial, deviceUuid } from './llaves';
import { registrarFondo } from './fondo';
import { impresoraSistema, impresoraRed, sinImpresora, type Impresora } from './impresion';

type Fase = 'cargando' | 'sin_enrolar' | 'listo' | 'error';

interface Ctx {
  fase: Fase; error: string | null;
  db: BaseLocal | null; pos: PosLocal | null; identidad: Identidad | null;
  sync: EstadoSync; sincronizar(): Promise<void>;
  persona: Persona | null; entrar(p: Persona): void; salir(): void;
  enrolar(codigo: string): Promise<void>;
  versionOk: boolean; minima: string | null;
  /** Desfase del reloj de la tablet contra Wybix, en minutos (null = aún no medido). */
  desfaseMin: number | null;
  impresora: Impresora; configurarImpresora(c: { tipo: 'red' | 'sistema' | 'ninguna'; host?: string }, autorizador?: Persona | null): Promise<void>;
  recargar(): Promise<void>;
  /** Fase 3: autorización a distancia (por la credencial de esta tablet). Sin red, lanza error. */
  aprobaciones: {
    solicitar(a: { id: string; accion: string; solicita: { uuid: string; name: string; role: string }; payload: Record<string, unknown> }): Promise<EstadoAprobacion>;
    estado(id: string): Promise<EstadoAprobacion>;
    consumir(id: string, payload: Record<string, unknown>): Promise<EstadoAprobacion>;
    cancelar(id: string): Promise<EstadoAprobacion>;
  };
}

const C = createContext<Ctx | null>(null);
export const usePos = () => { const c = useContext(C); if (!c) throw new Error('Sin contexto POS'); return c; };

/*
 * Operaciones que dejan algo en el outbox. Después de cada una se intenta
 * sincronizar (con 1 s de antirrebote): con red, el hecho sube enseguida; sin
 * red, el estado se recalcula y la pantalla muestra los pendientes reales.
 */
const ESCRIBEN = new Set(['abrirTurno', 'registrarVenta', 'registrarMerma', 'registrarAjuste', 'movimientoCaja', 'cerrarTurno', 'recibirTransferencia', 'regresarSobrante']);
function conAviso(p: PosLocal, avisar: () => void): PosLocal {
  return new Proxy(p, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (typeof v !== 'function' || !ESCRIBEN.has(String(k))) return v;
      return async (...a: unknown[]) => { const salida = await v.apply(t, a); avisar(); return salida; };
    },
  });
}

const syncInicial: EstadoSync = { texto: 'Cargando…', pendientes: 0, rechazados: 0, cuarentena: 0, ultima_sincronizacion: null, en_linea: true, revocado: false };

export function PosProvider({ children }: { children: ReactNode }) {
  const [fase, setFase] = useState<Fase>('cargando');
  const [error, setError] = useState<string | null>(null);
  const [db, setDb] = useState<BaseLocal | null>(null);
  const [pos, setPos] = useState<PosLocal | null>(null);
  const [identidad, setIdentidad] = useState<Identidad | null>(null);
  const [sync, setSync] = useState<EstadoSync>(syncInicial);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [minima, setMinima] = useState<string | null>(null);
  const [desfaseMin, setDesfaseMin] = useState<number | null>(null);
  const [impresora, setImpresora] = useState<Impresora>(sinImpresora);
  const motor = useRef<ReturnType<typeof crearSincronizador> | null>(null);
  const nubeRef = useRef<ReturnType<typeof crearClienteNube> | null>(null);
  const aviso = useRef<{ t: ReturnType<typeof setTimeout> | null; sincronizar: () => void }>({ t: null, sincronizar: () => {} });
  const avisar = useCallback(() => {
    if (aviso.current.t) clearTimeout(aviso.current.t);
    aviso.current.t = setTimeout(() => { aviso.current.t = null; aviso.current.sincronizar(); }, 1000);
  }, []);

  const leerEstado = useCallback(async (d: BaseLocal, p: PosLocal) => {
    try { setIdentidad(await p.identidad()); } catch { setIdentidad(null); }
    const rel = await d.get<{ v: string }>(`SELECT v FROM kv WHERE k = 'releases'`);
    setMinima(rel ? JSON.parse(rel.v)?.min_supported_version ?? null : null);
    const df = await desfaseGuardado(d).catch(() => null);
    setDesfaseMin(df ? Math.round(df.ms / 60000) : null);
    const imp = await d.get<{ v: string }>(`SELECT v FROM kv WHERE k = 'impresora'`);
    if (imp) {
      const c = JSON.parse(imp.v);
      setImpresora(c.tipo === 'red' && c.host ? impresoraRed(c.host) : c.tipo === 'ninguna' ? sinImpresora : impresoraSistema);
    }
  }, []);

  const armarMotor = useCallback((d: BaseLocal, p: PosLocal) => {
    const nube = crearClienteNube({
      base: CONFIG.backend, anonKey: CONFIG.anonKey, version: CONFIG.version, credencial: credencial.leer,
      identidad: async () => { try { const i = await p.identidad(); return { company_uuid: i.company_uuid, location_uuid: i.location_uuid }; } catch { return null; } },
    });
    motor.current = crearSincronizador({ db: d, nube, dispositivo: deviceUuid, version: CONFIG.version, alCambiar: setSync });
    nubeRef.current = nube;
    return nube;
  }, []);

  const sincronizar = useCallback(async () => {
    if (!motor.current || !db || !pos) return;
    // Sin red: el estado se recalcula desde la base (no se pierde el conteo de pendientes).
    try { await motor.current.sincronizar(true); } catch { await motor.current.marcarSinRed().catch(() => undefined); }
    // El desfase medido en esta sincronización se guarda: la fecha de negocio lo usa también sin red.
    const d = nubeRef.current?.desfase();
    if (d) await guardarDesfase(db, d.ms, d.at).catch(() => undefined);
    await leerEstado(db, pos);
  }, [db, pos, leerEstado]);

  const recargar = useCallback(async () => {
    try {
      const { db: d } = await abrirBase();
      const p = conAviso(crearPos(d), avisar);
      setDb(d); setPos(p);
      if (!(await credencial.leer())) { setFase('sin_enrolar'); return; }
      armarMotor(d, p);
      await leerEstado(d, p);
      setSync(await motor.current!.estado());
      setFase('listo');
    } catch (e) {
      setError((e as Error).message);
      setFase('error');
    }
  }, [armarMotor, leerEstado, avisar]);

  useEffect(() => { recargar(); }, [recargar]);
  useEffect(() => { aviso.current.sincronizar = () => { sincronizar(); }; }, [sincronizar]);

  // Abrir, red recuperada, cada minuto al frente.
  useEffect(() => {
    if (fase !== 'listo') return;
    registrarFondo().catch(() => undefined);
    sincronizar();
    const red = Network.addNetworkStateListener((s) => { if (s.isInternetReachable) sincronizar(); else motor.current?.marcarSinRed(); });
    let activa = AppState.currentState === 'active';
    const app = AppState.addEventListener('change', (s) => { activa = s === 'active'; if (activa) sincronizar(); });
    const t = setInterval(() => { if (activa) sincronizar(); }, 60_000);
    return () => { red.remove(); app.remove(); clearInterval(t); };
  }, [fase, sincronizar]);

  const enrolar = useCallback(async (codigo: string) => {
    if (!db || !pos) throw new Error('La base no está lista.');
    const dev = await deviceUuid();
    const nube = armarMotor(db, pos) as ReturnType<typeof crearClienteNube>;
    const r = await nube.enrolar(codigo, dev);
    await credencial.guardar(r.token);
    await guardarEnrolamiento(db, { device_uuid: dev, device_id: r.device_id });
    await motor.current!.sincronizar(true);    // snapshot inicial
    await leerEstado(db, pos);
    await registrarFondo().catch(() => undefined);
    setFase('listo');
  }, [db, pos, armarMotor, leerEstado]);

  const configurarImpresora = useCallback(async (c: { tipo: 'red' | 'sistema' | 'ninguna'; host?: string }, autorizador?: Persona | null) => {
    if (!pos || !persona) throw new Error('Entra con tu PIN para configurar la impresora.');
    await pos.configurarImpresora(persona, c, autorizador);
    setImpresora(c.tipo === 'red' && c.host ? impresoraRed(c.host) : c.tipo === 'ninguna' ? sinImpresora : impresoraSistema);
  }, [pos, persona]);

  const aprobaciones = useMemo<Ctx['aprobaciones']>(() => {
    const n = () => { if (!nubeRef.current) throw new Error('La tablet no está enrolada.'); return nubeRef.current.aprobaciones; };
    return {
      solicitar: (a) => n().solicitar(a), estado: (id) => n().estado(id),
      consumir: (id, payload) => n().consumir(id, payload), cancelar: (id) => n().cancelar(id),
    };
  }, []);

  const valor = useMemo<Ctx>(() => ({
    fase, error, db, pos, identidad, sync, sincronizar, persona,
    entrar: setPersona, salir: () => setPersona(null), enrolar,
    versionOk: cumpleVersion(CONFIG.version, minima), minima, desfaseMin, impresora, configurarImpresora, recargar, aprobaciones,
  }), [fase, error, db, pos, identidad, sync, sincronizar, persona, enrolar, minima, desfaseMin, impresora, configurarImpresora, recargar, aprobaciones]);

  return <C.Provider value={valor}>{children}</C.Provider>;
}
