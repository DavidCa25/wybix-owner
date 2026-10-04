import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

/*
 * FASE 1: User -> Membership -> Company -> Locations.
 *
 * La app ya no supone "un dueño = un negocio". Lee las EMPRESAS a las que la
 * persona pertenece (mis_empresas) y, de la seleccionada, el resumen por
 * ubicación con el total de la empresa (resumen_empresa). Las dos funciones
 * validan la membresía en la base: pedir una empresa ajena devuelve error.
 */

export interface UbicacionResumen {
  location_id: string;
  nombre: string;
  tipo: 'BRANCH' | 'EVENT' | string;
  status: string;
  fecha: string;
  // Fase 2: estado del evento, su sucursal base y cuándo llegó lo último de sus equipos.
  event_status?: 'PLANNED' | 'OPEN' | 'CLOSED' | 'RECONCILED' | null;
  home_location_id?: string | null;
  ultima_sincronizacion?: string | null;
  ventas: { total: number; neto: number; tickets: number; fuente: 'hechos' | 'espejo' | 'sin_datos' };
  turnos_abiertos: { shift_uuid: string; caja: string | null; abierto_at: string | null; abierto_por: string | null; fondo: number | null }[];
  ultimo_corte: {
    caja: string | null; cerrado_at: string | null; esperado: number | null; contado: number | null;
    diferencia: number | null; cerrado_por?: string | null; a_ciegas?: boolean | null;
  } | null;
}

export interface ResumenEmpresa {
  company_id: string;
  ubicaciones: UbicacionResumen[];
  total: { neto: number; tickets: number };
}

export interface Empresa {
  company_id: string;
  nombre: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'VIEWER';
  locations: { id: string; nombre: string; tipo: string; status: string }[];
}

const CLAVE = 'wybix_empresa';

export function useEmpresa() {
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [empresaId, setEmpresaIdState] = useState<string | null>(null);
  const [resumen, setResumen] = useState<ResumenEmpresa | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setEmpresaId = useCallback((id: string) => {
    setEmpresaIdState(id);
    AsyncStorage.setItem(CLAVE, id).catch(() => {});
  }, []);

  const cargarEmpresas = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('mis_empresas');
    if (err) { setError(err.message); return; }
    const lista = (data ?? []) as Empresa[];
    setEmpresas(lista);
    const guardada = await AsyncStorage.getItem(CLAVE).catch(() => null);
    const valida = lista.find(e => e.company_id === guardada)?.company_id ?? lista[0]?.company_id ?? null;
    setEmpresaIdState(valida);
  }, []);

  const cargarResumen = useCallback(async (id: string) => {
    setError(null);
    const { data, error: err } = await supabase.rpc('resumen_empresa', { p_company: id });
    if (err) { setError(err.message); setResumen(null); return; }
    setResumen(data as ResumenEmpresa);
  }, []);

  useEffect(() => {
    (async () => { setCargando(true); await cargarEmpresas(); setCargando(false); })();
  }, [cargarEmpresas]);

  useEffect(() => {
    if (empresaId) cargarResumen(empresaId);
  }, [empresaId, cargarResumen]);

  const refrescar = useCallback(async () => {
    if (empresaId) await cargarResumen(empresaId);
  }, [empresaId, cargarResumen]);

  return { empresas, empresaId, setEmpresaId, resumen, cargando, error, refrescar };
}
