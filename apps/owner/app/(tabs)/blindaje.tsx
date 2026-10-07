import { View, Text, ScrollView, RefreshControl, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useSeguridad, RiesgoCajero } from '../../lib/useSeguridad';
import { colors, fonts, radius, spacing } from '../../theme/tokens';

function nivelColor(n: string) { return n === 'alto' ? colors.danger : n === 'medio' ? colors.warning : colors.success; }
function nivelTxt(n: string) { return n === 'alto' ? 'ALTO' : n === 'medio' ? 'MEDIO' : 'BAJO'; }
const money = (n: number) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricVal}>{value}</Text>
      <Text style={styles.metricLbl}>{label}</Text>
    </View>
  );
}

function Card({ c }: { c: RiesgoCajero }) {
  const col = nivelColor(c.nivel);
  return (
    <View style={[styles.card, { borderLeftColor: col }]}>
      <View style={styles.cardHead}>
        <View style={{ flexShrink: 1 }}>
          <Text style={styles.cajero}>{c.cajero || 'Cajero'}</Text>
          {c.monto_riesgo > 0 && <Text style={styles.monto}>En riesgo: {money(c.monto_riesgo)}</Text>}
        </View>
        <View style={[styles.pill, { backgroundColor: col }]}>
          <Text style={styles.pillTxt}>{nivelTxt(c.nivel)} · {c.score}</Text>
        </View>
      </View>
      <View style={styles.metrics}>
        <Metric label="Anuladas" value={c.anuladas} />
        <Metric label="Devol." value={c.devoluciones} />
        <Metric label="Cajón s/venta" value={c.cajon_sin_venta} />
        <Metric label="Descuentos" value={c.descuentos} />
      </View>
    </View>
  );
}

export default function Blindaje() {
  const { riesgo, altos, loading, refreshing, error, refrescar } = useSeguridad();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headIcon}><Ionicons name="shield-checkmark" size={20} color={colors.white} /></View>
        <View>
          <Text style={styles.title}>Blindaje</Text>
          <Text style={styles.sub}>Riesgo por cajero · anti robo hormiga</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.md, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refrescar} tintColor={colors.primary} />}
      >
        {altos > 0 && (
          <View style={styles.banner}>
            <Ionicons name="warning" size={18} color={colors.danger} />
            <Text style={styles.bannerTxt}>{altos} {altos === 1 ? 'cajero' : 'cajeros'} con riesgo alto. Revísalo.</Text>
          </View>
        )}

        {loading ? (
          <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 40 }} />
        ) : error ? (
          <Text style={styles.empty}>No se pudo cargar. Desliza para reintentar.</Text>
        ) : riesgo.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="checkmark-circle" size={40} color={colors.success} />
            <Text style={styles.emptyTitle}>Todo en orden</Text>
            <Text style={styles.empty}>Sin actividad de riesgo registrada.</Text>
          </View>
        ) : (
          riesgo.map((c) => <Card key={`${c.sucursal_id}-${c.user_id}`} c={c} />)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md, backgroundColor: colors.card, borderBottomColor: colors.line, borderBottomWidth: 1 },
  headIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.navy, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fonts.bold, fontSize: 20, color: colors.ink },
  sub: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(248,113,113,0.12)', borderColor: 'rgba(248,113,113,0.35)', borderWidth: 1, borderRadius: radius.md, padding: 12, marginBottom: spacing.md },
  bannerTxt: { fontFamily: fonts.medium, fontSize: 13, color: colors.danger, flexShrink: 1 },
  card: { backgroundColor: colors.card, borderRadius: radius.md, borderLeftWidth: 4, padding: spacing.md, marginBottom: spacing.sm, shadowColor: '#0f172a', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12 },
  cajero: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  monto: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, marginTop: 2 },
  pill: { borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 5 },
  pillTxt: { fontFamily: fonts.bold, fontSize: 12, color: colors.white },
  metrics: { flexDirection: 'row', justifyContent: 'space-between', borderTopColor: colors.line, borderTopWidth: 1, paddingTop: 10 },
  metric: { alignItems: 'center', flex: 1 },
  metricVal: { fontFamily: fonts.bold, fontSize: 17, color: colors.ink },
  metricLbl: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.muted, marginTop: 2, textAlign: 'center' },
  emptyBox: { alignItems: 'center', marginTop: 50, gap: 6 },
  emptyTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  empty: { fontFamily: fonts.regular, fontSize: 13, color: colors.muted, textAlign: 'center' },
});
