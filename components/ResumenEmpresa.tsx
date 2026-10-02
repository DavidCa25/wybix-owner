import { View, Text, StyleSheet, Pressable } from 'react-native';
import { colors, fonts, radius } from '../theme/tokens';
import type { ResumenEmpresa } from '../lib/useEmpresa';

/*
 * La empresa de un vistazo (Fase 1): una fila por ubicación con las ventas de
 * hoy y su caja (turno abierto o último corte), y el total de la empresa.
 * Tocar una ubicación la abre en el detalle de abajo.
 */
function money(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  return '$' + v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function hora(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

export function ResumenEmpresaCard({ resumen, onElegir, elegida }: {
  resumen: ResumenEmpresa; onElegir: (id: string) => void; elegida: string | null;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.totalRow}>
        <Text style={styles.totalLbl}>Total de la empresa</Text>
        <Text style={styles.totalVal}>{money(resumen.total.neto)}</Text>
      </View>
      <Text style={styles.totalSub}>{resumen.total.tickets} tickets en {resumen.ubicaciones.length} ubicaciones</Text>

      {resumen.ubicaciones.map((u, i) => {
        const abierto = u.turnos_abiertos?.[0];
        const corte = u.ultimo_corte;
        const caja = abierto
          ? `Caja abierta${abierto.caja ? ` · ${abierto.caja}` : ''} desde ${hora(abierto.abierto_at)}`
          : corte
            ? `Último corte ${hora(corte.cerrado_at)}${corte.diferencia != null ? ` · dif. ${money(corte.diferencia)}` : ''}`
            : 'Sin cortes todavía';
        return (
          <Pressable key={u.location_id} onPress={() => onElegir(u.location_id)} accessibilityRole="button"
            style={[styles.row, i > 0 && styles.rowBorder, elegida === u.location_id && styles.rowOn]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.nombre} numberOfLines={1}>
                {u.nombre}{u.tipo === 'EVENT' ? '  · evento' : ''}{u.status === 'PENDING' ? '  · pendiente' : ''}
              </Text>
              <Text style={[styles.caja, corte?.diferencia != null && Number(corte.diferencia) < 0 && !abierto && styles.cajaMal]} numberOfLines={1}>
                {caja}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.venta}>{money(u.ventas.neto)}</Text>
              <Text style={styles.tickets}>{u.ventas.tickets} tickets</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: 16, marginBottom: 12 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  totalLbl: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 14 },
  totalVal: { fontFamily: fonts.black, color: colors.ink, fontSize: 22 },
  totalSub: { fontFamily: fonts.regular, color: colors.muted, fontSize: 12, marginTop: 2, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 6, borderRadius: radius.sm },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.line },
  rowOn: { backgroundColor: colors.skySoft },
  nombre: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 14 },
  caja: { fontFamily: fonts.regular, color: colors.muted, fontSize: 12, marginTop: 2 },
  cajaMal: { color: colors.warning },
  venta: { fontFamily: fonts.bold, color: colors.ink, fontSize: 14 },
  tickets: { fontFamily: fonts.regular, color: colors.muted, fontSize: 11.5, marginTop: 1 },
});
