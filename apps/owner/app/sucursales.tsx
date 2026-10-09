/**
 * SUCURSALES (MultiSucursal): la red de la empresa vista por el dueño.
 *
 *   - Qué sucursal es la MATRIZ (la que administra el catálogo de todas) y
 *     cambiarla. Cambiarla exige el segundo factor, como toda decisión del dueño.
 *   - En qué versión va el catálogo corporativo.
 *   - Los traspasos de mercancía entre sucursales, con su estado.
 *
 * Sin el complemento MultiSucursal se explica qué falta; no se ofrece nada.
 */
import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, RefreshControl, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useEmpresa } from '../lib/useEmpresa';
import { esCodigoMfa, mensajeMfa } from '../lib/mfa';
import { colors, fonts, radius } from '../theme/tokens';

type Estado = {
  multisucursal: boolean; matriz_id: string | null; version: number | null; publicado_en: string | null;
  sucursales: Array<{ id: string; nombre: string; es_matriz: boolean }>;
  traspasos: Array<{ id: string; de: string; a: string; status: string; sent_at: string; lineas: number }>;
};
const ESTADO_TRASPASO: Record<string, string> = { SENT: 'En camino', RECEIVED: 'Recibido', CANCELLED: 'Cancelado' };

export default function Sucursales() {
  const router = useRouter();
  const empresa = useEmpresa();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [refrescando, setRefrescando] = useState(false);

  const cargar = useCallback(async () => {
    if (!empresa.empresaId) return;
    const { data, error: e } = await supabase.rpc('owner_multi_estado', { p_company: empresa.empresaId });
    if (e) { setError('No se pudo cargar la red de sucursales.'); return; }
    setError(''); setEstado(data as Estado);
  }, [empresa.empresaId]);
  useFocusEffect(useCallback(() => { cargar(); }, [cargar]));

  async function hacerMatriz(s: { id: string; nombre: string }) {
    setOcupado(s.id); setError('');
    const { data, error: e } = await supabase.rpc('owner_multi_fijar_matriz', { p_company: empresa.empresaId, p_location: s.id });
    setOcupado(null);
    if (e) { setError('No se pudo cambiar la matriz.'); return; }
    if (!data?.ok) {
      if (esCodigoMfa(data?.code)) { setError(mensajeMfa(data.code)); router.push(data.code === 'MFA_REQUIRED' ? '/mfa/verificar?volver=1' : '/mfa'); return; }
      setError(data?.code === 'DENIED' ? 'Solo el dueño o un administrador cambia la matriz (con su segundo factor).' : 'No se pudo cambiar la matriz.');
      return;
    }
    cargar();
  }

  function confirmar(s: { id: string; nombre: string }) {
    Alert.alert(`¿Hacer matriz a ${s.nombre}?`,
      'Su catálogo se vuelve el de toda la empresa en la próxima sincronización. Las demás sucursales lo reciben y la matriz anterior pasa a ser una sucursal más.',
      [{ text: 'Cancelar', style: 'cancel' }, { text: 'Hacer matriz', onPress: () => hacerMatriz(s) }]);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} style={styles.back} accessibilityRole="button" accessibilityLabel="Volver">
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.hTitle}>Sucursales</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refrescando} onRefresh={async () => { setRefrescando(true); await cargar(); setRefrescando(false); }} tintColor={colors.primary} />}>
        {!estado && !error ? <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} /> : null}
        {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}

        {estado && !estado.multisucursal ? (
          <View style={styles.card}>
            <Text style={styles.title}>Tu licencia no incluye MultiSucursal</Text>
            <Text style={styles.sub}>Con MultiSucursal, la matriz administra el catálogo, los precios y los usuarios de todas tus sucursales, y puedes traspasar mercancía entre ellas.</Text>
          </View>
        ) : null}

        {estado?.multisucursal ? (
          <>
            <View style={styles.card}>
              <Text style={styles.seccionCard}>Catálogo de la empresa</Text>
              <Text style={styles.title}>{estado.version ? `Versión ${estado.version}` : 'La matriz aún no publica'}</Text>
              {estado.publicado_en ? <Text style={styles.sub}>Publicado {new Date(estado.publicado_en).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })}</Text> : null}
            </View>

            <Text style={styles.seccion}>Tus sucursales</Text>
            {estado.sucursales.map((s) => (
              <View key={s.id} style={styles.fila} testID={`sucursal-${s.id}`}>
                <Ionicons name={s.es_matriz ? 'star' : 'storefront-outline'} size={20} color={s.es_matriz ? colors.primary : colors.muted} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.title}>{s.nombre}</Text>
                  <Text style={styles.sub}>{s.es_matriz ? 'Matriz: administra el catálogo de todas' : 'Recibe el catálogo de la matriz'}</Text>
                </View>
                {!s.es_matriz ? (
                  <TouchableOpacity style={styles.btnSec} disabled={!!ocupado} onPress={() => confirmar(s)} accessibilityRole="button" accessibilityLabel={`Hacer matriz a ${s.nombre}`}>
                    {ocupado === s.id ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.btnSecTxt}>Hacer matriz</Text>}
                  </TouchableOpacity>
                ) : null}
              </View>
            ))}

            <Text style={styles.seccion}>Traspasos recientes</Text>
            {!estado.traspasos.length ? <Text style={styles.vacio}>Todavía no hay traspasos entre sucursales.</Text> : null}
            {estado.traspasos.map((t) => (
              <View key={t.id} style={styles.fila}>
                <Ionicons name="swap-horizontal" size={20} color={colors.muted} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.title}>{t.de} → {t.a}</Text>
                  <Text style={styles.sub}>{t.lineas} producto(s) · {new Date(t.sent_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}</Text>
                </View>
                <Text style={[styles.estado, t.status === 'SENT' && { color: colors.primary }, t.status === 'CANCELLED' && { color: colors.muted }]}>
                  {ESTADO_TRASPASO[t.status] ?? t.status}
                </Text>
              </View>
            ))}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.navy, borderBottomWidth: 1, borderBottomColor: colors.line },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hTitle: { fontFamily: fonts.bold, fontSize: 18, color: '#fff' },
  body: { padding: 16, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
  error: { fontFamily: fonts.medium, color: colors.danger, fontSize: 13, textAlign: 'center' },
  vacio: { fontFamily: fonts.regular, color: colors.muted, fontSize: 14 },
  seccion: { fontFamily: fonts.semibold, color: colors.muted, fontSize: 12, marginTop: 10 },
  seccionCard: { fontFamily: fonts.semibold, color: colors.muted, fontSize: 12 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 6, borderWidth: 1, borderColor: colors.line },
  fila: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, padding: 12, borderWidth: 1, borderColor: colors.line },
  title: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  sub: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.muted },
  estado: { fontFamily: fonts.semibold, fontSize: 12.5, color: colors.ink },
  btnSec: { minHeight: 40, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  btnSecTxt: { fontFamily: fonts.semibold, fontSize: 13, color: colors.primary },
});
