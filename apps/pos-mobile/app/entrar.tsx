/**
 * ¿Quién está en la caja? Persona asignada al evento + su PIN, sin Internet.
 * Diseño B «pantalla de bloqueo»: las personas en círculos, el PIN debajo y
 * la barra oscura de Vender abajo con el evento, la sincronización y Entrar.
 */
import { useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, Image, Pressable, StyleSheet, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { identificar, personal } from "@wybix/database";
import { ETIQUETA_ROL, type RolEvento } from "@wybix/domain";
import {
  Pulse,
  Aviso,
  Boton,
  Puntos,
  Teclado,
  teclear,
  logoDeMarca,
  pos as t,
  tipo,
} from "../components/ui";
import { usePos } from "../lib/contexto";
import { Avatar } from "../components/Avatar";

function iniciales(nombre: string, n = 2) {
  const p = nombre.split(/\s+/).map((x) => x.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  return p.slice(0, n).map((x) => x[0]).join("").toUpperCase() || "?";
}
function hora(d: Date) {
  return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

export default function Entrar() {
  const { width, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compacto = width < 700 || fontScale > 1.3;
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const { db, identidad, entrar, sync, sincronizar, negocio } = usePos();
  const router = useRouter();
  const [lista, setLista] = useState<Array<{ uuid: string; name: string; role: RolEvento }>>([]);
  const [elegido, setElegido] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ahora, setAhora] = useState(() => new Date());

  useEffect(() => {
    if (db) personal(db).then(setLista);
  }, [db, sync.ultima_sincronizacion]);
  useEffect(() => {
    const id = setInterval(() => setAhora(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const confirmar = async () => {
    if (!db || !elegido || pin.length < 4 || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const r = await identificar(db, elegido, pin);
      setPin("");
      if (!r.ok) {
        setError(r.error);
        return;
      }
      entrar(r.persona);
      router.replace("/caja/vender");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const persona = lista.find((p) => p.uuid === elegido);
  const nombreNegocio = negocio ?? "Wybix";
  const logo = logoDeMarca();
  const evento = `${identidad?.location_name ?? "Evento"} · Caja ${identidad?.register.code ?? ""}`;
  const colorSync = sync.revocado
    ? t.peligro
    : !sync.en_linea || sync.pendientes || sync.rechazados + sync.cuarentena
      ? "#E0A43A"
      : "#4CC38A";
  const avatar = compacto ? 64 : 84;

  return (
    <View style={{ flex: 1, backgroundColor: t.fondo }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + (compacto ? 16 : 22),
          paddingHorizontal: compacto ? 16 : 32,
          paddingBottom: 24,
          gap: compacto ? 20 : 24,
        }}
      >
        {/* Negocio y hora */}
        <View style={s.cabecera}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexShrink: 1 }}>
            {logo ? (
              <View style={[s.insignia, { backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: t.borde }]}>
                <Image source={{ uri: logo }} style={{ width: 32, height: 32 }} resizeMode="contain" accessibilityLabel={nombreNegocio} />
              </View>
            ) : (
              <View style={[s.insignia, { backgroundColor: t.acento }]} accessibilityElementsHidden>
                <Text style={[tipo.subtitulo, { fontSize: 14, color: t.acentoTexto }]}>{iniciales(nombreNegocio)}</Text>
              </View>
            )}
            <View style={{ flexShrink: 1 }}>
              <Text style={[tipo.subtitulo, { fontSize: 16 }]} numberOfLines={1}>{nombreNegocio}</Text>
              <Text style={tipo.tenue} numberOfLines={1}>con Wybix POS Mobile</Text>
            </View>
          </View>
          <Text style={[tipo.numero, { color: t.tenue, fontSize: 16 }]}>{hora(ahora)}</Text>
        </View>

        <View style={{ alignItems: "center", gap: compacto ? 18 : 22 }}>
          <View style={{ alignItems: "center", gap: 6 }}>
            <Text accessibilityRole="header" style={[tipo.titulo, { fontSize: compacto ? 28 : 34, textAlign: "center" }]}>
              ¿Quién atiende?
            </Text>
            {/* El error ocupa el lugar de la instrucción: queda a la vista sin mover el teclado. */}
            <Text
              accessibilityLiveRegion={error ? "assertive" : "polite"}
              style={[tipo.tenue, { fontSize: 14, textAlign: "center" }, error ? { color: t.peligro, fontFamily: "WybixSemi" } : null]}
            >
              {error ?? (persona ? `Escribe tu PIN, ${persona.name}.` : "Toca tu nombre para escribir tu PIN.")}
            </Text>
          </View>

          {/* Personal del evento */}
          {lista.length ? (
            <View style={[s.gente, { gap: compacto ? 14 : 22 }]}>
              {lista.map((p) => {
                const sel = elegido === p.uuid;
                return (
                  <Pulse
                    key={p.uuid}
                    disabled={busy}
                    testID={`persona-${p.name}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${p.name}, ${ETIQUETA_ROL[p.role] ?? p.role}`}
                    accessibilityState={{ selected: sel, disabled: busy }}
                    onPress={() => {
                      setElegido(p.uuid);
                      setPin("");
                      setError(null);
                    }}
                    style={[s.persona, { width: avatar + 32, opacity: elegido && !sel ? 0.55 : 1 }]}
                  >
                    <View
                      style={[
                        s.avatar,
                        {
                          width: avatar,
                          height: avatar,
                          borderRadius: avatar / 2,
                          borderColor: sel ? t.acento : "transparent",
                        },
                      ]}
                    >
                      {/* La cara sale del uuid de la persona: la misma en cada pantalla. */}
                      <Avatar uuid={p.uuid} nombre={p.name} size={avatar - 10} />
                    </View>
                    <Text style={[tipo.subtitulo, { fontSize: 15, textAlign: "center" }]} numberOfLines={1}>{p.name}</Text>
                    <Text style={[tipo.tenue, { fontSize: 12, textAlign: "center", marginTop: -4 }]} numberOfLines={1}>
                      {ETIQUETA_ROL[p.role] ?? p.role}
                    </Text>
                  </Pulse>
                );
              })}
            </View>
          ) : (
            <View style={{ width: "100%", maxWidth: 560 }}>
              <Aviso texto="Nadie está asignado a este evento todavía. El administrador asigna al personal en Wybix Owner y la tablet lo recibe al sincronizar." />
            </View>
          )}

          {/* PIN */}
          <View style={{ width: "100%", maxWidth: compacto ? 420 : 380, gap: 8, opacity: persona ? 1 : 0.45 }}>
            <Puntos n={pin.length} />
            <Teclado
              disabled={busy || !persona}
              extra={null}
              alto={compacto ? 56 : 60}
              alPulsar={(k) => {
                setError(null);
                setPin((v) => teclear(v, k, 8));
              }}
            />
          </View>
        </View>
      </ScrollView>

      {/* Barra: evento, sincronización y Entrar (como la cuenta en Vender) */}
      <View
        style={[
          s.barra,
          {
            marginHorizontal: compacto ? 12 : 20,
            marginBottom: insets.bottom + (compacto ? 10 : 20),
            paddingLeft: compacto ? 16 : 22,
          },
        ]}
      >
        <View style={{ flex: 1, minWidth: 0, flexDirection: compacto ? "column" : "row", alignItems: compacto ? "stretch" : "center", gap: compacto ? 2 : 24 }}>
          <View style={{ flexShrink: 1 }}>
            {!compacto && <Text style={[tipo.tenue, { color: "#9FB0C3", fontSize: 12 }]}>Evento</Text>}
            <Text style={[tipo.subtitulo, { color: "#FFFFFF", fontSize: compacto ? 14 : 15 }]} numberOfLines={1}>{evento}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${sync.texto}. Sincronizar ahora`}
            onPress={sincronizar}
            style={s.sync}
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colorSync }} />
            <Text style={[tipo.tenue, { color: "#C9D4E0", flexShrink: 1 }]} numberOfLines={1}>{sync.texto}</Text>
          </Pressable>
        </View>
        <Boton
          testID="entrar"
          titulo={persona && !compacto ? `Entrar como ${persona.name}` : "Entrar"}
          textoCargando="Verificando…"
          cargando={busy}
          onPress={confirmar}
          deshabilitado={!persona || pin.length < 4}
          estilo={{ minWidth: compacto ? 120 : 220, minHeight: 52, borderRadius: 14 }}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  cabecera: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 16 },
  insignia: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  gente: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", maxWidth: 900 },
  persona: { alignItems: "center", gap: 8, paddingVertical: 4, borderRadius: 16 },
  avatar: { alignItems: "center", justifyContent: "center", borderWidth: 3 },
  barra: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderRadius: 20,
    paddingVertical: 10,
    paddingRight: 10,
    backgroundColor: t.navy,
  },
  sync: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, flexShrink: 1 },
});
