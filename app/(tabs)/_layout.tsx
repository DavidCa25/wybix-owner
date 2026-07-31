import { Tabs, Redirect } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../lib/auth';
import { useAlertas } from '../../lib/useAlertas';
import { useSeguridad } from '../../lib/useSeguridad';
import { colors, fonts } from '../../theme/tokens';

export default function TabsLayout() {
  const { session, loading } = useAuth();
  const { noLeidas } = useAlertas();
  const { altos } = useSeguridad();

  if (loading) {
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

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.navy, borderTopColor: colors.line, height: 60, paddingBottom: 8, paddingTop: 6 },
        tabBarLabelStyle: { fontFamily: fonts.medium, fontSize: 11 }
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Inicio',
          tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />
        }}
      />
      <Tabs.Screen
        name="cortes"
        options={{
          title: 'Cortes',
          tabBarIcon: ({ color, size }) => <Ionicons name="cash-outline" size={size} color={color} />
        }}
      />
      <Tabs.Screen
        name="blindaje"
        options={{
          title: 'Blindaje',
          tabBarIcon: ({ color, size }) => <Ionicons name="shield-checkmark" size={size} color={color} />,
          tabBarBadge: altos > 0 ? (altos > 9 ? '9+' : altos) : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.danger, fontSize: 10 }
        }}
      />
      <Tabs.Screen
        name="alertas"
        options={{
          title: 'Alertas',
          tabBarIcon: ({ color, size }) => <Ionicons name="notifications" size={size} color={color} />,
          tabBarBadge: noLeidas > 0 ? (noLeidas > 9 ? '9+' : noLeidas) : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.danger, fontSize: 10 }
        }}
      />
    </Tabs>
  );
}