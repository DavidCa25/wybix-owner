/**
 * AUTORIZACIONES A DISTANCIA: lo que las tablets piden cuando no hay un
 * encargado en la feria. Se aprueba lo que se VE: la nube recibe el hash de
 * esta solicitud y, si cambió, no la acepta. Decidir exige el segundo factor.
 */
import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useEmpresa } from '../lib/useEmpresa';
import { esCodigoMfa, mensajeMfa } from '../lib/mfa';
import { colors, fonts, radius } from '../theme/tokens';

type Aprobacion = {
  id: string; status: string; action: string; etiqueta: string; location: string;
  requested_by: { name?: string; role?: string }; payload: Record<string, unknown>; payload_hash: string;
  expires_at: string; created_at: string; decided_name: string | null; decided_at: string | null;
};
const ESTADO: Record<string, string> = { APPROVED: 'Aprobada', REJECTED: 'Rechazada', CANCELLED: 'Cancelada', EXPIRED: 'Venció', CONSUMED: 'Usada' };
const MENSAJE: Record<string, string> = {
  ALREADY_DECIDED: 'Ya se había respondido (o venció).', PAYLOAD_CHANGED: 'La solicitud cambió. Actualiza la lista.',
  DENIED: 'No tienes permiso para autorizar en esa ubicación.', NOT_FOUND: 'La solicitud ya no existe.',
};

/** El payload en renglones legibles (las llaves vienen de la tablet, en español). */
function renglones(p: Record<string, unknown>): string[] {
  return Object.entries(p).filter(([k]) => !k.endsWith('_uuid') && k !== 'transfer' && k !== 'turno').map(([k, v]) =>
    Array.isArray(v)
      ? `${k}: ${v.map((x) => (typeof x === 'object' && x ? Object.values(x as object).join(' × ') : String(x))).join(', ')}`
      : `${k}: ${String(v)}`);
}

export default function Aprobaciones() {
  const router = useRouter();
  const empresa = useEmpresa();
  const [lista, setLista] = useState<Aprobacion[] | null>(null);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [refrescando, setRefrescando] = useState(false);

  const cargar = useCallback(async () => {
    if (!empresa.empresaId) return;
    const { data, error: e } = await supabase.rpc('owner_aprobaciones', { p_company: empresa.empresaId });
    if (e) { setError('No se pudieron cargar las solicitudes.'); return; }
    setError(''); setLista(data as Aprobacion[]);
  }, [empresa.empresaId]);
  useFocusEffect(useCallback(() => { cargar(); const t = setInterval(cargar, 10000); return () => clearInterval(t); }, [cargar]));

  async function decidir(a: Aprobacion, decision: 'APPROVED' | 'REJECTED') {
    setOcupado(a.id); setError('');
    const { data, error: e } = await supabase.rpc('owner_decidir_aprobacion', { p_id: a.id, p_decision: decision, p_hash: a.payload_hash, p_nota: null });
    setOcupado(null);
    if (e) { setError('No se pudo enviar tu respuesta.'); return; }
    if (!data?.ok) {
      if (esCodigoMfa(data?.code)) { setError(mensajeMfa(data.code)); router.push(data.code === 'MFA_REQUIRED' ? '/mfa/verificar?volver=1' : '/mfa'); return; }
      setError(MENSAJE[data?.code] ?? 'No se pudo enviar tu respuesta.');
    }
    cargar();
  }

  const pendientes = (lista ?? []).filter((a) => a.status === 'PENDING');
  const resueltas = (lista ?? []).filter((a) => a.status !== 'PENDING');

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} style={styles.back} accessibilityRole="button" accessibilityLabel="Volver">
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.hTitle}>Autorizaciones</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refrescando} onRefresh={async () => { setRefrescando(true); await cargar(); setRefrescando(false); }} tintColor={colors.primary} />}>
        {!lista && !error ? <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} /> : null}
        {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
        {lista && !pendientes.length ? <Text style={styles.vacio}>No hay solicitudes pendientes.</Text> : null}
        {pendientes.map((a) => (
          <View key={a.id} style={styles.card} testID={`aprobacion-${a.id}`}>
            <Text style={styles.title}>{a.requested_by?.name ?? 'Alguien'} pide {a.etiqueta}</Text>
            <Text style={styles.sub}>{a.location} · vence a las {new Date(a.expires_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</Text>
            <View style={styles.detalle}>{renglones(a.payload).map((r) => <Text key={r} style={styles.renglon}>{r}</Text>)}</View>
            <View style={styles.acciones}>
              <TouchableOpacity style={[styles.btn, styles.btnNo]} disabled={ocupado === a.id} onPress={() => decidir(a, 'REJECTED')} accessibilityRole="button">
                <Text style={[styles.btnTxt, { color: colors.danger }]}>Rechazar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, styles.btnSi]} disabled={ocupado === a.id} onPress={() => decidir(a, 'APPROVED')} accessibilityRole="button">
                {ocupado === a.id ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnTxt}>Autorizar</Text>}
              </TouchableOpacity>
            </View>
          </View>
        ))}
        {resueltas.length ? <Text style={styles.seccion}>Últimas 24 horas</Text> : null}
        {resueltas.map((a) => (
          <View key={a.id} style={[styles.card, { opacity: 0.8 }]}>
            <Text style={styles.title}>{a.requested_by?.name ?? 'Alguien'}: {a.etiqueta}</Text>
            <Text style={styles.sub}>{a.location} · {ESTADO[a.status] ?? a.status}{a.decided_name ? ` por ${a.decided_name}` : ''}</Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.navy, borderBottomWidth: 1, borderBottomColor: colors.line },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hTitle: { fontFamily: fonts.bold, fontSize: 18, color: '#fff' },
  body: { padding: 16, gap: 12, maxWidth: 560, width: '100%', alignSelf: 'center' },
  error: { fontFamily: fonts.medium, color: colors.danger, fontSize: 13, textAlign: 'center' },
  vacio: { fontFamily: fonts.regular, color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: 24 },
  seccion: { fontFamily: fonts.semibold, color: colors.muted, fontSize: 12, marginTop: 8 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 6, borderWidth: 1, borderColor: colors.line },
  title: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  sub: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.muted },
  detalle: { backgroundColor: colors.navy, borderRadius: radius.sm, padding: 10, gap: 2, marginTop: 4 },
  renglon: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.ink },
  acciones: { flexDirection: 'row', gap: 10, marginTop: 8 },
  btn: { flex: 1, minHeight: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  btnSi: { backgroundColor: colors.primary },
  btnNo: { borderWidth: 1, borderColor: colors.danger },
  btnTxt: { fontFamily: fonts.bold, fontSize: 15, color: '#fff' },
});
