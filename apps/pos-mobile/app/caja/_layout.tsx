import { Pressable, Text, View } from "react-native";
import { Redirect, Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pos as t, tipo } from "../../components/ui";
import { useAncho } from "../../components/Marco";
import { usePos } from "../../lib/contexto";
const icons = [
  "cart-outline",
  "cash-outline",
  "cube-outline",
  "cloud-done-outline",
] as const;
function Navigation({ state, descriptors, navigation }: BottomTabBarProps) {
  // Tablet: cada pantalla lleva su columna (components/Marco, Vender), sin barra.
  if (useAncho()) return null;
  return <BarraInferior state={state} descriptors={descriptors} navigation={navigation} />;
}
/** Celular: barra blanca; la sección activa en el color de la marca. */
function BarraInferior({ state, descriptors, navigation }: Pick<BottomTabBarProps, "state" | "descriptors" | "navigation">) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        backgroundColor: t.superficie,
        borderTopWidth: 1,
        borderTopColor: t.borde,
        flexDirection: "row",
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      {state.routes.map((route, index) => {
        const active = state.index === index;
        const color = active ? t.acentoTinta : t.tenue;
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
            style={{ flex: 1, minHeight: 60, alignItems: "center", justifyContent: "center", gap: 3 }}
          >
            <Ionicons name={icons[index]} size={22} color={color} />
            <Text style={[tipo.tenue, { color, fontSize: 11, fontFamily: active ? "WybixSemi" : "Wybix" }]} numberOfLines={1}>
              {cortos[index] ?? descriptors[route.key].options.title}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
const cortos = ["Vender", "Turno", "Inventario", "Estado"];
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
      <Tabs.Screen name="turno" options={{ title: "Turno y corte" }} />
      <Tabs.Screen name="inventario" options={{ title: "Inventario" }} />
      <Tabs.Screen name="sincronia" options={{ title: "Estado" }} />
    </Tabs>
  );
}
