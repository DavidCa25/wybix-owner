import { View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useDashboard } from '../../lib/useDashboard';
import { colors, fonts, radius } from '../../theme/tokens';

function money(n: number | null | undefined): string {
  return '$' + Number(n ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fechaHora(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

export default function Cortes() {
  const router = useRouter();
  const { cortes, loading, refreshing, error, refrescar } = useDashboard();

  if (loading) {
    return <View style={styles.loader}><ActivityIndicator size="large" color={colors.primary} /></View>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}><Text style={styles.hTitle}>Cortes de caja</Text></View>
      <ScrollView contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refrescar} tintColor={colors.primary} />}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {cortes.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="cash-outline" size={44} color={colors.line} />
            <Text style={styles.emptyText}>Sin cortes registrados.</Text>
          </View>
        ) : (
          cortes.map((c) => {
            const abierto = !c.cerrado_at;
            const diff = Number(c.diferencia ?? 0);
            return (
              <TouchableOpacity key={c.closure_id_local}
                style={styles.card}
                onPress={() => router.push(`/corte/${c.closure_id_local}`)}
                activeOpacity={0.7}
                disabled={abierto}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.caja}>{c.caja ?? 'Caja'}</Text>
                  <Text style={styles.fecha}>{fechaHora(c.abierto_at)}</Text>
                  <View style={[styles.estadoChip, { backgroundColor: abierto ? '#fef3c7' : '#dcfce7' }]}>
                    <Text style={[styles.estadoText, { color: abierto ? colors.warning : colors.success }]}>
                      {abierto ? 'Abierta' : 'Cerrada'}
                    </Text>
                  </View>
                </View>
                {!abierto && (
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.entregado}>{money(c.entregado)}</Text>
                    <Text style={[styles.diff, { color: diff < 0 ? colors.danger : (diff > 0 ? colors.warning : colors.muted) }]}>
                      {diff === 0 ? 'Cuadrado' : (diff < 0 ? `Faltan ${money(Math.abs(diff))}` : `Sobran ${money(diff)}`)}
                    </Text>
                    <Ionicons name="chevron-forward" size={18} color={colors.muted} style={{ marginTop: 4 }} />
                  </View>
                )}
              </TouchableOpacity>
            );
          })
        )}
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg },
  header: { backgroundColor: colors.navyDeep, paddingHorizontal: 20, paddingVertical: 16 },
  hTitle: { fontFamily: fonts.bold, color: '#fff', fontSize: 20 },
  body: { padding: 16 },
  error: { fontFamily: fonts.medium, color: colors.danger, marginBottom: 12 },
  card: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: radius.md, padding: 16, marginBottom: 10 },
  caja: { fontFamily: fonts.bold, color: colors.ink, fontSize: 15 },
  fecha: { fontFamily: fonts.regular, color: colors.muted, fontSize: 12, marginTop: 2 },
  estadoChip: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, marginTop: 8 },
  estadoText: { fontFamily: fonts.semibold, fontSize: 11 },
  entregado: { fontFamily: fonts.bold, color: colors.ink, fontSize: 16 },
  diff: { fontFamily: fonts.medium, fontSize: 12, marginTop: 2 },
  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontFamily: fonts.medium, color: colors.muted, fontSize: 14 }
});