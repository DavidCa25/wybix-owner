/**
 * MARCO de las pantallas de la caja (diseño Fusión, el mismo de Vender).
 * Tablet: columna con el negocio, las secciones, el estado de red y la
 * persona; a la derecha, el título y el contenido. Celular: cabecera clara
 * con lo mismo y la barra inferior de secciones (la pone el layout).
 */
import type { ReactNode } from "react";
import { View, Text, Image, Pressable, StyleSheet, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { logoDeMarca, pos as t, tipo } from "./ui";
import { usePos } from "../lib/contexto";

export type Seccion = "vender" | "turno" | "inventario" | "sincronia";
const SECCIONES: Array<{ id: Seccion; titulo: string; icono: keyof typeof Ionicons.glyphMap }> = [
  { id: "vender", titulo: "Vender", icono: "cart-outline" },
  { id: "turno", titulo: "Turno y corte", icono: "cash-outline" },
  { id: "inventario", titulo: "Inventario", icono: "cube-outline" },
  { id: "sincronia", titulo: "Estado", icono: "cloud-done-outline" },
];

/** Mismo corte que Vender: desde aquí cada pantalla lleva su columna y no hay barra de secciones. */
export function useAncho() {
  const { width, fontScale } = useWindowDimensions();
  return width >= 850 && fontScale <= 1.3;
}

export function iniciales(nombre: string) {
  const p = nombre.split(/\s+/).map((x) => x.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "W";
}

export function Marco({
  seccion,
  titulo,
  derecha,
  children,
}: {
  seccion: Seccion;
  titulo: string;
  /** Lo que va junto al título (p. ej. el estado del turno). */
  derecha?: ReactNode;
  children: ReactNode;
}) {
  const ancho = useAncho();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { identidad, persona, sync, sincronizar, salir, negocio } = usePos();
  const logo = logoDeMarca();
  const nombreNegocio = negocio ?? identidad?.location_name ?? "Wybix";
  const lugar = `${identidad?.location_name ?? ""} · Caja ${identidad?.register.code ?? ""}`;
  const red = sync.revocado
    ? { texto: "Tablet dada de baja", color: t.peligro }
    : sync.en_linea
      ? { texto: sync.pendientes ? `Enviando ${sync.pendientes}` : "Al día", color: t.exito }
      : { texto: `Sin red · ${sync.pendientes}${ancho ? " por enviar" : ""}`, color: t.aviso };
  const cambiarPersona = () => { salir(); router.replace("/entrar"); };

  const insignia = logo ? (
    <View style={[s.insignia, { backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: t.borde }]}>
      <Image source={{ uri: logo }} style={{ width: 32, height: 32 }} resizeMode="contain" accessibilityLabel={nombreNegocio} />
    </View>
  ) : (
    <View style={[s.insignia, { backgroundColor: t.acento }]} accessibilityElementsHidden>
      <Text style={[tipo.subtitulo, { fontSize: 13, color: t.acentoTexto }]}>{iniciales(nombreNegocio)}</Text>
    </View>
  );
  const chipRed = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${red.texto}. Sincronizar ahora`}
      onPress={sincronizar}
      style={ancho ? s.redTablet : s.redCel}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: red.color }} />
      <Text style={[tipo.tenue, { fontSize: ancho ? 13 : 12, flexShrink: 1 }]} numberOfLines={1}>{red.texto}</Text>
    </Pressable>
  );
  const inicial = (persona?.name ?? "?").slice(0, 1).toUpperCase();

  if (!ancho)
    return (
      <View style={{ flex: 1, backgroundColor: t.fondo, paddingTop: insets.top }}>
        <View style={s.cabeceraCel}>
          {insignia}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text accessibilityRole="header" style={[tipo.subtitulo, { fontSize: 17 }]} numberOfLines={1}>{titulo}</Text>
            <Text style={[tipo.tenue, { fontSize: 11 }]} numberOfLines={1}>{lugar}</Text>
          </View>
          {chipRed}
          <Pressable accessibilityRole="button" accessibilityLabel={`Cambiar de persona: ${persona?.name ?? ""}`} onPress={cambiarPersona} style={s.personaCel}>
            <Text style={[tipo.subtitulo, { fontSize: 16 }]}>{inicial}</Text>
          </Pressable>
        </View>
        {derecha && <View style={{ paddingHorizontal: 16, paddingBottom: 8, alignItems: "flex-start" }}>{derecha}</View>}
        <View style={{ flex: 1 }}>{children}</View>
      </View>
    );

  return (
    <View style={{ flex: 1, flexDirection: "row", gap: 16, padding: 16, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16, backgroundColor: t.fondo }}>
      <View style={{ width: 210, gap: 10 }}>
        <View style={s.tarjetaNegocio}>
          {insignia}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[tipo.subtitulo, { fontSize: 15 }]} numberOfLines={1}>{nombreNegocio}</Text>
            <Text style={[tipo.tenue, { fontSize: 11 }]} numberOfLines={1}>{lugar}</Text>
          </View>
        </View>
        <View accessibilityRole="tablist" style={{ gap: 10 }}>
          {SECCIONES.map((x) => {
            const on = x.id === seccion;
            return (
              <Pressable
                key={x.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={x.titulo}
                onPress={() => { if (!on) router.navigate(`/caja/${x.id}`); }}
                style={[s.seccion, on && { backgroundColor: t.acento, borderColor: t.acento }]}
              >
                <Ionicons name={x.icono} size={19} color={on ? t.acentoTexto : t.tenue} />
                <Text style={[tipo.subtitulo, { fontSize: 15, color: on ? t.acentoTexto : t.texto }]} numberOfLines={1}>{x.titulo}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={{ flex: 1 }} />
        {chipRed}
        <Pressable accessibilityRole="button" accessibilityLabel={`Cambiar de persona: ${persona?.name ?? ""}`} onPress={cambiarPersona} style={s.persona}>
          <View style={s.avatar}><Text style={[tipo.subtitulo, { fontSize: 14 }]}>{inicial}</Text></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[tipo.subtitulo, { fontSize: 14 }]} numberOfLines={1}>{persona?.name}</Text>
            <Text style={[tipo.tenue, { fontSize: 11 }]}>Cambiar de persona</Text>
          </View>
        </Pressable>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 14 }}>
        <View style={s.cabecera}>
          <Text accessibilityRole="header" style={[tipo.titulo, { flex: 1, fontSize: 30, letterSpacing: -0.8 }]} numberOfLines={1}>{titulo}</Text>
          {derecha}
        </View>
        <View style={{ flex: 1 }}>{children}</View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  insignia: { width: 38, height: 38, borderRadius: 11, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  tarjetaNegocio: {
    minHeight: 64, borderRadius: 20, backgroundColor: t.superficie, borderWidth: 1, borderColor: t.borde,
    flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12,
  },
  seccion: {
    minHeight: 56, borderRadius: 18, borderWidth: 1, borderColor: t.borde, backgroundColor: t.superficie,
    flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16,
  },
  redTablet: {
    minHeight: 52, borderRadius: 16, backgroundColor: t.superficie, borderWidth: 1, borderColor: t.borde,
    flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14,
  },
  redCel: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, maxWidth: 120 },
  persona: {
    minHeight: 56, borderRadius: 16, backgroundColor: t.superficie, borderWidth: 1, borderColor: t.borde,
    flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10,
  },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: t.hundido, alignItems: "center", justifyContent: "center" },
  personaCel: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: t.superficie, borderWidth: 1, borderColor: t.borde,
    alignItems: "center", justifyContent: "center",
  },
  cabeceraCel: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12 },
  cabecera: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56 },
});
