import { useEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl, ActivityIndicator, Platform, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { registerForPush } from '../../lib/push';
import { useDashboard } from '../../lib/useDashboard';
import { useEmpresa } from '../../lib/useEmpresa';
import { ResumenEmpresaCard } from '../../components/ResumenEmpresa';
import { colors, fonts, radius } from '../../theme/tokens';
import { TrendChart } from '../../components/TrendChart';
import { Guide, LogoWybix } from '@wybix/ui';
import { useAlertas } from '../../lib/useAlertas';
import { useSeguridad } from '../../lib/useSeguridad';

function money(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  return '$' + v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Margen aprox. sobre la venta del día (utilidad / ventas)
function margenPct(utilidad: number | null | undefined, total: number | null | undefined): string | null {
  const u = Number(utilidad ?? 0);
  const t = Number(total ?? 0);
  if (t <= 0) return null;
  return (u / t * 100).toFixed(1) + '%';
}

export default function Dashboard() {
  const { signOut } = useAuth();
  const empresa = useEmpresa();
  const { canales, sucursales, sucursalId, setSucursalId, resumen, top, trend, loading, refreshing, error, refrescar: refrescarSucursal } = useDashboard(empresa.empresaId);
  const refrescar = async () => { await Promise.all([refrescarSucursal(), empresa.refrescar()]); };
  const nombreEmpresa = empresa.empresas.find(e => e.company_id === empresa.empresaId)?.nombre;
  const respListener = useRef<Notifications.EventSubscription | null>(null);
  // Lo que espera al dueño: Wybix Guide lo cuenta arriba, como en la caja.
  const { noLeidas } = useAlertas();
  const { altos } = useSeguridad();
  const pendientes = noLeidas + altos;

  useEffect(() => {
    if (Platform.OS === 'web') return;
    registerForPush().catch(() => {});
    // Tocar un aviso abre lo que corresponde (el detalle siempre se lee con permisos, nunca del aviso).
    respListener.current = Notifications.addNotificationResponseReceivedListener((r) => {
      const kind = (r.notification.request.content.data as { kind?: string } | undefined)?.kind;
      if (kind === 'APPROVAL_REQUESTED') router.push('/aprobaciones');
    });
    return () => { respListener.current?.remove(); };
  }, []);

  if (loading || empresa.cargando) {
    return <View style={styles.loader}><ActivityIndicator size="large" color={colors.primary} /></View>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 }}>
          <View style={styles.logo}><LogoWybix size={26} /></View>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.hSub} numberOfLines={1}>{nombreEmpresa ?? 'Wybix Owner'}</Text>
            <Text style={styles.hTitle} accessibilityRole="header" numberOfLines={1}>Tu negocio hoy</Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {/* Sucursales, Aprobaciones y Seguridad viven en «Más» del dock. */}
          <View style={styles.iconBtn}>
            <Ionicons name="log-out-outline" size={21} color={colors.ink} onPress={signOut} accessibilityRole="button" accessibilityLabel="Cerrar sesión" />
          </View>
        </View>
      </View>

      {empresa.empresas.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sucBar} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
          {empresa.empresas.map(e => (
            <Text
              key={e.company_id}
              onPress={() => empresa.setEmpresaId(e.company_id)}
              style={[styles.sucChip, empresa.empresaId === e.company_id && styles.sucChipOn]}
              accessibilityRole="button"
            >{e.nombre}</Text>
          ))}
        </ScrollView>
      )}

      {sucursales.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sucBar} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
          {sucursales.map(s => (
            <Text
              key={s.id}
              onPress={() => setSucursalId(s.id)}
              style={[styles.sucChip, sucursalId === s.id && styles.sucChipOn]}
            >{s.nombre}</Text>
          ))}
        </ScrollView>
      )}

      <ScrollView contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refrescar} tintColor={colors.primary} />}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {empresa.error ? <Text style={styles.error}>{empresa.error}</Text> : null}

        {empresa.resumen && empresa.resumen.ubicaciones.length > 1 && (
          <ResumenEmpresaCard resumen={empresa.resumen} onElegir={setSucursalId} elegida={sucursalId} />
        )}

        {pendientes > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${pendientes} ${pendientes === 1 ? 'cosa te espera' : 'cosas te esperan'}. Ver`}
            onPress={() => router.push(altos > 0 ? '/blindaje' : '/alertas')}
            style={({ pressed }) => [styles.guideCard, pressed && { opacity: 0.85 }]}
          >
            <Guide cara="atencion" size={46} etiqueta={null} />
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={styles.guideTitle}>{pendientes === 1 ? 'Una cosa te espera' : `${pendientes} cosas te esperan`}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {noLeidas > 0 && <Text style={styles.guideChip}>{noLeidas} {noLeidas === 1 ? 'alerta' : 'alertas'}</Text>}
                {altos > 0 && <Text style={[styles.guideChip, styles.guideChipRiesgo]}>{altos} {altos === 1 ? 'cajero en riesgo' : 'cajeros en riesgo'}</Text>}
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
        ) : (
          <View style={styles.guideOk}>
            <Guide cara="reposo" size={34} etiqueta={null} />
            <Text style={styles.guideOkTxt}>Todo en orden: nada te espera.</Text>
          </View>
        )}

        <View style={styles.heroCard}>
          <Text style={styles.heroLabel}>Ventas de hoy</Text>
          <Text style={styles.heroValue}>{money(resumen?.total)}</Text>
          <View style={styles.heroRow}>
            <View style={styles.heroStat}>
              <Text style={styles.heroStatVal}>{resumen?.num_tickets ?? 0}</Text>
              <Text style={styles.heroStatLbl}>Tickets</Text>
            </View>
            <View style={styles.heroDivider} />
            <View style={styles.heroStat}>
              <Text style={styles.heroStatVal}>{money(resumen?.ticket_promedio)}</Text>
              <Text style={styles.heroStatLbl}>Promedio</Text>
            </View>
          </View>
        </View>

        <View style={styles.profitCard}>
          <View style={styles.profitIcon}>
            <Ionicons name="trending-up" size={20} color={colors.success} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.profitLbl}>Utilidad estimada de hoy</Text>
            {margenPct(resumen?.utilidad, resumen?.total)
              ? <Text style={styles.profitSub}>Margen aprox. {margenPct(resumen?.utilidad, resumen?.total)}</Text>
              : <Text style={styles.profitSub}>Ganancia después del costo</Text>}
          </View>
          <Text style={styles.profitVal}>{money(resumen?.utilidad)}</Text>
        </View>

        <View style={styles.payRow}>
          <View style={styles.payCard}><Text style={styles.payLbl}>Efectivo</Text><Text style={styles.payVal}>{money(resumen?.total_efectivo)}</Text></View>
          <View style={styles.payCard}><Text style={styles.payLbl}>Tarjeta</Text><Text style={styles.payVal}>{money(resumen?.total_tarjeta)}</Text></View>
          <View style={styles.payCard}><Text style={styles.payLbl}>Credito</Text><Text style={styles.payVal}>{money(resumen?.total_credito)}</Text></View>
        </View>

        <Text style={styles.sectionTitle}>Ventas por canal</Text><View style={styles.card}><Text style={styles.empty}>Cobrado menos devoluciones, antes de comisiones de plataformas.</Text>{canales.map(c=><View key={c.channel} style={styles.topRow}><View style={{flex:1}}><Text style={styles.topName}>{c.name}</Text><Text style={styles.topQty}>{c.tickets} tickets · Antes de ofertas {money(c.gross)} · Descuentos {money(c.discount)}</Text></View><Text style={styles.topImporte}>{money(c.net)}</Text></View>)}{!canales.length&&<Text style={styles.empty}>Aún no hay ventas sincronizadas hoy.</Text>}</View>
        <Text style={styles.sectionTitle}>Ventas de la semana</Text>
        <View style={styles.card}>
          <TrendChart data={trend} />
        </View>

        <Text style={styles.sectionTitle}>Mas vendidos hoy</Text>
        <View style={styles.card}>
          {top.length === 0 ? <Text style={styles.empty}>Aun no hay ventas hoy.</Text> : top.map((p, i) => (
            <View key={i} style={[styles.topRow, i < top.length - 1 && styles.rowBorder]}>
              <View style={styles.rankBadge}><Text style={styles.rankText}>{i + 1}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.topName} numberOfLines={1}>{p.producto}</Text>
                <Text style={styles.topQty}>{p.cantidad} u.</Text>
              </View>
              <Text style={styles.topImporte}>{money(p.importe)}</Text>
            </View>
          ))}
        </View>
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg },
  logo: { width: 42, height: 42, borderRadius: 14, backgroundColor: colors.navy, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  guideCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: 'rgba(251,191,36,0.35)', borderRadius: radius.lg, padding: 12, marginBottom: 12 },
  guideTitle: { fontFamily: fonts.bold, color: colors.ink, fontSize: 15 },
  guideChip: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 12, backgroundColor: colors.selected, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, overflow: 'hidden' },
  guideChipRiesgo: { color: colors.danger, backgroundColor: 'rgba(240,85,91,0.16)' },
  guideOk: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12, paddingHorizontal: 4 },
  guideOkTxt: { fontFamily: fonts.medium, color: colors.muted, fontSize: 13 },
  header: { backgroundColor: colors.navyDeep, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 18, paddingTop: 10 },
  hTitle: { fontFamily: fonts.bold, color: colors.ink, fontSize: 24, letterSpacing: -0.6 },
  hSub: { fontFamily: fonts.medium, color: colors.muted, fontSize: 12.5 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, justifyContent: 'center', alignItems: 'center' },
  sucBar: { backgroundColor: colors.navyDeep, paddingBottom: 12, maxHeight: 48 },
  sucChip: { fontFamily: fonts.medium, color: colors.muted, fontSize: 12.5, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, overflow: 'hidden' },
  sucChipOn: { backgroundColor: colors.selected, borderColor: colors.lineStrong, color: colors.ink, fontFamily: fonts.semibold },
  body: { padding: 16 },
  error: { fontFamily: fonts.medium, color: colors.danger, marginBottom: 12 },
  heroCard: { backgroundColor: colors.hero, borderRadius: radius.lg, padding: 20, marginBottom: 12 },
  heroLabel: { fontFamily: fonts.medium, color: '#B7D3E6', fontSize: 13 },
  heroValue: { fontFamily: fonts.mono, color: colors.ink, fontSize: 36, letterSpacing: -1, marginTop: 4 },
  heroRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16 },
  heroStat: { flex: 1 },
  heroStatVal: { fontFamily: fonts.mono, color: colors.ink, fontSize: 17 },
  heroStatLbl: { fontFamily: fonts.regular, color: '#B7D3E6', fontSize: 12, marginTop: 2 },
  heroDivider: { width: 1, height: 34, backgroundColor: 'rgba(255,255,255,0.15)', marginHorizontal: 16 },
  profitCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: colors.line },
  profitIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: 'rgba(52,211,153,0.15)', justifyContent: 'center', alignItems: 'center' },
  profitLbl: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 13.5 },
  profitSub: { fontFamily: fonts.regular, color: colors.muted, fontSize: 11.5, marginTop: 2 },
  profitVal: { fontFamily: fonts.mono, color: colors.success, fontSize: 19 },
  payRow: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  payCard: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.line },
  payLbl: { fontFamily: fonts.medium, color: colors.muted, fontSize: 11.5 },
  payVal: { fontFamily: fonts.mono, color: colors.ink, fontSize: 14, marginTop: 4 },
  sectionTitle: { fontFamily: fonts.bold, color: colors.ink, fontSize: 16, marginTop: 20, marginBottom: 10 },
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: 6, borderWidth: 1, borderColor: colors.line },
  empty: { fontFamily: fonts.regular, color: colors.muted, fontSize: 13, textAlign: 'center', padding: 18 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.line },
  topRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 10, gap: 12 },
  rankBadge: { width: 26, height: 26, borderRadius: 8, backgroundColor: colors.skySoft, justifyContent: 'center', alignItems: 'center' },
  rankText: { fontFamily: fonts.bold, color: colors.sky, fontSize: 13 },
  topName: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 14 },
  topQty: { fontFamily: fonts.regular, color: colors.muted, fontSize: 12, marginTop: 1 },
  topImporte: { fontFamily: fonts.mono, color: colors.ink, fontSize: 14 }
});