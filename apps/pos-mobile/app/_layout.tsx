import "../lib/polyfills";
import "../lib/fondo";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useKeepAwake } from "expo-keep-awake";
import { pos as t } from "../components/ui";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import { MotionProvider } from "../components/ui";
import { View, ActivityIndicator } from "react-native";
import { PosProvider } from "../lib/contexto";
import PwaInstallHint from '../components/PwaInstallHint';

export default function Raiz() {
  useKeepAwake(); // en una feria la pantalla no se apaga a mitad de un cobro
  const [fonts, fontError] = useFonts({
    // Las mismas familias del POS de escritorio y de la landing.
    Wybix: require("@expo-google-fonts/geist/400Regular/Geist_400Regular.ttf"),
    WybixSemi: require("@expo-google-fonts/geist/600SemiBold/Geist_600SemiBold.ttf"),
    WybixMono: require("@expo-google-fonts/geist-mono/500Medium/GeistMono_500Medium.ttf"),
  });
  if (!fonts && !fontError)
    return (
      <View
        style={{ flex: 1, backgroundColor: t.navy, justifyContent: "center" }}
      >
        <ActivityIndicator color={t.wybix} />
      </View>
    );
  return (
    <SafeAreaProvider>
      <MotionProvider>
        <PosProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: t.fondo },
            }}
          />
          <PwaInstallHint />
        </PosProvider>
      </MotionProvider>
    </SafeAreaProvider>
  );
}
