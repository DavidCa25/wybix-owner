import { Tabs, Redirect } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { Dock } from '../../components/Dock';
import { useAuth } from '../../lib/auth';
import { useAlertas } from '../../lib/useAlertas';
import { useSeguridad } from '../../lib/useSeguridad';
import { colors } from '../../theme/tokens';

export default function TabsLayout() {
  const { session, loading, pideCodigo, leyendoNivel } = useAuth();
  const { noLeidas } = useAlertas();
  const { altos } = useSeguridad();

  if (loading || leyendoNivel) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // Sin sesion: fuera de las pestanas, al login
  if (!session) {
    return <Redirect href="/(auth)/login" />;
  }

  // Tiene segundo factor y esta sesión aún no lo confirmó: primero el código.
  if (pideCodigo) {
    return <Redirect href="/mfa/verificar" />;
  }

  return (
    <Tabs
      tabBar={(props) => <Dock {...props} alertas={noLeidas} blindaje={altos} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
    >
      {/* El dock (components/Dock) dibuja iconos y avisos; aquí solo las rutas.
          Blindaje no va fijo en el dock: se abre desde «Más». */}
      <Tabs.Screen name="index" options={{ title: 'Inicio' }} />
      <Tabs.Screen name="eventos" options={{ title: 'Eventos' }} />
      <Tabs.Screen name="cortes" options={{ title: 'Cortes' }} />
      <Tabs.Screen name="alertas" options={{ title: 'Alertas' }} />
      <Tabs.Screen name="blindaje" options={{ title: 'Blindaje' }} />
    </Tabs>
  );
}
