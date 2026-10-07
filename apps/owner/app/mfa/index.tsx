/**
 * SEGURIDAD DE LA CUENTA: verificación en dos pasos (TOTP).
 *
 *   Sin factor  -> activar: la app autenticadora recibe la clave (enlace
 *                  otpauth:// en el teléfono; QR en la versión web), se
 *                  confirma con el primer código y se muestran los 10 códigos
 *                  de recuperación UNA sola vez.
 *   Con factor  -> códigos nuevos, quitar la verificación y cerrar las otras
 *                  sesiones. Todo exige la sesión confirmada (AAL2).
 */
import { useCallback, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Linking, Platform, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../lib/auth';
import { useDialog } from '../../lib/dialog';
import * as mfa from '../../lib/mfa';
import { colors, fonts, radius } from '../../theme/tokens';

type Paso = { tipo: 'resumen' } | { tipo: 'enrolando'; e: mfa.Enrolamiento } | { tipo: 'codigos'; codigos: string[] };

export default function SeguridadCuenta() {
  const router = useRouter();
  const dialog = useDialog();
  const { nivel, refrescarNivel } = useAuth();
  const [estado, setEstado] = useState<mfa.Estado | null>(null);
  const [paso, setPaso] = useState<Paso>({ tipo: 'resumen' });
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const cargar = useCallback(async () => { setEstado(await mfa.estado()); await refrescarNivel(); }, [refrescarNivel]);
  useFocusEffect(useCallback(() => { cargar(); }, [cargar]));

  const activa = (estado?.factores ?? 0) > 0;
  const confirmada = nivel.actual === 'aal2';

  async function iniciar() {
    setBusy(true); setError('');
    const r = await mfa.iniciarEnrolamiento();
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setCodigo('');
    setPaso({ tipo: 'enrolando', e: r.enrolamiento });
  }

  async function confirmarEnrolamiento(e: mfa.Enrolamiento) {
    setBusy(true); setError('');
    const r = await mfa.confirmarEnrolamiento(e.factorId, codigo);
    setBusy(false);
    if (!r.ok) { setError(r.error); setCodigo(''); return; }
    setPaso({ tipo: 'codigos', codigos: r.codigos });
    cargar();
  }

  async function codigosNuevos() {
    setBusy(true); setError('');
    const r = await mfa.generarCodigos();
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setPaso({ tipo: 'codigos', codigos: r.codigos });
    cargar();
  }

  async function quitar() {
    setBusy(true); setError('');
    const r = await mfa.quitarFactor();
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    dialog.show({ type: 'info', title: 'Verificación quitada', message: 'Mientras no la actives de nuevo, podrás ver tu negocio pero no hacer cambios.' });
    cargar();
  }

  async function cerrarOtras() {
    setBusy(true); setError('');
    const r = await mfa.cerrarOtrasSesiones();
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    dialog.show({ type: 'success', title: 'Listo', message: 'Se cerraron tus sesiones en otros teléfonos y navegadores.' });
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} style={styles.back} accessibilityRole="button" accessibilityLabel="Volver">
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.hTitle}>Seguridad de la cuenta</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {!estado ? <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} /> : null}

        {estado && paso.tipo === 'resumen' && (
          <View style={styles.card}>
            <View style={styles.row}>
              <Ionicons name={activa ? 'shield-checkmark' : 'shield-outline'} size={26} color={activa ? colors.success : colors.warning} />
              <Text style={styles.title}>{activa ? 'Verificación en dos pasos activa' : 'Verificación en dos pasos desactivada'}</Text>
            </View>
            <Text style={styles.text}>
              {activa
                ? `Para hacer cambios (eventos, personal, tablets, equipos) te pedimos el código de tu app autenticadora. Te quedan ${estado.codigos_restantes} códigos de recuperación.`
                : 'Para hacer cambios en tu negocio (eventos, personal, tablets, equipos) necesitas activarla. Ver tu negocio no la requiere.'}
            </Text>

            {!activa && <Boton titulo="Activar" onPress={iniciar} busy={busy} testID="mfa-activar" />}

            {activa && !confirmada && (
              <Boton titulo="Confirmar con mi código" onPress={() => router.push('/mfa/verificar?volver=1')} busy={busy} />
            )}
            {activa && confirmada && (
              <>
                <Boton titulo="Generar códigos de recuperación nuevos" onPress={codigosNuevos} busy={busy} secundario />
                <Boton titulo="Cerrar sesión en otros dispositivos" onPress={cerrarOtras} busy={busy} secundario />
                <Boton titulo="Quitar la verificación" onPress={quitar} busy={busy} peligro />
              </>
            )}
            {activa && !confirmada && (
              <Text style={styles.nota}>Las demás opciones aparecen después de confirmar con tu código.</Text>
            )}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        )}

        {estado && paso.tipo === 'resumen' && (
          <TouchableOpacity style={styles.enlace} onPress={() => router.push('/avisos')} accessibilityRole="button">
            <Ionicons name="notifications-outline" size={20} color={colors.sky} />
            <Text style={styles.enlaceTexto}>Avisos y notificaciones</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </TouchableOpacity>
        )}

        {paso.tipo === 'enrolando' && (
          <View style={styles.card}>
            <Text style={styles.title}>1 · Agrega Wybix a tu app autenticadora</Text>
            <Text style={styles.text}>Funciona con Google Authenticator, Microsoft Authenticator, 1Password y similares.</Text>
            {Platform.OS === 'web'
              ? <Image source={{ uri: mfa.qrComoUri(paso.e.qr) }} style={styles.qr} accessibilityLabel="Código QR para la app autenticadora" />
              : <Boton titulo="Abrir mi app autenticadora" onPress={() => Linking.openURL(paso.e.uri).catch(() => setError('No se encontró una app autenticadora. Escribe la clave a mano.'))} secundario />}
            <Text style={styles.label}>O escribe esta clave en la app:</Text>
            <Text selectable style={styles.secreto} accessibilityLabel={`Clave: ${paso.e.secreto.split('').join(' ')}`}>
              {paso.e.secreto.match(/.{1,4}/g)?.join(' ')}
            </Text>

            <Text style={[styles.title, { marginTop: 18 }]}>2 · Escribe el código que muestra</Text>
            <TextInput
              testID="mfa-primer-codigo"
              style={styles.input}
              value={codigo}
              onChangeText={(t) => { setCodigo(t); setError(''); }}
              placeholder="000000"
              placeholderTextColor={colors.muted}
              keyboardType="number-pad"
              maxLength={6}
              autoComplete="one-time-code"
              accessibilityLabel="Código de la app autenticadora"
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Boton titulo="Confirmar" onPress={() => confirmarEnrolamiento(paso.e)} busy={busy} deshabilitado={codigo.replace(/\D/g, '').length !== 6} />
            <Boton titulo="Cancelar" onPress={() => { setPaso({ tipo: 'resumen' }); setError(''); }} secundario busy={busy} />
          </View>
        )}

        {paso.tipo === 'codigos' && (
          <View style={styles.card}>
            <View style={styles.row}>
              <Ionicons name="key-outline" size={24} color={colors.warning} />
              <Text style={styles.title}>Guarda tus códigos de recuperación</Text>
            </View>
            <Text style={styles.text}>
              Si pierdes tu teléfono, cada código te deja entrar una sola vez. Se muestran SOLO ahora: guárdalos fuera de este teléfono (papel o gestor de contraseñas).
            </Text>
            <View style={styles.codigos} accessible accessibilityLabel={`Códigos de recuperación: ${paso.codigos.join(', ')}`}>
              {paso.codigos.map((c) => <Text key={c} selectable style={styles.codigo}>{c}</Text>)}
            </View>
            <Boton titulo="Ya los guardé" onPress={() => setPaso({ tipo: 'resumen' })} />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Boton({ titulo, onPress, busy, deshabilitado, secundario, peligro, testID }: {
  titulo: string; onPress: () => void; busy?: boolean; deshabilitado?: boolean; secundario?: boolean; peligro?: boolean; testID?: string;
}) {
  const off = busy || deshabilitado;
  return (
    <TouchableOpacity testID={testID} onPress={onPress} disabled={off} activeOpacity={0.85}
      accessibilityRole="button" accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={[styles.button, secundario && styles.buttonSec, peligro && styles.buttonPeligro, off && { opacity: 0.5 }]}>
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={[styles.buttonText, peligro && { color: colors.danger }]}>{titulo}</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.navy, borderBottomWidth: 1, borderBottomColor: colors.line },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hTitle: { fontFamily: fonts.bold, fontSize: 18, color: '#fff' },
  body: { padding: 16, gap: 14, maxWidth: 560, width: '100%', alignSelf: 'center' },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 20, gap: 12, borderWidth: 1, borderColor: colors.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink, flexShrink: 1 },
  text: { fontFamily: fonts.regular, fontSize: 14, color: colors.muted, lineHeight: 20 },
  nota: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.muted },
  label: { fontFamily: fonts.semibold, fontSize: 12, color: colors.ink, marginTop: 6 },
  secreto: { fontFamily: fonts.semibold, fontSize: 17, color: colors.sky, letterSpacing: 1.5, backgroundColor: colors.navy, borderRadius: radius.md, padding: 12, textAlign: 'center' },
  qr: { width: 200, height: 200, alignSelf: 'center', backgroundColor: '#fff', borderRadius: radius.md },
  input: { fontFamily: fonts.semibold, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingVertical: 12, fontSize: 24, letterSpacing: 8, color: colors.ink, backgroundColor: colors.navy, textAlign: 'center' },
  error: { fontFamily: fonts.medium, color: colors.danger, fontSize: 13, textAlign: 'center' },
  codigos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  codigo: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink, backgroundColor: colors.navy, borderRadius: radius.sm, paddingVertical: 8, paddingHorizontal: 12, letterSpacing: 1, minWidth: 130, textAlign: 'center' },
  button: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  buttonSec: { backgroundColor: colors.navySoft, borderWidth: 1, borderColor: colors.line },
  buttonPeligro: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger },
  buttonText: { fontFamily: fonts.bold, color: '#fff', fontSize: 15 },
  enlace: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, minHeight: 52, borderWidth: 1, borderColor: colors.line },
  enlaceTexto: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
});
