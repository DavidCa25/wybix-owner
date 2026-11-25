import { Pressable, StyleSheet, Text, View } from "react-native";
import { Guide } from "@wybix/ui";
import { Redirect, Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pos as t, tipo } from "../../components/ui";
import { useAncho } from "../../components/Marco";
import { usePos } from "../../lib/contexto";
const icons = [
  "cart-outline",
  "receipt-outline",
  "cash-outline",
  "cube-outline",
  "cloud-done-outline",
] as const;
function Navigation({ state, descriptors, navigation }: BottomTabBarProps) {
  // Tablet: cada pantalla lleva su columna (components/Marco, Vender), sin barra.
  if (useAncho()) return null;
  return <BarraInferior state={state} descriptors={descriptors} navigation={navigation} />;
}
/**
 * Celular: el DOCK del POS de escritorio, flotando sobre el área segura.
 * Wybix Guide a la izquierda cuenta el estado de la tablet con su cara
 * (atento sin red o con ventas por enviar, error si la dieron de baja); el
 * texto de ese estado vive en la cabecera de cada pantalla.
 */
function BarraInferior({ state, descriptors, navigation }: Pick<BottomTabBarProps, "state" | "descriptors" | "navigation">) {
  const insets = useSafeAreaInsets();
  const { sync } = usePos();
  const cara = sync.revocado ? "error" : !sync.en_linea || sync.pendientes ? "atencion" : "reposo";
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: insets.bottom + 10, backgroundColor: t.fondo, alignItems: "center" }}>
      <View accessibilityRole="tablist" style={s.dock}>
        <View style={{ width: 40, alignItems: "center", justifyContent: "center" }}>
          <Guide cara={cara} size={32} etiqueta={`Wybix Guide. ${sync.texto}`} />
        </View>
        {state.routes.map((route, index) => {
          if (index >= cortos.length) return null;
          const active = state.index === index;
          const color = active ? t.texto : t.tenue;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={descriptors[route.key].options.title}
              onPress={() => {
                const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                if (!active && !event.defaultPrevented) navigation.navigate(route.name, route.params);
              }}
              style={[s.item, active && { backgroundColor: t.elegido }]}
            >
              <Ionicons name={icons[index]} size={21} color={color} />
              <Text style={[tipo.tenue, { color, fontSize: 10, fontFamily: active ? "WybixSemi" : "Wybix" }]} numberOfLines={1}>
                {cortos[index]}
              </Text>
              {active && <View style={s.raya} />}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
const cortos = ["Vender", "Ventas", "Turno", "Inventario", "Estado"];
export default function CajaLayout() {
  const { persona, fase } = usePos();
  if (fase !== "listo") return <Redirect href="/" />;
  if (!persona) return <Redirect href="/entrar" />;
  return (
    <Tabs
      tabBar={(props) => <Navigation {...props} />}
      screenOptions={{
        headerShown: false,
      }}
    >
      <Tabs.Screen name="vender" options={{ title: "Vender" }} />
      <Tabs.Screen name="ventas" options={{ title: "Ventas del turno" }} />
      <Tabs.Screen name="turno" options={{ title: "Turno y corte" }} />
      <Tabs.Screen name="inventario" options={{ title: "Inventario" }} />
      <Tabs.Screen name="sincronia" options={{ title: "Estado" }} />
      {/* Se entra desde Inventario: no es una sección de la barra. */}
      <Tabs.Screen name="conteo" options={{ title: "Conteo", href: null }} />
    </Tabs>
  );
}

const s = StyleSheet.create({
  dock: {
    width: "100%",
    maxWidth: 560,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    padding: 7,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: t.borde,
    backgroundColor: t.riel,
    shadowColor: "#060B11",
    shadowOpacity: 0.6,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 14 },
    elevation: 14,
  },
  item: { flex: 1, height: 54, borderRadius: 18, alignItems: "center", justifyContent: "center", gap: 3 },
  raya: { position: "absolute", bottom: 4, width: 14, height: 2.5, borderRadius: 2, backgroundColor: t.wybix },
});
