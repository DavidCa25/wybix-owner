import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import {
  useFonts,
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
  Poppins_800ExtraBold
} from '@expo-google-fonts/poppins';
import { AuthProvider } from '../lib/auth';
import { loadPairing } from '../lib/pairing';
import { configureSupabase } from '../lib/supabase';
import { colors } from '../theme/tokens';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [pairingChecked, setPairingChecked] = useState(false);

  const [fontsLoaded] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
    Poppins_800ExtraBold
  });

  // Cargar pairing y reconfigurar Supabase con los datos del QR antes de renderizar
  useEffect(() => {
    (async () => {
      const p = await loadPairing();
      if (p) configureSupabase(p.url, p.anonKey);
      setPairingChecked(true);
    })();
  }, []);

  useEffect(() => {
    if (fontsLoaded && pairingChecked) SplashScreen.hideAsync();
  }, [fontsLoaded, pairingChecked]);

  if (!fontsLoaded || !pairingChecked) return null;

  return (
    <AuthProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="corte/[id]" />
      </Stack>
    </AuthProvider>
  );
}