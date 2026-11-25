import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Image
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { useDialog } from '../../lib/dialog';
import { vincularConPairing } from '../../lib/vincular';
import { colors, fonts, radius } from '../../theme/tokens';
import { Guide, MarcaWybix } from '@wybix/ui';

export default function Login() {
  const router = useRouter();
  const { signIn, resetPassword } = useAuth();
  const dialog = useDialog();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);

  async function onLogin() {
    if (!email.trim() || !password) {
      setError('Escribe tu correo y contraseña.');
      return;
    }
    setBusy(true);
    setError('');
    const { error: err } = await signIn(email, password);
    if (err) { setBusy(false); setError('Correo o contraseña incorrectos.'); return; }
    // Si escaneó el QR de otro negocio, se une con su invitación.
    const v = await vincularConPairing();
    setBusy(false);
    if (!v.ok) setError(v.error || 'No se pudo vincular el negocio.');
  }

  async function onForgot() {
    setError('');
    if (!email.trim()) {
      dialog.show({
        type: 'error',
        title: 'Falta tu correo',
        message: 'Escribe tu correo arriba y te enviamos el enlace para restablecer tu contraseña.'
      });
      return;
    }
    setSendingReset(true);
    const { error: err } = await resetPassword(email);
    setSendingReset(false);
    if (err) {
      dialog.show({
        type: 'error',
        title: 'No se pudo enviar',
        message: 'Verifica que el correo esté bien escrito e intenta de nuevo.'
      });
    } else {
      dialog.show({
        type: 'success',
        title: 'Correo enviado',
        message: 'Te enviamos un correo para restablecer tu contraseña. Revisa tu bandeja de entrada (y la carpeta de spam).'
      });
    }
  }

  return (
    <View style={styles.bg}>
      <KeyboardAvoidingView
        style={styles.center}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.marca}><MarcaWybix producto="Owner" size={40} fuente={fonts.bold} /></View>
        {/* Wybix Guide asomado sobre la tarjeta, como al emparejar POS Mobile. */}
        <View style={styles.asoma} pointerEvents="none">
          <Guide cara={error ? 'error' : busy ? 'atencion' : 'reposo'} size={92} movimiento="asoma" etiqueta={null} />
        </View>
        <View style={styles.card}>
          <Text style={styles.title} accessibilityRole="header">Tu negocio, desde aquí</Text>

          <Text style={styles.label}>Correo</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="tu@correo.com"
            autoCapitalize="none"
            keyboardType="email-address"
            placeholderTextColor={colors.muted}
          />

          <Text style={styles.label}>Contraseña</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Tu contraseña"
            secureTextEntry
            placeholderTextColor={colors.muted}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity style={styles.button} onPress={onLogin} disabled={busy} activeOpacity={0.85}>
            {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.buttonText}>Entrar</Text>}
          </TouchableOpacity>

          <TouchableOpacity onPress={onForgot} disabled={sendingReset} style={styles.forgotBtn} activeOpacity={0.7}>
            {sendingReset
              ? <ActivityIndicator color={colors.sky} size="small" />
              : <Text style={styles.forgot}>¿Olvidaste tu contraseña?</Text>}
          </TouchableOpacity>

          <View style={styles.divider}>
            <View style={styles.line} />
            <Text style={styles.dividerText}>o</Text>
            <View style={styles.line} />
          </View>

          <TouchableOpacity onPress={() => router.push('/(auth)/escanear')} style={styles.altBtn} activeOpacity={0.7}>
            <Text style={styles.altLink}>Vincular otro negocio (escanear QR)</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => router.push('/(auth)/registro')} style={styles.altBtnTight} activeOpacity={0.7}>
            <Text style={styles.altLinkMuted}>Crear una cuenta nueva</Text>
          </TouchableOpacity>

          <Text style={styles.footer}>© 2026 Wybix POS. Todos los derechos reservados.</Text>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: colors.navyDeep },
  center: { flex: 1, justifyContent: 'center', padding: 20, width: '100%', maxWidth: 460, alignSelf: 'center' },
  card: { zIndex: 1, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 28, padding: 24, paddingTop: 44, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 8 },
  marca: { alignItems: 'center', marginBottom: 28 },
  asoma: { alignItems: 'center', marginBottom: -42, zIndex: 0 },
  title: { fontFamily: fonts.bold, fontSize: 22, letterSpacing: -0.5, color: colors.ink, textAlign: 'center', marginBottom: 12 },
  label: { fontFamily: fonts.semibold, fontSize: 12, color: colors.ink, marginBottom: 6, marginTop: 12 },
  input: { fontFamily: fonts.regular, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 13, paddingVertical: 13, fontSize: 15, color: colors.ink, backgroundColor: colors.navyDeep },
  error: { fontFamily: fonts.medium, color: colors.danger, fontSize: 13, marginTop: 12, textAlign: 'center' },
  button: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 15, alignItems: 'center', marginTop: 22 },
  buttonText: { fontFamily: fonts.bold, color: colors.onPrimary, fontSize: 15 },
  forgotBtn: { alignItems: 'center', marginTop: 16, paddingVertical: 4 },
  forgot: { fontFamily: fonts.semibold, color: colors.sky, fontSize: 13.5 },
  divider: { flexDirection: 'row', alignItems: 'center', marginTop: 20, marginBottom: 4 },
  line: { flex: 1, height: 1, backgroundColor: colors.line },
  dividerText: { fontFamily: fonts.medium, color: colors.muted, fontSize: 12, marginHorizontal: 12 },
  altBtn: { alignItems: 'center', marginTop: 14, paddingVertical: 6 },
  altBtnTight: { alignItems: 'center', marginTop: 4, paddingVertical: 6 },
  altLink: { fontFamily: fonts.semibold, color: colors.sky, fontSize: 13.5 },
  altLinkMuted: { fontFamily: fonts.medium, color: colors.muted, fontSize: 13 },
  footer: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted, textAlign: 'center', marginTop: 20 }
});