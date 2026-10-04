import { Redirect } from "expo-router";
import { View, Text, ActivityIndicator } from "react-native";
import { Aviso, Boton, pos as t, tipo } from "../components/ui";
import { usePos } from "../lib/contexto";

export default function Inicio() {
  const { fase, error, persona, recargar } = usePos();
  if (fase === "cargando") {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: t.navy,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={t.acento} size="large" />
      </View>
    );
  }
  if (fase === "error") {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: t.navy,
          padding: 24,
          justifyContent: "center",
          gap: 16,
        }}
      >
        <Text style={[tipo.titulo, { color: "#fff" }]}>
          No se pudo abrir la base de la tablet
        </Text>
        <Aviso tono="peligro" texto={error ?? "Error desconocido."} />
        <Boton titulo="Reintentar" onPress={recargar} />
      </View>
    );
  }
  if (fase === "sin_enrolar") return <Redirect href="/enrolar" />;
  return <Redirect href={persona ? "/caja/vender" : "/entrar"} />;
}
