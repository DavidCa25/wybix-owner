import { View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAlertas, Alerta } from '../../lib/useAlertas';
import { colors, fonts, radius } from '../../theme/tokens';

function estiloTipo(tipo: string): { icon: string; color: string; bg: string } {
  switch (tipo) {
    case 'CORTE':              return { icon: '✓', color: colors.success, bg: 'rgba(52,211,153,0.15)' };
    case 'DIFERENCIA':         return { icon: '!', color: colors.danger,  bg: 'rgba(248,113,113,0.15)' };
    case 'CAJA_FUERA_HORARIO': return { icon: '⏰', color: colors.warning, bg: 'rgba(251,191,36,0.15)' };
    case 'RIESGO_CAJERO':      return { icon: '🛡', color: colors.danger,  bg: 'rgba(248,113,113,0.15)' };
    case 'DEVOLUCIONES':       return { icon: '↩', color: colors.warning, bg: 'rgba(251,191,36,0.15)' };
    case 'VENTAS_CERO':        return { icon: '∅', color: colors.warning, bg: 'rgba(251,191,36,0.15)' };
    default:                   return { icon: '•', color: colors.sky,     bg: colors.skySoft };
  }
}

function tiempoRelativo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'Ahora';
  if (min < 60) return `Hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Hace ${h} h`;
  const d = Math.floor(h / 24);
  return `Hace ${d} d`;
}

export default function Alertas() {
  const router = useRouter();
  const { alertas, noLeidas, loading, refreshing, error, refrescar, marcarLeida, marcarTodasLeidas } = useAlertas();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>‹ Volver</Text>
        </TouchableOpacity>
        <Text style={styles.hTitle}>Alertas</Text>
        {noLeidas > 0
          ? <TouchableOpacity onPress={marcarTodasLeidas}><Text style={styles.markAll}>Leer todas</Text></TouchableOpacity>
          : <View style={{ width: 70 }} />}
      </View>

      {loading ? (
        <View style={styles.loader}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refrescar} tintColor={colors.primary} />}
        >
          {error ? <Text style={styles.error}>{error}</Text> : null}

          {alertas.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🔔</Text>
              <Text style={styles.emptyText}>No tienes alertas por ahora.</Text>
            </View>
          ) : (
            alertas.map((a: Alerta) => {
              const est = estiloTipo(a.tipo);
              return (
                <TouchableOpacity
                  key={a.id}
                  style={[styles.card, !a.leida && styles.cardUnread]}
                  onPress={() => !a.leida && marcarLeida(a.id)}
                  activeOpacity={0.7}
                >
                  <View style={[styles.iconBox, { backgroundColor: est.bg }]}>
                    <Text style={[styles.icon, { color: est.color }]}>{est.icon}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.cardTop}>
                      <Text style={styles.cardTitle}>{a.titulo}</Text>
                      {!a.leida && <View style={styles.dot} />}
                    </View>
                    <Text style={styles.cardMsg}>{a.mensaje}</Text>
                    <Text style={styles.cardTime}>{tiempoRelativo(a.created_at)}</Text>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
          <View style={{ height: 30 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.navyDeep, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  back: { fontFamily: fonts.semibold, color: colors.skyLight, fontSize: 14, width: 70 },
  hTitle: { fontFamily: fonts.bold, color: '#fff', fontSize: 18 },
  markAll: { fontFamily: fonts.semibold, color: colors.skyLight, fontSize: 13, width: 70, textAlign: 'right' },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  body: { padding: 16 },
  error: { fontFamily: fonts.medium, color: colors.danger, marginBottom: 12 },

  card: { flexDirection: 'row', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, padding: 14, marginBottom: 10 },
  cardUnread: { borderLeftWidth: 3, borderLeftColor: colors.sky },
  iconBox: { width: 38, height: 38, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  icon: { fontSize: 18, fontFamily: fonts.bold },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { fontFamily: fonts.bold, color: colors.ink, fontSize: 14.5, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.sky },
  cardMsg: { fontFamily: fonts.regular, color: colors.muted, fontSize: 13, marginTop: 3, lineHeight: 18 },
  cardTime: { fontFamily: fonts.regular, color: colors.muted, fontSize: 11.5, marginTop: 6 },

  empty: { alignItems: 'center', paddingTop: 80 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontFamily: fonts.medium, color: colors.muted, fontSize: 14 }
});