/**
 * EMPAREJAR ESTA TABLET. Dos maneras de vender, la misma pantalla de venta:
 *
 *   CAJA DE LA SUCURSAL (POS 0094)  una caja más del local. Se escanea el QR
 *       de la computadora principal (Configuración › Dispositivos locales ›
 *       Conectar dispositivo › Caja móvil). Vende con el mismo inventario,
 *       precios y corte, por la red del local. No hace falta registrar un evento.
 *
 *   EVENTO  feria, expo o punto temporal. El código lo genera Owner dentro del
 *       evento; sincroniza con la nube y lleva su propio inventario.
 *
 * Diseño B (Claude Design): fondo navy con puntos, la marca arriba y una
 * tarjeta blanca al centro con la mascota asomada por encima. Un selector
 * segmentado cambia entre los dos modos sin mover la tarjeta.
 *
 * La tablet guarda SU credencial (SecureStore). Sin QR o código no hay manera
 * de entrar a una empresa.
 */
import { useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Defs, Pattern, Circle, Rect } from "react-native-svg";
import { leerQrLocalHost } from "@wybix/api";
import { Aviso, Boton, Marca, pos as t, tipo } from "../components/ui";
import { usePos } from "../lib/contexto";
import { Escaner } from "../components/Escaner";
import { Guide } from "@wybix/ui";

type Modo = "SUCURSAL" | "EVENTO";

/** Puntos tenues del fondo, igual que la caja de escritorio. */
function Puntos() {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Defs>
        <Pattern id="puntos" width="22" height="22" patternUnits="userSpaceOnUse">
          <Circle cx="1" cy="1" r="1" fill="rgba(255,255,255,0.07)" />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#puntos)" />
    </Svg>
  );
}

export default function Enrolar() {
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const ancho = width >= 800 && fontScale <= 1.3;
  const compacto = width < 560 || fontScale > 1.3;
  const lock = useRef(false);
  const { enrolar, enrolarSucursal } = usePos();
  const router = useRouter();
  const [modo, setModo] = useState<Modo>("SUCURSAL");
  const [codigo, setCodigo] = useState("");
  const [direccion, setDireccion] = useState("");
  const [pegar, setPegar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [escanear, setEscanear] = useState(false);

  const correr = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setCargando(true);
    setError(null);
    try {
      await fn();
      router.replace("/entrar");
    } catch (e) {
      setError((e as Error).message || "No se pudo emparejar.");
    } finally {
      lock.current = false;
      setCargando(false);
    }
  };
  const enviarEvento = (c = codigo) => correr(() => enrolar(c));
  const enviarSucursal = (qr: string) => correr(() => enrolarSucursal(qr));

  const mascota = ancho ? 132 : 104;
  const segmento = (m: Modo, titulo: string, icono: keyof typeof Ionicons.glyphMap) => {
    const on = modo === m;
    return (
      <Pressable
        testID={`modo-${m}`}
        accessibilityRole="radio"
        accessibilityState={{ checked: on }}
        accessibilityLabel={titulo}
        onPress={() => { setModo(m); setError(null); }}
        style={[s.segmento, on && s.segmentoOn]}
      >
        <Ionicons name={icono} size={20} color={on ? t.fondo : t.tenue} />
        <Text numberOfLines={1} style={[s.segmentoTexto, { color: on ? t.fondo : t.tenue }]}>{titulo}</Text>
      </Pressable>
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.fondo }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Puntos />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + (ancho ? 30 : 18),
          paddingBottom: insets.bottom + 20,
          paddingHorizontal: ancho ? 40 : 16,
          alignItems: "center",
        }}
      >
        <View style={s.cabeza}>
          <Marca />
          {!compacto && <Text style={s.ayuda}>¿Necesitas ayuda? wybix.mx/ayuda</Text>}
        </View>

        <View style={{ width: "100%", maxWidth: 720, marginTop: mascota * 0.65 + (ancho ? 40 : 24) }}>
          <View style={[s.asomada, { top: -mascota * 0.65, marginLeft: -mascota / 2 }]} pointerEvents="none">
            <Guide size={mascota} movimiento="asoma" cara={error ? "error" : cargando ? "atencion" : "reposo"} />
          </View>
          <View style={[s.tarjeta, { paddingTop: mascota * 0.5, paddingHorizontal: ancho ? 44 : 18, paddingBottom: ancho ? 36 : 22 }]}>
            <View style={{ alignItems: "center", gap: 6 }}>
              <Text accessibilityRole="header" style={[s.titulo, { fontSize: ancho ? 30 : 24 }]}>
                Conecta esta {ancho ? "tablet" : "caja"}
              </Text>
              <Text style={[tipo.cuerpo, { color: t.tenue, textAlign: "center" }]}>
                Soy Wybix Guide. En un minuto queda lista para vender.
              </Text>
            </View>

            <View accessibilityRole="radiogroup" accessibilityLabel="Dónde vende" style={s.selector}>
              {segmento("SUCURSAL", compacto ? "Sucursal" : "Caja de la sucursal", "storefront-outline")}
              {segmento("EVENTO", "Evento", "flag-outline")}
            </View>

            {modo === "SUCURSAL" ? (
              <View style={{ flexDirection: compacto ? "column" : "row", gap: compacto ? 14 : 20, alignItems: compacto ? "stretch" : "center" }}>
                <View style={[s.qr, compacto ? { width: "100%", height: 96 } : { width: 150, height: 150 }]}>
                  <Ionicons name="qr-code-outline" size={compacto ? 48 : 70} color={t.wybix} />
                </View>
                <View style={{ flex: compacto ? undefined : 1, gap: 10 }}>
                  <Text style={tipo.subtitulo}>Escanea el QR de la computadora principal</Text>
                  <Text style={[tipo.cuerpo, { fontSize: 14, lineHeight: 22, color: t.tenue }]}>
                    En la computadora: Configuración › Dispositivos locales › Conectar dispositivo ›{" "}
                    <Text style={{ fontFamily: "WybixSemi" }}>Caja móvil</Text>. Mismo Wi-Fi.
                  </Text>
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    <Boton
                      testID="escanear-sucursal"
                      titulo="Abrir cámara"
                      onPress={() => setEscanear(true)}
                      deshabilitado={cargando}
                      cargando={cargando}
                      textoCargando="Emparejando…"
                      estilo={{ flex: 1 }}
                    />
                    <Boton
                      testID="pegar-direccion"
                      titulo="Pegar dirección"
                      variante="secundario"
                      onPress={() => setPegar((v) => !v)}
                      deshabilitado={cargando}
                    />
                  </View>
                  {pegar && (
                    <View style={{ gap: 10 }}>
                      <TextInput
                        testID="direccion-local-host"
                        value={direccion}
                        onChangeText={setDireccion}
                        placeholder="http://192.168.1.20:7427/pair/…"
                        placeholderTextColor={t.tenue}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoFocus
                        editable={!cargando}
                        style={[s.input, { fontSize: 15, letterSpacing: 0, textAlign: "left", fontFamily: "Wybix" }]}
                        accessibilityLabel="Dirección que aparece bajo el QR de la computadora principal"
                      />
                      <Boton
                        testID="emparejar-sucursal"
                        titulo="Emparejar"
                        variante="secundario"
                        onPress={() => enviarSucursal(direccion.trim())}
                        deshabilitado={cargando || !leerQrLocalHost(direccion)}
                      />
                    </View>
                  )}
                </View>
              </View>
            ) : (
              <View style={{ gap: 10 }}>
                <Text nativeID="etiqueta-codigo" style={tipo.subtitulo}>Código de Wybix Owner</Text>
                <Text style={[tipo.cuerpo, { fontSize: 14, color: t.tenue }]}>
                  Eventos › el evento › Tablets › Agregar tablet. Necesita Internet.
                </Text>
                <View style={{ flexDirection: compacto ? "column" : "row", gap: 10 }}>
                  <TextInput
                    testID="codigo"
                    value={codigo}
                    onChangeText={(v) => setCodigo(v.toUpperCase())}
                    placeholder="XXXX-XXXX-XXXX"
                    placeholderTextColor={t.tenue}
                    editable={!cargando}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={14}
                    style={[s.input, { flex: compacto ? undefined : 1, borderColor: t.wybix, borderWidth: 2 }]}
                    accessibilityLabel="Código de enrolamiento"
                    accessibilityLabelledBy="etiqueta-codigo"
                  />
                  <Boton
                    testID="enrolar"
                    titulo="Conectar"
                    textoCargando="Vinculando…"
                    onPress={() => enviarEvento()}
                    cargando={cargando}
                    deshabilitado={codigo.replace(/[^A-Z0-9]/g, "").length !== 12}
                    estilo={compacto ? undefined : { paddingHorizontal: 24 }}
                  />
                </View>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setEscanear(true)}
                  disabled={cargando}
                  style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, minHeight: t.tactil }}
                >
                  <Ionicons name="qr-code-outline" size={18} color={t.acentoTinta} />
                  <Text style={[tipo.cuerpo, { color: t.acentoTinta, fontFamily: "WybixSemi" }]}>Escanear el QR del código</Text>
                </Pressable>
              </View>
            )}
            {error && <Aviso tono="peligro" texto={error} />}
          </View>
        </View>

        <View style={[s.pie, { flexDirection: compacto ? "column" : "row" }]}>
          <Text style={s.pieTexto}>Vende sin Internet: todo se guarda cifrado en la {ancho ? "tablet" : "caja"}</Text>
          {!compacto && <Text style={s.pieTexto}>·</Text>}
          <Text style={s.pieTexto}>Cada persona entra con su PIN</Text>
        </View>
      </ScrollView>
      <Escaner
        visible={escanear}
        titulo={modo === "SUCURSAL" ? "Escanea el QR de la computadora principal" : "Escanea el QR de enrolamiento"}
        alCerrar={() => setEscanear(false)}
        alLeer={(d) => {
          setEscanear(false);
          // Un QR de Local Host empareja como caja de sucursal aunque se haya elegido evento.
          if (leerQrLocalHost(d)) { setModo("SUCURSAL"); void enviarSucursal(d); return; }
          const c = (d.match(/[A-Z0-9]{4}-?[A-Z0-9]{4}-?[A-Z0-9]{4}/i)?.[0] ?? d).toUpperCase();
          setModo("EVENTO");
          setCodigo(c);
          void enviarEvento(c);
        }}
      />
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  cabeza: { width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16 },
  ayuda: { fontFamily: "Wybix", fontSize: 13, color: "#7D8DA1" },
  asomada: { position: "absolute", left: "50%", zIndex: 0 },
  tarjeta: {
    zIndex: 1,
    backgroundColor: t.superficie,
    borderWidth: 1,
    borderColor: t.borde,
    borderRadius: 30,
    gap: 22,
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 35,
    shadowOffset: { width: 0, height: 30 },
    elevation: 12,
  },
  titulo: { fontFamily: "WybixSemi", color: t.texto, letterSpacing: -0.7, textAlign: "center" },
  selector: { flexDirection: "row", gap: 6, backgroundColor: t.fondo, borderRadius: 18, padding: 6 },
  segmento: {
    flex: 1,
    minHeight: 54,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 8,
  },
  segmentoOn: {
    backgroundColor: t.texto,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  segmentoTexto: { fontFamily: "WybixSemi", fontSize: 15 },
  qr: { borderRadius: 22, backgroundColor: t.fondo, borderWidth: 1, borderColor: t.borde, alignItems: "center", justifyContent: "center" },
  input: {
    borderWidth: 1.5,
    borderColor: t.bordeFuerte,
    borderRadius: 16,
    paddingHorizontal: 16,
    minHeight: 56,
    fontSize: 22,
    letterSpacing: 2.5,
    textAlign: "center",
    color: t.texto,
    backgroundColor: t.fondo,
    fontFamily: "WybixMono",
    fontVariant: ["tabular-nums"],
  },
  pie: { marginTop: "auto", paddingTop: 28, alignItems: "center", justifyContent: "center", gap: 6, columnGap: 22 },
  pieTexto: { fontFamily: "Wybix", fontSize: 13, color: "#7D8DA1", textAlign: "center" },
});
