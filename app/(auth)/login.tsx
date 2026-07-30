import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Image
} from 'react-native';
import { useAuth } from '../../lib/auth';
import { colors, fonts, radius } from '../../theme/tokens';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onLogin() {
    if (!email.trim() || !password) {
      setError('Escribe tu correo y contraseña.');
      return;
    }
    setBusy(true);
    setError('');
    const { error: err } = await signIn(email, password);
    console.log('Resultado login:', err);
    setBusy(false);
    if (err) setError('Correo o contraseña incorrectos.');
  }

  return (
    <View style={styles.bg}>
      <KeyboardAvoidingView
        style={styles.center}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.card}>
          <Image
            source={require('../../assets/wybie_logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.title}>Iniciar sesion</Text>

          <Text style={styles.label}>Correo</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="tu@correo.com"
            autoCapitalize="none"
            keyboardType="email-address"
            placeholderTextColor="#94a3b8"
          />

          <Text style={styles.label}>Contraseña</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Tu contraseña"
            secureTextEntry
            placeholderTextColor="#94a3b8"
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity style={styles.button} onPress={onLogin} disabled={busy} activeOpacity={0.85}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Entrar</Text>}
          </TouchableOpacity>

          <Text style={styles.footer}>© 2026 Wybix POS. Todos los derechos reservados.</Text>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: colors.navyDeep },
  center: { flex: 1, justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.card, borderRadius: 22, padding: 28, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 8 },
  logo: { width: 150, height: 64, alignSelf: 'center', marginBottom: 8 },
  title: { fontFamily: fonts.bold, fontSize: 22, color: colors.primary, textAlign: 'center', marginBottom: 20 },
  label: { fontFamily: fonts.semibold, fontSize: 12, color: colors.ink, marginBottom: 6, marginTop: 12 },
  input: { fontFamily: fonts.regular, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 13, paddingVertical: 13, fontSize: 15, color: colors.ink, backgroundColor: '#f8fafc' },
  error: { fontFamily: fonts.medium, color: colors.danger, fontSize: 13, marginTop: 12, textAlign: 'center' },
  button: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 15, alignItems: 'center', marginTop: 22 },
  buttonText: { fontFamily: fonts.bold, color: '#fff', fontSize: 15 },
  footer: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted, textAlign: 'center', marginTop: 20 }
});