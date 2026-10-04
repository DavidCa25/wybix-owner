import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { loadPairing, PairingData } from '../../lib/pairing';
import { vincularConPairing } from '../../lib/vincular';
import { colors, fonts, radius } from '../../theme/tokens';

export default function Registro() {
  const router = useRouter();
  const [pairing, setPairing] = useState<PairingData | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadPairing().then(setPairing);
  }, []);

  async function onRegister() {
    if (!email.trim() || !password) { setError('Escribe correo y contrasena.'); return; }
    if (password.length < 6) { setError('La contrasena debe tener al menos 6 caracteres.'); return; }
    if (!pairing) { setError('Falta escanear el codigo de tu negocio.'); return; }

    setBusy(true);
    setError('');

    // 1) Crear cuenta
    const { data: signUp, error: signErr } = await supabase.auth.signUp({
      email: email.trim(),
      password
    });
    if (signErr) { setBusy(false); setError(signErr.message); return; }

    // 2) Asegurar sesion (si el proyecto no exige confirmacion por correo)
    if (!signUp.session) {
      const { error: inErr } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (inErr) {
        setBusy(false);
        setError('Cuenta creada. Revisa tu correo para confirmarla y vuelve a entrar.');
        return;
      }
    }

    // 3) Vincular al negocio: acepta la invitacion del QR (Fase 1).
    const v = await vincularConPairing(pairing);
    if (!v.ok) { setBusy(false); setError(v.error || 'No se pudo vincular el negocio.'); return; }

    setBusy(false);
    // El _layout detecta la sesion y manda al tablero
    router.replace('/');
  }

  return (
    <View style={styles.bg}>
      <KeyboardAvoidingView style={styles.center} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.card}>
          <Text style={styles.title}>Crea tu cuenta</Text>
          {pairing?.nombre
            ? <Text style={styles.sub}>Vas a administrar: {pairing.nombre}</Text>
            : <Text style={styles.subWarn}>Primero escanea el codigo de tu negocio.</Text>}

          <Text style={styles.label}>Correo</Text>
          <TextInput style={styles.input} value={email} onChangeText={setEmail}
            placeholder="tu@correo.com" autoCapitalize="none" keyboardType="email-address" placeholderTextColor={colors.muted} />

          <Text style={styles.label}>Contrasena</Text>
          <TextInput style={styles.input} value={password} onChangeText={setPassword}
            placeholder="Minimo 6 caracteres" secureTextEntry placeholderTextColor={colors.muted} />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity style={[styles.button, !pairing && styles.buttonOff]} onPress={onRegister} disabled={busy || !pairing} activeOpacity={0.85}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Crear cuenta</Text>}
          </TouchableOpacity>

          <TouchableOpacity onPress={() => router.push('/(auth)/escanear')} style={styles.linkBtn}>
            <Text style={styles.link}>Escanear codigo del negocio</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => router.replace('/(auth)/login')} style={styles.linkBtn}>
            <Text style={styles.link}>Ya tengo cuenta</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: colors.navyDeep },
  center: { flex: 1, justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.card, borderRadius: 22, padding: 28 },
  title: { fontFamily: fonts.bold, fontSize: 22, color: colors.primary, textAlign: 'center' },
  sub: { fontFamily: fonts.medium, fontSize: 13, color: colors.success, textAlign: 'center', marginTop: 6, marginBottom: 8 },
  subWarn: { fontFamily: fonts.medium, fontSize: 13, color: colors.warning, textAlign: 'center', marginTop: 6, marginBottom: 8 },
  label: { fontFamily: fonts.semibold, fontSize: 12, color: colors.ink, marginBottom: 6, marginTop: 12 },
  input: { fontFamily: fonts.regular, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 13, paddingVertical: 13, fontSize: 15, color: colors.ink, backgroundColor: colors.navy },
  error: { fontFamily: fonts.medium, color: colors.danger, fontSize: 13, marginTop: 12, textAlign: 'center' },
  button: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 15, alignItems: 'center', marginTop: 22 },
  buttonOff: { opacity: 0.5 },
  buttonText: { fontFamily: fonts.bold, color: '#fff', fontSize: 15 },
  linkBtn: { marginTop: 16, alignItems: 'center' },
  link: { fontFamily: fonts.semibold, color: colors.sky, fontSize: 13.5 }
});