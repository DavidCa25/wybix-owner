import { View, Text, StyleSheet } from 'react-native';
import { colors, fonts } from '../theme/tokens';

interface Punto { fecha: string; total: number; }

// Grafica de barras simple, sin librerias. Cada barra = un dia.
export function TrendChart({ data }: { data: Punto[] }) {
  if (!data || data.length === 0) {
    return <Text style={styles.empty}>Sin datos de la semana.</Text>;
  }

  const max = Math.max(...data.map(d => Number(d.total) || 0), 1);
  const dias = ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa'];

  return (
    <View style={styles.wrap}>
      <View style={styles.bars}>
        {data.map((d, i) => {
          const val = Number(d.total) || 0;
          const h = Math.max(4, (val / max) * 110);
          const dow = new Date(d.fecha).getDay();
          const esHoy = i === data.length - 1;
          return (
            <View key={i} style={styles.col}>
              <View style={styles.barArea}>
                <View style={[styles.bar, { height: h, backgroundColor: esHoy ? colors.primary : colors.sky }]} />
              </View>
              <Text style={[styles.day, esHoy && styles.dayOn]}>{dias[dow]}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 12 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 140 },
  col: { flex: 1, alignItems: 'center' },
  barArea: { height: 110, justifyContent: 'flex-end' },
  bar: { width: 22, borderRadius: 6 },
  day: { fontFamily: fonts.medium, color: colors.muted, fontSize: 11, marginTop: 8 },
  dayOn: { fontFamily: fonts.bold, color: colors.primary },
  empty: { fontFamily: fonts.regular, color: colors.muted, fontSize: 13, textAlign: 'center', padding: 18 }
});