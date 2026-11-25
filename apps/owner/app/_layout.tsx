import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import {
  Geist_400Regular,
  Geist_500Medium,
  Geist_600SemiBold,
  Geist_700Bold,
  Geist_800ExtraBold
} from '@expo-google-fonts/geist';
import { GeistMono_600SemiBold } from '@expo-google-fonts/geist-mono';
import { AuthProvider } from '../lib/auth';
import { DialogProvider } from '../lib/dialog';
import { loadPairing } from '../lib/pairing';
import { configureSupabase } from '../lib/supabase';
import { colors } from '../theme/tokens';
import PwaInstallHint from '../components/PwaInstallHint';
import AnimatedSplash from '../components/AnimatedSplash';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [pairingChecked, setPairingChecked] = useState(false);
  const [animDone, setAnimDone] = useState(false);

  const [fontsLoaded] = useFonts({
    // La letra de la caja y de POS Mobile: Geist, y Geist Mono en los montos.
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
    Geist_800ExtraBold,
    GeistMono_600SemiBold
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
      <DialogProvider>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="corte/[id]" />
          <Stack.Screen name="evento/[id]" />
        </Stack>
        <PwaInstallHint />
      </DialogProvider>
      {!animDone && <AnimatedSplash onDone={() => setAnimDone(true)} />}
    </AuthProvider>
  );
}