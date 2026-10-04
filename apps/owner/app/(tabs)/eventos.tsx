import { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useEmpresa, type UbicacionResumen } from '../../lib/useEmpresa';
import { eventos, mensaje, haceCuanto, ETIQUETA_ESTADO, type EstadoEvento } from '../../lib/useEventos';
import { colors, fonts, radius } from '../../theme/tokens';

/*
 * EVENTOS (Fase 2). Una feria es una ubicación temporal con sucursal base:
 * de ahí salen su catálogo, su personal y su mercancía. Aquí la dueña ve sus
 * eventos con estado y la última vez que llegó algo de sus tablets, y crea uno
 * nuevo. Los permisos y el cupo los decide la base (owner_crear_evento).
 */
const COLOR_ESTADO: Record<EstadoEvento, string> = {
  PLANNED: colors.sky,
  OPEN: colors.success,
  CLOSED: colors.warning,
  RECONCILED: colors.muted,
};

function money(n: number | null | undefined): string {
  return '$' + Number(n ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function Eventos() {
  const router = useRouter();
  const empresa = useEmpresa();
  const [refrescando, setRefrescando] = useState(false);
  const [creando, setCreando] = useState(false);
  const [nombre, setNombre] = useState('');
  const [base, setBase] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => { empresa.refrescar(); }, [empresa.refrescar]));

  const ubicaciones = empresa.resumen?.ubicaciones ?? [];
  const sucursales = ubicaciones.filter((u) => u.tipo === 'BRANCH');
  const lista = ubicaciones.filter((u) => u.tipo === 'EVENT');
  const rol = empresa.empresas.find((e) => e.company_id === empresa.empresaId)?.role;
  const administra = rol === 'OWNER' || rol === 'ADMIN';
  const nombreDe = (id: string | null | undefined) => sucursales.find((s) => s.location_id === id)?.nombre ?? '—';

  const refrescar = async () => { setRefrescando(true); await empresa.refrescar(); setRefrescando(false); };

  const crear = async () => {
    if (!empresa.empresaId || !nombre.trim() || !base) return;
    setGuardando(true); setError(null);
    const r = await eventos.crear(empresa.empresaId, { nombre: nombre.trim(), home_location_id: base });
    setGuardando(false);
    if (!r.ok) { setError(mensaje(r.code)); return; }
    setCreando(false); setNombre(''); setBase(null);
    await empresa.refrescar();
    router.push({ pathname: '/evento/[id]', params: { id: String(r.location_id), empresa: empresa.empresaId } });
  };

  if (empresa.cargando) {
    return <View style={styles.loader}><ActivityIndicator size="large" color={colors.primary} /></View>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.hTitle}>Eventos</Text>
          <Text style={styles.hSub}>Ferias y ubicaciones temporales</Text>
        </View>
        {administra && !creando && (
          <Pressable onPress={() => { setCreando(true); setBase(sucursales[0]?.location_id ?? null); }} style={styles.nuevo}
            accessibilityRole="button" accessibilityLabel="Nuevo evento">
            <Ionicons name="add" size={18} color="#fff" />
            <Text style={styles.nuevoTxt}>Nuevo</Text>
          </Pressable>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refrescando} onRefresh={refrescar} tintColor={colors.primary} />}>
        {empresa.error ? <Text style={styles.error}>{empresa.error}</Text> : null}

        {creando && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Nuevo evento</Text>
            <Text style={styles.lbl}>Nombre</Text>
            <TextInput value={nombre} onChangeText={setNombre} placeholder="Feria León 2026" placeholderTextColor={colors.muted}
              style={styles.input} maxLength={120} />
            <Text style={styles.lbl}>Sucursal base</Text>
            <Text style={styles.ayuda}>De ella salen el catálogo, el personal y la mercancía de la feria.</Text>
            <View style={styles.chips}>
              {sucursales.map((s) => (
                <Pressable key={s.location_id} onPress={() => setBase(s.location_id)} accessibilityRole="radio"
                  accessibilityState={{ selected: base === s.location_id }}
                  style={[styles.chip, base === s.location_id && styles.chipOn]}>
                  <Text style={[styles.chipTxt, base === s.location_id && styles.chipTxtOn]}>{s.nombre}</Text>
                </Pressable>
              ))}
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.fila}>
              <Pressable onPress={() => { setCreando(false); setError(null); }} style={[styles.btn, styles.btnSec]}>
                <Text style={styles.btnSecTxt}>Cancelar</Text>
              </Pressable>
              <Pressable onPress={crear} disabled={guardando || !nombre.trim() || !base}
                style={[styles.btn, styles.btnPri, (guardando || !nombre.trim() || !base) && styles.btnOff]}>
                <Text style={styles.btnPriTxt}>{guardando ? 'Creando…' : 'Crear evento'}</Text>
              </Pressable>
            </View>
          </View>
        )}

        {lista.length === 0 && !creando ? (
          <View style={styles.vacio}>
            <Ionicons name="storefront-outline" size={34} color={colors.muted} />
            <Text style={styles.vacioTit}>Sin eventos todavía</Text>
            <Text style={styles.vacioTxt}>
              Crea una feria para vender con una tablet sin depender de Internet. Su mercancía sale de la sucursal base y regresa a ella al terminar.
            </Text>
          </View>
        ) : (
          lista.map((u: UbicacionResumen) => {
            const est = (u.event_status ?? 'PLANNED') as EstadoEvento;
            return (
              <Pressable key={u.location_id} style={styles.evento} accessibilityRole="button"
                onPress={() => router.push({ pathname: '/evento/[id]', params: { id: u.location_id, empresa: empresa.empresaId ?? '' } })}>
                <View style={{ flex: 1 }}>
                  <View style={styles.filaCentro}>
                    <Text style={styles.eNombre} numberOfLines={1}>{u.nombre}</Text>
                    <Text style={[styles.estado, { color: COLOR_ESTADO[est], borderColor: COLOR_ESTADO[est] }]}>{ETIQUETA_ESTADO[est]}</Text>
                  </View>
                  <Text style={styles.eSub} numberOfLines={1}>Base: {nombreDe(u.home_location_id)}</Text>
                  <Text style={styles.eSub} numberOfLines={1}>Última sincronización: {haceCuanto(u.ultima_sincronizacion)}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.eVenta}>{money(u.ventas.neto)}</Text>
                  <Text style={styles.eSub}>{u.ventas.tickets} tickets hoy</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.muted} />
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg },
  header: { backgroundColor: colors.navyDeep, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 18, paddingTop: 10 },
  hTitle: { fontFamily: fonts.bold, color: '#fff', fontSize: 22, letterSpacing: 0.3 },
  hSub: { fontFamily: fonts.regular, color: colors.skyLight, fontSize: 12.5, marginTop: 1 },
  nuevo: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill },
  nuevoTxt: { fontFamily: fonts.semibold, color: '#fff', fontSize: 13 },
  body: { padding: 16, gap: 10 },
  error: { fontFamily: fonts.medium, color: colors.danger, fontSize: 13, marginTop: 8 },
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: 16 },
  cardTitle: { fontFamily: fonts.bold, color: colors.ink, fontSize: 16, marginBottom: 8 },
  lbl: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 13, marginTop: 10, marginBottom: 6 },
  ayuda: { fontFamily: fonts.regular, color: colors.muted, fontSize: 12, marginBottom: 8 },
  input: { fontFamily: fonts.regular, color: colors.ink, fontSize: 15, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.bg },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 7 },
  chipOn: { backgroundColor: colors.sky, borderColor: colors.sky },
  chipTxt: { fontFamily: fonts.medium, color: colors.ink, fontSize: 13 },
  chipTxtOn: { color: '#fff' },
  fila: { flexDirection: 'row', gap: 10, marginTop: 16 },
  filaCentro: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btn: { flex: 1, borderRadius: radius.sm, paddingVertical: 12, alignItems: 'center' },
  btnPri: { backgroundColor: colors.primary },
  btnPriTxt: { fontFamily: fonts.semibold, color: '#fff', fontSize: 14 },
  btnSec: { backgroundColor: 'rgba(255,255,255,0.06)' },
  btnSecTxt: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 14 },
  btnOff: { opacity: 0.45 },
  vacio: { alignItems: 'center', padding: 28, gap: 8 },
  vacioTit: { fontFamily: fonts.bold, color: colors.ink, fontSize: 16 },
  vacioTxt: { fontFamily: fonts.regular, color: colors.muted, fontSize: 13, textAlign: 'center', maxWidth: 420 },
  evento: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, padding: 14 },
  eNombre: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 15, flexShrink: 1 },
  estado: { fontFamily: fonts.medium, fontSize: 11, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 1, overflow: 'hidden' },
  eSub: { fontFamily: fonts.regular, color: colors.muted, fontSize: 12, marginTop: 2 },
  eVenta: { fontFamily: fonts.bold, color: colors.ink, fontSize: 14 },
});
