import { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { Corte, MovimientoCorte } from '../../lib/useDashboard';
import { colors, fonts, radius } from '../../theme/tokens';

function money(n: number | null | undefined): string {
  return '$' + Number(n ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function etiquetaTipo(tipo: string): { label: string; color: string } {
  switch ((tipo || '').toUpperCase()) {
    case 'OPENING':  return { label: 'Fondo inicial', color: colors.sky };
    case 'SALE':     return { label: 'Venta', color: colors.success };
    case 'WITHDRAW': return { label: 'Retiro', color: colors.danger };
    case 'REFUND':   return { label: 'Reembolso', color: colors.warning };
    case 'SALE_ADJ': return { label: 'Ajuste', color: colors.muted };
    default:         return { label: tipo || 'Movimiento', color: colors.muted };
  }
}

export default function DetalleCorte() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [corte, setCorte] = useState<Corte | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('cortes_caja')
        .select('closure_id_local, caja, abierto_at, cerrado_at, esperado, entregado, diferencia, movimientos, fondo_inicial')
        .eq('closure_id_local', Number(id))
        .maybeSingle();
      setCorte((data as Corte) ?? null);
      setLoading(false);
    })();
  }, [id]);

  if (loading) {
    return <View style={styles.loader}><ActivityIndicator size="large" color={colors.primary} /></View>;
  }

  const movs: MovimientoCorte[] = corte?.movimientos ?? [];
  const diff = Number(corte?.diferencia ?? 0);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.skyLight} />
        </TouchableOpacity>
        <Text style={styles.hTitle}>{corte?.caja ?? 'Corte'}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Resumen */}
        <View style={styles.summary}>
          <View style={styles.sumRow}><Text style={styles.sumLbl}>Esperado</Text><Text style={styles.sumVal}>{money(corte?.esperado)}</Text></View>
          <View style={styles.sumRow}><Text style={styles.sumLbl}>Entregado</Text><Text style={styles.sumVal}>{money(corte?.entregado)}</Text></View>
          <View style={styles.divider} />
          <View style={styles.sumRow}>
            <Text style={styles.sumLblBig}>Diferencia</Text>
            <Text style={[styles.sumValBig, { color: diff < 0 ? colors.danger : (diff > 0 ? colors.warning : colors.success) }]}>
              {diff === 0 ? 'Cuadrado' : money(diff)}
            </Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Movimientos</Text>
        <View style={styles.card}>
          {movs.length === 0 ? (
            <Text style={styles.empty}>Sin movimientos en este corte.</Text>
          ) : (
            movs.map((m, i) => {
              const et = etiquetaTipo(m.tipo);
              const monto = Number(m.monto || 0);
              return (
                <View key={i} style={[styles.movRow, i < movs.length - 1 && styles.rowBorder]}>
                  <View style={[styles.movDot, { backgroundColor: et.color }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.movLabel}>{et.label}</Text>
                    {m.referencia ? <Text style={styles.movRef}>{m.referencia}</Text> : null}
                  </View>
                  <Text style={[styles.movMonto, { color: monto < 0 ? colors.danger : colors.ink }]}>
                    {monto < 0 ? '-' : ''}{money(Math.abs(monto))}
                  </Text>
                </View>
              );
            })
          )}
        </View>
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg },
  header: { backgroundColor: colors.navyDeep, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  backBtn: { width: 40, height: 36, justifyContent: 'center' },
  hTitle: { fontFamily: fonts.bold, color: '#fff', fontSize: 18 },
  body: { padding: 16 },
  summary: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 20 },
  sumRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  sumLbl: { fontFamily: fonts.regular, color: colors.muted, fontSize: 14 },
  sumVal: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 15 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 8 },
  sumLblBig: { fontFamily: fonts.bold, color: colors.ink, fontSize: 15 },
  sumValBig: { fontFamily: fonts.black, fontSize: 18 },
  sectionTitle: { fontFamily: fonts.bold, color: colors.ink, fontSize: 16, marginTop: 20, marginBottom: 10 },
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: 6 },
  empty: { fontFamily: fonts.regular, color: colors.muted, fontSize: 13, textAlign: 'center', padding: 18 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.line },
  movRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 10, gap: 12 },
  movDot: { width: 10, height: 10, borderRadius: 5 },
  movLabel: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 14 },
  movRef: { fontFamily: fonts.regular, color: colors.muted, fontSize: 12, marginTop: 1 },
  movMonto: { fontFamily: fonts.bold, fontSize: 14 }
});