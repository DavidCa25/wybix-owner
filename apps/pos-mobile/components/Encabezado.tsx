import {
  View,
  Text,
  StyleSheet,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { BarraSync, Marca, pos as t, tipo } from "./ui";
import { usePos } from "../lib/contexto";
export function Encabezado({ titulo }: { titulo: string }) {
  const { identidad, persona, sync, sincronizar, salir } = usePos();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const compact = width < 680 || fontScale > 1.3;
  return (
    <View
      style={[
        s.barra,
        {
          paddingTop: insets.top + 12,
          paddingLeft: Math.max(insets.left, 20),
          paddingRight: Math.max(insets.right, 20),
        },
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 24 }}>
        {width >= 1000 && <Marca />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            accessibilityRole="header"
            style={[tipo.subtitulo, { color: "#fff", fontSize: 20 }]}
          >
            {titulo}
          </Text>
          <Text style={[tipo.tenue, { color: "#ABC2D0" }]} numberOfLines={1}>
            {identidad?.location_name} · Caja {identidad?.register.code}
          </Text>
        </View>
        {!compact && (
          <BarraSync
            texto={sync.texto}
            pendientes={sync.pendientes}
            enLinea={sync.en_linea}
            revocado={sync.revocado}
            enRevision={sync.rechazados + sync.cuarentena}
            onPress={sincronizar}
          />
        )}
        {persona && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Cambiar de persona: ${persona.name}`}
            onPress={() => {
              salir();
              router.replace("/entrar");
            }}
            style={s.persona}
          >
            <View style={s.avatar}>
              <Text style={[tipo.subtitulo, { color: t.navy }]}>
                {persona.name.slice(0, 1).toUpperCase()}
              </Text>
            </View>
            {!compact && (
              <View>
                <Text
                  style={[tipo.cuerpo, { color: "#fff" }]}
                  numberOfLines={1}
                >
                  {persona.name}
                </Text>
                <Text style={[tipo.tenue, { color: "#ABC2D0" }]}>Salir</Text>
              </View>
            )}
          </Pressable>
        )}
      </View>
      {compact && (
        <BarraSync
          texto={sync.texto}
          pendientes={sync.pendientes}
          enLinea={sync.en_linea}
          revocado={sync.revocado}
          enRevision={sync.rechazados + sync.cuarentena}
          onPress={sincronizar}
        />
      )}
    </View>
  );
}
const s = StyleSheet.create({
  barra: { gap: 10, paddingBottom: 14, backgroundColor: t.navy },
  persona: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    minHeight: 48,
    maxWidth: 180,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#B5D9E2",
    alignItems: "center",
    justifyContent: "center",
  },
});
