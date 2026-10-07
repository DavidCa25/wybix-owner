import { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import type { ResumenEmpresa, UbicacionResumen, Empresa } from '../../lib/useEmpresa';
import { eventos, mensaje, haceCuanto, ETIQUETA_ESTADO, type EstadoEvento, type Empleado, type Equipo } from '../../lib/useEventos';
import { colors, fonts, radius } from '../../theme/tokens';

/*
 * DETALLE DE UN EVENTO (Fase 2).
 *
 *   Estado     PLANNED -> OPEN -> CLOSED -> RECONCILED. Conciliar exige que no
 *              haya turnos abiertos ni mercancía en camino; si quedan
 *              existencias, solo con motivo (y queda registrado, no se esconde).
 *   Tablets    código de 24 h con su caja (F1, F2...), estado de cada equipo y
 *              baja. Lo que una tablet dada de baja haga después queda en
 *              cuarentena en la nube: no se pierde ni entra a los totales.
 *   Personal   quién trabaja en ESTE evento y con qué rol. Ser encargado en
 *              Centro no da permisos en la feria.
 */
type Rol = 'CASHIER' | 'SUPERVISOR';
const ROLES: { valor: Rol | null; etiqueta: string }[] = [
  { valor: null, etiqueta: 'No asignado' },
  { valor: 'CASHIER', etiqueta: 'Cajero' },
  { valor: 'SUPERVISOR', etiqueta: 'Encargado' },
];

function money(n: number | null | undefined): string {
  return '$' + Number(n ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function DetalleEvento() {
  const { id, empresa } = useLocalSearchParams<{ id: string; empresa: string }>();
  const router = useRouter();
  const [ev, setEv] = useState<UbicacionResumen | null>(null);
  const [base, setBase] = useState<string>('—');
  const [rol, setRol] = useState<Empresa['role'] | null>(null);
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [personal, setPersonal] = useState<Empleado[]>([]);
  const [cargando, setCargando] = useState(true);
  const [refrescando, setRefrescando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [codigo, setCodigo] = useState<{ code: string; caja: string; vence: string } | null>(null);
  const [porRevocar, setPorRevocar] = useState<string | null>(null);
  const [faltante, setFaltante] = useState<{ product_uuid: string; qty: string; product_name?: string; causes?: {type: string; quantity: string}[] }[] | null>(null);
  const [motivo, setMotivo] = useState('');

  const cargar = useCallback(async () => {
    if (!empresa || !id) return;
    setError(null);
    const [r, m, eq, pe] = await Promise.all([
      supabase.rpc('resumen_empresa', { p_company: empresa }),
      supabase.rpc('mis_empresas'),
      eventos.equipos(empresa).catch(() => [] as Equipo[]),
      eventos.empleados(empresa).catch(() => [] as Empleado[]),
    ]);
    if (r.error) { setError(r.error.message); return; }
    const res = r.data as ResumenEmpresa;
    const u = res.ubicaciones.find((x) => x.location_id === id) ?? null;
    setEv(u);
    setBase(res.ubicaciones.find((x) => x.location_id === u?.home_location_id)?.nombre ?? '—');
    setRol(((m.data ?? []) as Empresa[]).find((e) => e.company_id === empresa)?.role ?? null);
    setEquipos(eq.filter((d) => d.location_id === id));
    setPersonal(pe);
  }, [empresa, id]);

  useFocusEffect(useCallback(() => { (async () => { await cargar(); setCargando(false); })(); }, [cargar]));

  const refrescar = async () => { setRefrescando(true); await cargar(); setRefrescando(false); };
  const administra = rol === 'OWNER' || rol === 'ADMIN';
  const est = (ev?.event_status ?? 'PLANNED') as EstadoEvento;

  const cambiar = async (nuevo: EstadoEvento, forzar = false) => {
    if (!empresa || !id) return;
    setOcupado(true); setError(null); setAviso(null);
    const r = await eventos.estado(empresa, id, nuevo, forzar, forzar ? motivo.trim() : null);
    setOcupado(false);
    if (!r.ok) {
      if (r.code === 'STOCK_NOT_ZERO') setFaltante((r.stock as { product_uuid: string; qty: string; product_name?: string; causes?: {type: string; quantity: string}[] }[]) ?? []);
      setError(mensaje(r.code));
      return;
    }
    setFaltante(null); setMotivo('');
    setAviso(`El evento quedó ${ETIQUETA_ESTADO[nuevo].toLowerCase()}.`);
    await cargar();
  };

  const nuevoCodigo = async () => {
    if (!empresa || !id) return;
    setOcupado(true); setError(null);
    const r = await eventos.codigoTablet(empresa, id);
    setOcupado(false);
    if (!r.ok) { setError(mensaje(r.code)); return; }
    const reg = r.register as { code: string; name: string };
    setCodigo({ code: String(r.code), caja: reg?.code ?? '', vence: String(r.expires_at) });
  };

  const revocar = async (device: string) => {
    if (!empresa) return;
    setOcupado(true); setError(null);
    const r = await eventos.revocar(empresa, device);
    setOcupado(false); setPorRevocar(null);
    if (!r.ok) { setError(mensaje(r.code)); return; }
    setAviso('Tablet dada de baja. Lo que haga a partir de ahora queda en cuarentena.');
    await cargar();
  };

  const asignar = async (e: Empleado, valor: Rol | null) => {
    if (!empresa || !id) return;
    const actual = e.eventos.find((x) => x.location_id === id);
    setOcupado(true); setError(null);
    // Quitar la asignación conserva el rol que tenía (solo se desactiva).
    const role = (valor ?? (actual?.role === 'SUPERVISOR' ? 'SUPERVISOR' : 'CASHIER')) as Rol;
    const r = await eventos.asignar(empresa, id, e.id, role, valor !== null);
    setOcupado(false);
    if (!r.ok) { setError(mensaje(r.code)); return; }
    await cargar();
  };

  if (cargando) return <View style={styles.loader}><ActivityIndicator size="large" color={colors.primary} /></View>;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Volver">
          <Ionicons name="chevron-back" size={22} color={colors.skyLight} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hTitle} numberOfLines={1}>{ev?.nombre ?? 'Evento'}</Text>
          <Text style={styles.hSub}>{ETIQUETA_ESTADO[est]} · base {base}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refrescando} onRefresh={refrescar} tintColor={colors.primary} />}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {aviso ? <Text style={styles.ok}>{aviso}</Text> : null}

        {/* Hoy */}
        <View style={styles.card}>
          <View style={styles.filaEntre}>
            <Text style={styles.cardTitle}>Ventas de hoy</Text>
            <Text style={styles.grande}>{money(ev?.ventas.neto)}</Text>
          </View>
          <Text style={styles.sub}>{ev?.ventas.tickets ?? 0} tickets · última sincronización {haceCuanto(ev?.ultima_sincronizacion)}</Text>
          <Text style={styles.sub}>
            {ev?.turnos_abiertos?.length
              ? `Turno abierto desde ${new Date(ev.turnos_abiertos[0].abierto_at ?? '').toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`
              : ev?.ultimo_corte ? `Último corte: diferencia ${money(ev.ultimo_corte.diferencia)}${ev.ultimo_corte.a_ciegas ? ' (a ciegas)' : ''}` : 'Sin cortes todavía'}
          </Text>
        </View>

        {/* Estado */}
        <Text style={styles.seccion}>Estado del evento</Text>
        <View style={styles.card}>
          <View style={styles.pasos}>
            {(['PLANNED', 'OPEN', 'CLOSED', 'RECONCILED'] as EstadoEvento[]).map((s, i, arr) => {
              const hecho = arr.indexOf(est) >= i;
              return (
                <View key={s} style={styles.paso}>
                  <View style={[styles.punto, hecho && styles.puntoOn]} />
                  <Text style={[styles.pasoTxt, s === est && styles.pasoTxtOn]}>{ETIQUETA_ESTADO[s]}</Text>
                </View>
              );
            })}
          </View>
          {administra && est === 'PLANNED' && <Boton titulo="Abrir evento" onPress={() => cambiar('OPEN')} deshabilitado={ocupado} />}
          {administra && est === 'OPEN' && <Boton titulo="Cerrar evento" onPress={() => cambiar('CLOSED')} deshabilitado={ocupado} />}
          {administra && est === 'CLOSED' && (
            <View style={styles.fila}>
              <Boton titulo="Reabrir" secundario onPress={() => cambiar('OPEN')} deshabilitado={ocupado} />
              <Boton titulo="Conciliar" onPress={() => cambiar('RECONCILED')} deshabilitado={ocupado} />
            </View>
          )}
          {est === 'RECONCILED' && <Text style={styles.sub}>Evento conciliado: su inventario y su caja ya cerraron cuentas con la sucursal base.</Text>}
          {faltante && (
            <View style={{ marginTop: 12 }}>
              <Text style={styles.lbl}>Existencias que quedan en la feria</Text>
              {faltante.map((f) => <Text key={f.product_uuid} style={styles.sub}>{f.qty} · {f.product_name ?? f.product_uuid}{f.causes?.length ? ` · ${f.causes.map(c => `${c.type}: ${c.quantity}`).join(' · ')}` : ''}</Text>)}
              <TextInput value={motivo} onChangeText={setMotivo} placeholder="Motivo (obligatorio): explica la diferencia de inventario"
                placeholderTextColor={colors.muted} style={styles.input} maxLength={200} />
              <Boton titulo="Conciliar con faltante" onPress={() => cambiar('RECONCILED', true)} deshabilitado={ocupado || motivo.trim().length < 5} />
            </View>
          )}
        </View>

        {/* Tablets */}
        <View style={styles.filaEntre}>
          <Text style={styles.seccion}>Tablets</Text>
          {administra && (est === 'PLANNED' || est === 'OPEN') && (
            <Pressable onPress={nuevoCodigo} disabled={ocupado} accessibilityRole="button"><Text style={styles.link}>Agregar tablet</Text></Pressable>
          )}
        </View>
        {codigo && (
          <View style={[styles.card, styles.codigoCard]}>
            <Text style={styles.sub}>En la tablet: abre Wybix POS Mobile y captura este código. Vence a las {new Date(codigo.vence).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} de mañana; se usa una sola vez.</Text>
            <Text style={styles.codigo} selectable>{codigo.code}</Text>
            <Text style={styles.sub}>Caja asignada: {codigo.caja}</Text>
          </View>
        )}
        <View style={styles.card}>
          {equipos.length === 0 ? <Text style={styles.vacio}>Ninguna tablet enrolada en este evento.</Text> : equipos.map((d, i) => (
            <View key={d.id} style={[styles.equipo, i > 0 && styles.bordeArriba]}>
              <View style={{ flex: 1 }}>
                <View style={styles.filaCentro}>
                  <View style={[styles.led, { backgroundColor: d.status === 'REVOKED' ? colors.danger : d.en_linea ? colors.success : colors.muted }]} />
                  <Text style={styles.eNombre}>{d.name ?? 'Tablet'}{d.register ? ` · ${d.register}` : ''}</Text>
                </View>
                <Text style={styles.sub}>
                  {d.status === 'REVOKED' ? `Dada de baja ${haceCuanto(d.revoked_at)}` : `Último contacto ${haceCuanto(d.last_seen_at)} · sincronizó ${haceCuanto(d.last_sync_at)}`}
                </Text>
                <Text style={styles.sub}>
                  v{d.app_version ?? '—'}{d.pending_events ? ` · ${d.pending_events} pendientes en la tablet` : ''}
                  {d.clock_skew_seconds && Math.abs(d.clock_skew_seconds) > 300 ? ` · reloj desfasado ${Math.round(d.clock_skew_seconds / 60)} min` : ''}
                </Text>
              </View>
              {administra && d.status !== 'REVOKED' && (porRevocar === d.id ? (
                <View style={{ gap: 6 }}>
                  <Pressable onPress={() => revocar(d.id)} style={styles.peligro}><Text style={styles.peligroTxt}>Confirmar baja</Text></Pressable>
                  <Pressable onPress={() => setPorRevocar(null)}><Text style={styles.link}>Cancelar</Text></Pressable>
                </View>
              ) : (
                <Pressable onPress={() => setPorRevocar(d.id)} accessibilityRole="button"><Text style={styles.linkPeligro}>Dar de baja</Text></Pressable>
              ))}
            </View>
          ))}
        </View>

        {/* Personal */}
        <Text style={styles.seccion}>Personal del evento</Text>
        <View style={styles.card}>
          {personal.length === 0 ? <Text style={styles.vacio}>La sucursal base todavía no publica su personal.</Text> : personal.map((e, i) => {
            const asig = e.eventos.find((x) => x.location_id === id && x.active);
            return (
              <View key={e.id} style={[styles.persona, i > 0 && styles.bordeArriba]}>
                <Text style={styles.eNombre}>{e.nombre}</Text>
                <Text style={styles.sub}>{e.sucursal ?? '—'}{e.tiene_pin ? '' : ' · sin PIN: no podrá entrar en la tablet'}</Text>
                <View style={styles.chips}>
                  {ROLES.map((r) => {
                    const on = r.valor === null ? !asig : asig?.role === r.valor;
                    return (
                      <Pressable key={r.etiqueta} disabled={!administra || ocupado || on} onPress={() => asignar(e, r.valor)}
                        accessibilityRole="radio" accessibilityState={{ selected: on }} style={[styles.chip, on && styles.chipOn]}>
                        <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{r.etiqueta}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Boton({ titulo, onPress, deshabilitado, secundario }: { titulo: string; onPress: () => void; deshabilitado?: boolean; secundario?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={deshabilitado} accessibilityRole="button"
      style={[styles.btn, secundario ? styles.btnSec : styles.btnPri, deshabilitado && styles.btnOff]}>
      <Text style={secundario ? styles.btnSecTxt : styles.btnPriTxt}>{titulo}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg },
  header: { backgroundColor: colors.navyDeep, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 16, paddingTop: 10 },
  backBtn: { width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  hTitle: { fontFamily: fonts.bold, color: '#fff', fontSize: 20 },
  hSub: { fontFamily: fonts.regular, color: colors.skyLight, fontSize: 12.5, marginTop: 1 },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  error: { fontFamily: fonts.medium, color: colors.danger, fontSize: 13 },
  ok: { fontFamily: fonts.medium, color: colors.success, fontSize: 13 },
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: 14 },
  cardTitle: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 14 },
  grande: { fontFamily: fonts.black, color: colors.ink, fontSize: 22 },
  seccion: { fontFamily: fonts.bold, color: colors.ink, fontSize: 16, marginTop: 10 },
  sub: { fontFamily: fonts.regular, color: colors.muted, fontSize: 12.5, marginTop: 3 },
  lbl: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 13, marginBottom: 4 },
  link: { fontFamily: fonts.semibold, color: colors.skyLight, fontSize: 13.5, marginTop: 10 },
  linkPeligro: { fontFamily: fonts.semibold, color: colors.danger, fontSize: 13 },
  vacio: { fontFamily: fonts.regular, color: colors.muted, fontSize: 13, textAlign: 'center', padding: 12 },
  fila: { flexDirection: 'row', gap: 10 },
  filaEntre: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  filaCentro: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pasos: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 },
  paso: { alignItems: 'center', gap: 6, flex: 1 },
  punto: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.line },
  puntoOn: { backgroundColor: colors.primary },
  pasoTxt: { fontFamily: fonts.regular, color: colors.muted, fontSize: 11.5 },
  pasoTxtOn: { fontFamily: fonts.semibold, color: colors.ink },
  btn: { flex: 1, borderRadius: radius.sm, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  btnPri: { backgroundColor: colors.primary },
  btnPriTxt: { fontFamily: fonts.semibold, color: '#fff', fontSize: 14 },
  btnSec: { backgroundColor: 'rgba(255,255,255,0.06)' },
  btnSecTxt: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 14 },
  btnOff: { opacity: 0.45 },
  input: { fontFamily: fonts.regular, color: colors.ink, fontSize: 14, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.bg, marginVertical: 10 },
  codigoCard: { borderWidth: 1, borderColor: colors.primary, alignItems: 'center' },
  codigo: { fontFamily: fonts.black, color: '#fff', fontSize: 30, letterSpacing: 3, marginVertical: 8 },
  equipo: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  bordeArriba: { borderTopWidth: 1, borderTopColor: colors.line },
  led: { width: 8, height: 8, borderRadius: 4 },
  eNombre: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 14 },
  peligro: { backgroundColor: colors.danger, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 8 },
  peligroTxt: { fontFamily: fonts.semibold, color: '#fff', fontSize: 12.5 },
  persona: { paddingVertical: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  chipOn: { backgroundColor: colors.sky, borderColor: colors.sky },
  chipTxt: { fontFamily: fonts.medium, color: colors.ink, fontSize: 12.5 },
  chipTxtOn: { color: '#fff' },
});
