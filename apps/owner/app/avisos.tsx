/**
 * AVISOS: qué notificaciones recibe esta persona, de esta empresa, por qué
 * canal. Los tipos y a quién le tocan los decide la nube (notification_kinds);
 * aquí solo se apaga o enciende lo propio (RLS: cada quien sus preferencias).
 */
import { useCallback, useState } from 'react';
import { View, Text, Switch, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useEmpresa } from '../lib/useEmpresa';
import { colors, fonts, radius } from '../theme/tokens';

type Tipo = { kind: string; descripcion: string; canales: string[] };
type Canal = 'push' | 'email';
const NOMBRE_CANAL: Record<Canal, string> = { push: 'Notificación', email: 'Correo' };

export default function Avisos() {
  const router = useRouter();
  const { session } = useAuth();
  const empresa = useEmpresa();
  const [tipos, setTipos] = useState<Tipo[] | null>(null);
  const [apagados, setApagados] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState<string | null>(null);
  const uid = session?.user.id;
  const empresaId = empresa.empresaId;

  const cargar = useCallback(async () => {
    if (!uid || !empresaId) return;
    setError('');
    const [t, p] = await Promise.all([
      supabase.from('notification_kinds').select('kind, descripcion, canales').eq('activo', true).order('kind'),
      supabase.from('notification_preferences').select('kind, canal, activo').eq('user_id', uid).eq('company_id', empresaId),
    ]);
    if (t.error || p.error) { setError('No se pudieron cargar tus avisos.'); return; }
    setTipos(t.data as Tipo[]);
    setApagados(new Set((p.data ?? []).filter((x) => !x.activo).map((x) => `${x.kind}:${x.canal}`)));
  }, [uid, empresaId]);
  useFocusEffect(useCallback(() => { cargar(); }, [cargar]));

  async function cambiar(kind: string, canal: Canal, activo: boolean) {
    if (!uid || !empresaId) return;
    const k = `${kind}:${canal}`;
    setGuardando(k); setError('');
    const { error: e } = await supabase.from('notification_preferences')
      .upsert({ user_id: uid, company_id: empresaId, kind, canal, activo, updated_at: new Date().toISOString() },
              { onConflict: 'user_id,company_id,kind,canal' });
    setGuardando(null);
    if (e) { setError('No se pudo guardar. Intenta de nuevo.'); return; }
    setApagados((s) => { const n = new Set(s); if (activo) n.delete(k); else n.add(k); return n; });
  }

  const nombreEmpresa = empresa.empresas.find((e) => e.company_id === empresaId)?.nombre;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} style={styles.back} accessibilityRole="button" accessibilityLabel="Volver">
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View>
          <Text style={styles.hTitle}>Avisos</Text>
          {nombreEmpresa ? <Text style={styles.hSub}>{nombreEmpresa}</Text> : null}
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.text}>Elige qué te avisamos y por dónde. Los avisos nunca muestran importes ni nombres en la pantalla bloqueada; el detalle está en la app.</Text>
        {!tipos && !error ? <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {tipos?.map((t) => (
          <View key={t.kind} style={styles.card}>
            <Text style={styles.title}>{t.descripcion}</Text>
            {(t.canales as Canal[]).map((c) => {
              const k = `${t.kind}:${c}`;
              const activo = !apagados.has(k);
              return (
                <View key={c} style={styles.fila}>
                  <Text style={styles.canal}>{NOMBRE_CANAL[c] ?? c}</Text>
                  {guardando === k ? <ActivityIndicator color={colors.primary} /> : (
                    <Switch value={activo} onValueChange={(v) => cambiar(t.kind, c, v)}
                      trackColor={{ true: colors.primary, false: colors.line }} thumbColor="#fff"
                      accessibilityLabel={`${t.descripcion}: ${NOMBRE_CANAL[c] ?? c}`} accessibilityState={{ checked: activo }} />
                  )}
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.navy, borderBottomWidth: 1, borderBottomColor: colors.line },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hTitle: { fontFamily: fonts.bold, fontSize: 18, color: '#fff' },
  hSub: { fontFamily: fonts.regular, fontSize: 12, color: colors.sky },
  body: { padding: 16, gap: 12, maxWidth: 560, width: '100%', alignSelf: 'center' },
  text: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.muted, lineHeight: 19 },
  error: { fontFamily: fonts.medium, color: colors.danger, fontSize: 13, textAlign: 'center' },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 6, borderWidth: 1, borderColor: colors.line },
  title: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink, marginBottom: 4 },
  fila: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  canal: { fontFamily: fonts.regular, fontSize: 14, color: colors.ink },
});
