import { Text, View, useWindowDimensions } from "react-native";
import { Redirect, Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Pulse, pos as t, tipo } from "../../components/ui";
import { usePos } from "../../lib/contexto";
const icons = [
  "cart-outline",
  "cash-outline",
  "cube-outline",
  "cloud-done-outline",
] as const;
function Navigation({ state, descriptors, navigation }: BottomTabBarProps) {
  const { width, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const rail = width >= 1000 && fontScale <= 1.3;
  return (
    <View
      style={{
        backgroundColor: t.navy,
        width: rail ? 108 + insets.left : undefined,
        paddingLeft: rail ? insets.left + 10 : insets.left + 6,
        paddingRight: rail ? 10 : insets.right + 6,
        paddingTop: rail ? insets.top + 104 : 8,
        paddingBottom: insets.bottom + 8,
        gap: 8,
        flexDirection: rail ? "column" : "row",
      }}
    >
      {state.routes.map((route, index) => {
        const active = state.index === index;
        return (
          <View key={route.key} style={{ flex: rail ? undefined : 1 }}>
            <Pulse
              active={active}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={descriptors[route.key].options.title}
              onPress={() => {
                const event = navigation.emit({
                  type: "tabPress",
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!active && !event.defaultPrevented)
                  navigation.navigate(route.name, route.params);
              }}
              onLongPress={() =>
                navigation.emit({ type: "tabLongPress", target: route.key })
              }
              style={{
                minHeight: rail ? 78 : 56,
                borderRadius: 16,
                alignItems: "center",
                justifyContent: "center",
                padding: 7,
                gap: 5,
                backgroundColor: "transparent",
              }}
            >
              <Ionicons
                name={icons[index]}
                size={23}
                color={active ? t.navy : "#C1D3DE"}
              />
              <Text
                style={[
                  tipo.tenue,
                  {
                    color: active ? t.navy : "#C1D3DE",
                    fontSize: 11,
                    textAlign: "center",
                    fontFamily: active ? "WybixSemi" : "Wybix",
                  },
                ]}
              >
                {descriptors[route.key].options.title}
              </Text>
            </Pulse>
          </View>
        );
      })}
    </View>
  );
}
export default function CajaLayout() {
  const { persona, fase } = usePos();
  const { width, fontScale } = useWindowDimensions();
  if (fase !== "listo") return <Redirect href="/" />;
  if (!persona) return <Redirect href="/entrar" />;
  return (
    <Tabs
      tabBar={(props) => <Navigation {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarPosition: width >= 1000 && fontScale <= 1.3 ? "left" : "bottom",
      }}
    >
      <Tabs.Screen name="vender" options={{ title: "Vender" }} />
      <Tabs.Screen name="turno" options={{ title: "Turno y corte" }} />
      <Tabs.Screen name="inventario" options={{ title: "Inventario" }} />
      <Tabs.Screen name="sincronia" options={{ title: "Estado" }} />
    </Tabs>
  );
}
