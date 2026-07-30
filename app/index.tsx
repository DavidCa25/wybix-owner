import { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { useAuth } from '../lib/auth';
import { loadPairing } from '../lib/pairing';
import { colors } from '../theme/tokens';

// Punto de entrada: decide a donde ir segun sesion y pairing.
export default function Index() {
  const { session, loading } = useAuth();
  const [hasPairing, setHasPairing] = useState<boolean | null>(null);

  useEffect(() => {
    loadPairing().then(p => setHasPairing(!!p));
  }, []);

  if (loading || hasPairing === null) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (session) return <Redirect href="/(tabs)" />;
  return <Redirect href={hasPairing ? '/(auth)/login' : '/(auth)/registro'} />;
}