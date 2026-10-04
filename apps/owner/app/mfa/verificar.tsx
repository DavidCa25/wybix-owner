/**
 * SEGUNDO PASO DEL INICIO DE SESIÓN (y de una operación que lo pidió).
 * Código de la app autenticadora o, si se perdió el teléfono, un código de
 * recuperación. Mismo lenguaje visual que el login de Owner.
 */
import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { useDialog } from '../../lib/dialog';
import { recuperar, verificar } from '../../lib/mfa';
import { colors, fonts, radius } from '../../theme/tokens';

export default function VerificarMfa() {
  const router = useRouter();
  const { volver } = useLocalSearchParams<{ volver?: string }>();
  const { signOut, refrescarNivel } = useAuth();
  const dialog = useDialog();
  const [modo, setModo] = useState<'codigo' | 'recuperacion'>('codigo');
  const [valor, setValor] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const salir = () => (volver ? router.back() : router.replace('/(tabs)'));

  async function confirmar() {
    if (busy) return;
    setBusy(true); setError('');
    if (modo === 'codigo') {
      const r = await verificar(valor);
      if (!r.ok) { setBusy(false); setError(r.error); setValor(''); return; }
      await refrescarNivel();
      setBusy(false);
      salir();
      return;
    }
    const r = await recuperar(valor);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    await refrescarNivel();
    dialog.show({
      type: 'success',
      title: 'Acceso recuperado',
      message: 'Se quitó la verificación en dos pasos y se cerraron tus otras sesiones. Actívala de nuevo con tu teléfono actual para poder hacer cambios.',
      alCerrar: () => router.replace('/mfa'),
    });
  }

  const listo = modo === 'codigo' ? valor.replace(/\D/g, '').length === 6 : valor.replace(/[^A-Za-z0-9]/g, '').length === 10;

  return (
    <View style={styles.bg}>
      <KeyboardAvoidingView style={styles.center} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.card}>
          <Text style={styles.title}>Verificación en dos pasos</Text>
          <Text style={styles.sub}>
            {modo === 'codigo'
              ? 'Escribe el código de 6 dígitos de tu app autenticadora.'
              : 'Escribe uno de los códigos de recuperación que guardaste al activar la verificación (por ejemplo, 7F3A2-9C1B0).'}
          </Text>

          <TextInput
            testID="mfa-codigo"
            style={[styles.input, modo === 'codigo' && styles.inputCodigo]}
            value={valor}
            onChangeText={(t) => { setValor(t); setError(''); }}
            placeholder={modo === 'codigo' ? '000000' : 'XXXXX-XXXXX'}
            placeholderTextColor={colors.muted}
            keyboardType={modo === 'codigo' ? 'number-pad' : 'default'}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete={modo === 'codigo' ? 'one-time-code' : 'off'}
            textContentType={modo === 'codigo' ? 'oneTimeCode' : 'none'}
            maxLength={modo === 'codigo' ? 6 : 13}
            accessibilityLabel={modo === 'codigo' ? 'Código de verificación' : 'Código de recuperación'}
            editable={!busy}
            onSubmitEditing={() => listo && confirmar()}
          />

          {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}

          <TouchableOpacity style={[styles.button, (!listo || busy) && styles.buttonOff]} onPress={confirmar} disabled={!listo || busy} activeOpacity={0.85}
            accessibilityRole="button" accessibilityState={{ disabled: !listo || busy, busy }}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{modo === 'codigo' ? 'Confirmar' : 'Recuperar acceso'}</Text>}
          </TouchableOpacity>

          <TouchableOpacity onPress={() => { setModo(modo === 'codigo' ? 'recuperacion' : 'codigo'); setValor(''); setError(''); }} style={styles.linkBtn} disabled={busy}>
            <Text style={styles.link}>{modo === 'codigo' ? 'Perdí mi teléfono: usar un código de recuperación' : 'Usar el código de mi app autenticadora'}</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => (volver ? router.back() : signOut())} style={styles.linkBtn} disabled={busy}>
            <Text style={styles.linkMuted}>{volver ? 'Cancelar' : 'Cerrar sesión'}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: colors.navyDeep },
  center: { flex: 1, justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.card, borderRadius: 22, padding: 28, maxWidth: 480, width: '100%', alignSelf: 'center' },
  title: { fontFamily: fonts.bold, fontSize: 22, color: colors.primary, textAlign: 'center', marginBottom: 10 },
  sub: { fontFamily: fonts.regular, fontSize: 14, color: colors.ink, textAlign: 'center', lineHeight: 20, marginBottom: 18 },
  input: { fontFamily: fonts.semibold, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 13, paddingVertical: 13, fontSize: 18, color: colors.ink, backgroundColor: colors.navy, textAlign: 'center', letterSpacing: 2 },
  inputCodigo: { fontSize: 26, letterSpacing: 8 },
  error: { fontFamily: fonts.medium, color: colors.danger, fontSize: 13, marginTop: 12, textAlign: 'center' },
  button: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 15, alignItems: 'center', marginTop: 22, minHeight: 48, justifyContent: 'center' },
  buttonOff: { opacity: 0.5 },
  buttonText: { fontFamily: fonts.bold, color: '#fff', fontSize: 15 },
  linkBtn: { alignItems: 'center', marginTop: 14, paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  link: { fontFamily: fonts.semibold, color: colors.sky, fontSize: 13.5, textAlign: 'center' },
  linkMuted: { fontFamily: fonts.medium, color: colors.muted, fontSize: 13 },
});
