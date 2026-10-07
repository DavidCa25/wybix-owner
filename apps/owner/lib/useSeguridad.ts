import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

export interface RiesgoCajero {
  sucursal_id: string;
  user_id: number;
  cajero: string | null;
  anuladas: number;
  devoluciones: number;
  cajon_sin_venta: number;
  eliminados: number;
  descuentos: number;
  monto_riesgo: number;
  score: number;
  nivel: 'alto' | 'medio' | 'bajo' | string;
  actualizado_at: string | null;
}

// Blindaje: riesgo por cajero (espejo que sincroniza el POS). RLS limita a las sucursales del dueño.
export function useSeguridad() {
  const [riesgo, setRiesgo] = useState<RiesgoCajero[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    const { data, error: err } = await supabase
      .from('seguridad_riesgo')
      .select('*')
      .order('score', { ascending: false });
    if (err) { setError(err.message); return; }
    setRiesgo((data ?? []) as RiesgoCajero[]);
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await cargar(); setLoading(false); })();
  }, [cargar]);

  const refrescar = useCallback(async () => {
    setRefreshing(true); await cargar(); setRefreshing(false);
  }, [cargar]);

  const altos = riesgo.filter(r => r.nivel === 'alto').length;
  return { riesgo, altos, loading, refreshing, error, refrescar };
}
