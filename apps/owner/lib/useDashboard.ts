import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

// Tipos de los datos que lee el tablero (espejo de la nube)
export interface ResumenVentas {
  total: number;
  num_tickets: number;
  ticket_promedio: number;
  total_efectivo: number;
  total_tarjeta: number;
  total_credito: number;
  utilidad: number;
}

export interface CanalVentas {channel:string;name:string;tickets:number;gross:number;discount:number;total:number;refunds:number;net:number}

export interface TopProducto {
  producto: string;
  cantidad: number;
  importe: number;
}

export interface MovimientoCorte {
  tipo: string;
  referencia: string | null;
  monto: number;
  nota: string | null;
  fecha: string | null;
}

export interface Corte {
  closure_id_local: number;
  caja: string | null;
  abierto_at: string | null;
  cerrado_at: string | null;
  esperado: number | null;
  entregado: number | null;
  diferencia: number | null;
  movimientos?: MovimientoCorte[] | null;
}

export interface Sucursal {
  id: string;
  nombre: string;
}

export interface PuntoTendencia {
  fecha: string;
  total: number;
}

// Fecha de HOY en horario LOCAL (no UTC). El POS guarda con fecha local,
// así que usar toISOString() (UTC) desalineaba el día después de las 6pm.
function hoyStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function useDashboard(empresaId: string | null = null) {
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [sucursalId, setSucursalId] = useState<string | null>(null);
  const [resumen, setResumen] = useState<ResumenVentas | null>(null);
  const [canales,setCanales]=useState<CanalVentas[]>([]);
  const [top, setTop] = useState<TopProducto[]>([]);
  const [cortes, setCortes] = useState<Corte[]>([]);
  const [trend, setTrend] = useState<PuntoTendencia[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sucursales de la EMPRESA elegida. RLS ya filtra por membresía; una
  // persona con varias empresas las ve todas, por eso se acota aquí.
  const cargarSucursales = useCallback(async () => {
    let q = supabase.from('sucursales').select('id, nombre').order('nombre');
    if (empresaId) q = q.eq('negocio_id', empresaId);
    const { data, error: err } = await q;
    if (err) { setError(err.message); return; }
    const list = (data ?? []) as Sucursal[];
    setSucursales(list);
    setSucursalId(prev => (prev && list.some(s => s.id === prev) ? prev : list[0]?.id ?? null));
  }, [empresaId]);

  // Carga los datos de una sucursal para hoy
  const cargarDatos = useCallback(async (sid: string) => {
    setError(null);
    const fecha = hoyStr();

    const [rv, tp, cc, tr,cp] = await Promise.all([
      supabase.from('resumen_ventas').select('*').eq('sucursal_id', sid).eq('fecha', fecha).maybeSingle(),
      supabase.from('top_productos').select('producto, cantidad, importe').eq('sucursal_id', sid).eq('fecha', fecha).order('importe', { ascending: false }).limit(10),
      supabase.from('cortes_caja').select('closure_id_local, caja, abierto_at, cerrado_at, esperado, entregado, diferencia, movimientos').eq('sucursal_id', sid).order('abierto_at', { ascending: false }),
      supabase.from('tendencia_ventas').select('fecha, total').eq('sucursal_id', sid).order('fecha', { ascending: true }),
      supabase.rpc('commercial_sales_summary',{p_location:sid})
    ]);

    if (rv.error) setError(rv.error.message);
    setCanales((cp.data?.channels??[]) as CanalVentas[]);
    if(cp.error)setError(cp.error.message);
    setResumen((rv.data as ResumenVentas) ?? null);
    setTop((tp.data as TopProducto[]) ?? []);
    setCortes((cc.data as Corte[]) ?? []);
    setTrend((tr.data as PuntoTendencia[]) ?? []);
  }, []);

  // Primera carga y cada cambio de empresa
  useEffect(() => {
    (async () => {
      setLoading(true);
      await cargarSucursales();
      setLoading(false);
    })();
  }, [cargarSucursales]);

  // Cuando cambia la sucursal, recarga
  useEffect(() => {
    if (!sucursalId) return;
    (async () => {
      setLoading(true);
      await cargarDatos(sucursalId);
      setLoading(false);
    })();
  }, [sucursalId, cargarDatos]);

  // Pull to refresh
  const refrescar = useCallback(async () => {
    if (!sucursalId) return;
    setRefreshing(true);
    await cargarDatos(sucursalId);
    setRefreshing(false);
  }, [sucursalId, cargarDatos]);

  return {
    canales, sucursales, sucursalId, setSucursalId,
    resumen, top, cortes, trend,
    loading, refreshing, error,
    refrescar
  };
}