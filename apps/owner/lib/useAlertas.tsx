import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

export interface Alerta {
  id: string;
  sucursal_id: string;
  tipo: 'CORTE' | 'CAJA_FUERA_HORARIO' | 'DIFERENCIA' | 'RIESGO_CAJERO' | 'DEVOLUCIONES' | 'VENTAS_CERO' | string;
  titulo: string;
  mensaje: string;
  leida: boolean;
  created_at: string;
}

export function useAlertas() {
  const [alertas, setAlertas] = useState<Alerta[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    const { data, error: err } = await supabase
      .from('alertas')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (err) { setError(err.message); return; }
    setAlertas((data ?? []) as Alerta[]);
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await cargar();
      setLoading(false);
    })();
  }, [cargar]);

  const refrescar = useCallback(async () => {
    setRefreshing(true);
    await cargar();
    setRefreshing(false);
  }, [cargar]);

  const marcarLeida = useCallback(async (id: string) => {
    setAlertas(prev => prev.map(a => a.id === id ? { ...a, leida: true } : a));
    await supabase.from('alertas').update({ leida: true }).eq('id', id);
  }, []);

  const marcarTodasLeidas = useCallback(async () => {
    const noLeidas = alertas.filter(a => !a.leida).map(a => a.id);
    if (!noLeidas.length) return;
    setAlertas(prev => prev.map(a => ({ ...a, leida: true })));
    await supabase.from('alertas').update({ leida: true }).in('id', noLeidas);
  }, [alertas]);

  const noLeidas = alertas.filter(a => !a.leida).length;

  return { alertas, noLeidas, loading, refreshing, error, refrescar, marcarLeida, marcarTodasLeidas };
}