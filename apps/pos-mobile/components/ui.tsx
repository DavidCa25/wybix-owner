import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { mezclar, temaDeMarca, type TemaMarca } from "@wybix/domain";
export { dinero } from "@wybix/ui";

export { teclear } from "../lib/entrada";
/*
 * Tokens alineados con el POS de escritorio (filtros_lubs_rios/src/styles/
 * tokens.css): lienzo, superficies, barra oscura y tinta. El ACENTO es el de
 * la marca del negocio cuando la configura en Wybix Owner (llega con el
 * snapshot); @wybix/domain · temaDeMarca garantiza que todo se lea.
 */
let tema: TemaMarca = temaDeMarca(null);
let logoMarca: string | null = null;
/** Lo llama el contexto al leer la base y tras cada sincronización. */
export function aplicarMarca(m: { color: string | null; logo: string | null } | null) {
  tema = temaDeMarca(m?.color ?? null);
  logoMarca = m?.logo ?? null;
}
export const logoDeMarca = () => logoMarca;
export const pos = {
  fondo: "#F2F5F9",
  superficie: "#FFFFFF",
  hundido: "#EDF1F6",
  borde: "#E1E7EF",
  texto: "#16212E",
  tenue: "#55677A",
  /** Botones principales y elementos elegidos. */
  get acento() { return tema.acento; },
  /** Texto sobre el acento. */
  get acentoTexto() { return tema.acentoTexto; },
  /** El acento como TEXTO sobre blanco. */
  get acentoTinta() { return tema.acentoTinta; },
  /** Fondo de una opción elegida (texto oscuro encima). */
  get cian() { return tema.seleccion; },
  /** Fondo muy tenue de la marca (tarjeta elegida). */
  get acentoSuave() { return mezclar(tema.acento, "#FFFFFF", 0.92); },
  /** Punto de la marca Wybix: siempre cian, no cambia con el negocio. */
  wybix: "#45B3C3",
  navy: "#0F1826",
  exito: "#167047",
  aviso: "#865000",
  peligro: "#B52E29",
  peligroSuave: "#FBECEA",
  avisoSuave: "#FFF3DD",
  exitoSuave: "#E6F4EC",
  radio: 12,
  tactil: 48,
};
export const tipo = StyleSheet.create({
  titulo: { fontFamily: "WybixSemi", fontSize: 26, color: pos.texto },
  subtitulo: { fontFamily: "WybixSemi", fontSize: 17, color: pos.texto },
  cuerpo: { fontFamily: "Wybix", fontSize: 15, color: pos.texto },
  tenue: { fontFamily: "Wybix", fontSize: 13, color: pos.tenue },
  numero: {
    fontFamily: "WybixMono",
    fontSize: 17,
    fontVariant: ["tabular-nums"],
    color: pos.texto,
  },
  etiqueta: {
    fontFamily: "WybixSemi",
    fontSize: 11,
    letterSpacing: 1,
    color: pos.tenue,
  },
});
const Reduced = createContext(true);
export function MotionProvider({ children }: { children: ReactNode }) {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (active) setReduced(v);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced,
    );
    return () => {
      active = false;
      sub.remove();
    };
  }, []);
  return <Reduced.Provider value={reduced}>{children}</Reduced.Provider>;
}
export const useReducedMotion = () => useContext(Reduced);
/** Only the touched control moves; no JS layout animation or ambient loop. */
export function Pulse({
  children,
  style,
  active,
  selectionColor = pos.cian,
  ...props
}: Omit<PressableProps, "style"> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  active?: boolean;
  selectionColor?: string;
}) {
  const value = useRef(new Animated.Value(1)).current;
  const reduced = useReducedMotion();
  const selection = useRef(new Animated.Value(active ? 1 : 0)).current;
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current === active) return;
    wasActive.current = active;
    Animated.timing(selection, {
      toValue: active ? 1 : 0,
      duration: reduced ? 0 : 190,
      useNativeDriver: true,
    }).start();
  }, [active, selection, reduced]);
  const move = (toValue: number) => {
    value.stopAnimation();
    Animated.timing(value, {
      toValue,
      duration: reduced ? 0 : toValue === 1 ? 140 : 100,
      useNativeDriver: true,
      easing: Easing.out(Easing.cubic),
    }).start();
  };
  return (
    <Animated.View
      style={{
        transform: [{ scale: value }],
        flex: StyleSheet.flatten(style)?.flex,
        width: StyleSheet.flatten(style)?.width,
        minHeight: StyleSheet.flatten(style)?.minHeight,
        minWidth: StyleSheet.flatten(style)?.minWidth,
        height: StyleSheet.flatten(style)?.height,
      }}
    >
      <Pressable
        {...props}
        style={[style, { flex: undefined }]}
        onPressIn={(e) => {
          move(0.98);
          props.onPressIn?.(e);
        }}
        onPressOut={(e) => {
          move(1);
          props.onPressOut?.(e);
        }}
      >
        {active !== undefined && (
          <Animated.View
            pointerEvents="none"
            style={{
              ...StyleSheet.absoluteFillObject,
              borderRadius: StyleSheet.flatten(style)?.borderRadius ?? 12,
              backgroundColor: selectionColor,
              opacity: selection,
            }}
          />
        )}
        {children}
      </Pressable>
    </Animated.View>
  );
}
export function Aparece({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyle;
}) {
  const value = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    Animated.timing(value, {
      toValue: 1,
      duration: reduced ? 0 : 200,
      useNativeDriver: true,
      easing: Easing.out(Easing.cubic),
    }).start();
  }, [reduced, value]);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: value,
          transform: [
            {
              translateY: value.interpolate({
                inputRange: [0, 1],
                outputRange: [8, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
export function Boton({
  titulo,
  onPress,
  variante = "primario",
  deshabilitado,
  cargando,
  estilo,
  testID,
  textoCargando = "Guardando…",
  accessibilityLabel,
}: {
  titulo: string;
  onPress: () => void;
  variante?: "primario" | "secundario" | "peligro" | "fantasma";
  deshabilitado?: boolean;
  cargando?: boolean;
  textoCargando?: string;
  estilo?: ViewStyle;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const disabled = !!(deshabilitado || cargando);
  const primary = variante === "primario" || variante === "peligro";
  return (
    <Pulse
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? titulo}
      accessibilityState={{ disabled, busy: !!cargando }}
      disabled={disabled}
      onPress={onPress}
      style={[
        s.button,
        {
          backgroundColor:
            variante === "primario"
              ? pos.acento
              : variante === "peligro"
                ? pos.peligro
                : variante === "fantasma"
                  ? "transparent"
                  : pos.hundido,
          opacity: deshabilitado ? 0.45 : 1,
        },
        estilo ?? {},
      ]}
    >
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        {cargando && <ActivityIndicator color={variante === "primario" ? pos.acentoTexto : primary ? "#fff" : pos.texto} />}
        <Text
          style={[
            tipo.subtitulo,
            {
              textAlign: "center",
              fontSize: 14,
              color: variante === "primario" ? pos.acentoTexto : primary ? "#fff" : pos.texto,
            },
          ]}
        >
          {cargando ? textoCargando : titulo}
        </Text>
      </View>
    </Pulse>
  );
}
export function Teclado({
  alPulsar,
  extra = ".",
  disabled = false,
  alto,
}: {
  alPulsar: (key: string) => void;
  extra?: string | null;
  disabled?: boolean;
  /** Alto de cada tecla (tablet: teclas más grandes en el cobro). */
  alto?: number;
}) {
  return (
    <View style={{ gap: 6 }}>
      {[
        ["1", "2", "3"],
        ["4", "5", "6"],
        ["7", "8", "9"],
        [extra ?? "", "0", "⌫"],
      ].map((row, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 6 }}>
          {row.map((key, j) => (
            <View key={j} style={{ flex: 1 }}>
              {key !== "" && (
                <Pulse
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={key === "⌫" ? "Borrar" : key}
                  accessibilityState={{ disabled }}
                  onPress={() => alPulsar(key)}
                  style={[s.key, alto ? { minHeight: alto } : null]}
                >
                  {key === "⌫"
                    // Geist no trae el glifo ⌫: el icono se ve igual en todas las fuentes.
                    ? <Ionicons name="backspace-outline" size={26} color={pos.texto} />
                    : <Text style={[tipo.numero, { fontSize: 23 }]}>{key}</Text>}
                </Pulse>
              )}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
export function Tarjeta({
  children,
  estilo,
}: {
  children: ReactNode;
  estilo?: ViewStyle;
}) {
  return <View style={[s.card, estilo]}>{children}</View>;
}
export function Aviso({
  texto,
  tono = "aviso",
}: {
  texto: string;
  tono?: "aviso" | "peligro" | "exito";
}) {
  return (
    <View
      accessibilityLiveRegion={tono === "peligro" ? "assertive" : "polite"}
      style={[
        s.notice,
        {
          borderLeftColor: pos[tono],
          backgroundColor:
            tono === "aviso"
              ? pos.avisoSuave
              : tono === "peligro"
                ? pos.peligroSuave
                : pos.exitoSuave,
        },
      ]}
    >
      <Text style={[tipo.cuerpo, { color: pos[tono], fontSize: 14 }]}>
        {texto}
      </Text>
    </View>
  );
}
export function Puntos({ n, max = 8 }: { n: number; max?: number }) {
  return (
    <View
      accessible
      accessibilityLabel={`PIN, ${n} dígitos ingresados`}
      style={{
        flexDirection: "row",
        justifyContent: "center",
        gap: 12,
        paddingVertical: 20,
      }}
    >
      {Array.from({ length: Math.max(4, Math.min(max, n)) }, (_, i) => (
        <View
          key={i}
          style={{
            width: 13,
            height: 13,
            borderRadius: 7,
            backgroundColor: i < n ? pos.texto : pos.borde,
          }}
        />
      ))}
    </View>
  );
}
export function BarraSync({
  texto,
  pendientes,
  enLinea,
  revocado,
  enRevision = 0,
  onPress,
}: {
  texto: string;
  pendientes: number;
  enLinea: boolean;
  revocado?: boolean;
  enRevision?: number;
  onPress?: () => void;
}) {
  const color = revocado
    ? pos.peligro
    : !enLinea || pendientes || enRevision
      ? pos.aviso
      : pos.exito;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={texto}
      onPress={onPress}
      style={s.sync}
    >
      <View
        style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }}
      />
      <Text style={[tipo.tenue, { flexShrink: 1 }]} numberOfLines={2}>
        {texto}
      </Text>
    </Pressable>
  );
}
export function Marca({ caption = "POS MOBILE" }: { caption?: string }) {
  const logo = logoDeMarca();
  if (logo)
    return (
      <View style={{ gap: 4, alignItems: "flex-start" }}>
        <View style={{ backgroundColor: "#FFFFFF", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5 }}>
          <Image source={{ uri: logo }} style={{ width: 112, height: 32 }} resizeMode="contain" accessibilityLabel="Logo del negocio" />
        </View>
        <Text style={[tipo.etiqueta, { color: "#ACCAD7", fontSize: 9 }]}>
          CON WYBIX {caption}
        </Text>
      </View>
    );
  return (
    <View style={{ gap: 2 }}>
      <Text
        style={{
          fontFamily: "WybixSemi",
          fontSize: 25,
          letterSpacing: -1,
          color: "#fff",
        }}
      >
        Wybix<Text style={{ color: pos.wybix }}>.</Text>
      </Text>
      <Text style={[tipo.etiqueta, { color: "#ACCAD7", fontSize: 9 }]}>
        {caption}
      </Text>
    </View>
  );
}
/** Bounded sheet: header and actions remain reachable, body scrolls with large text. */
export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  footer,
  busy = false,
  maxWidth = 520,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer: ReactNode;
  busy?: boolean;
  maxWidth?: number;
}) {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  const [bodyHeight, setBodyHeight] = useState(500);
  const [headerHeight, setHeaderHeight] = useState(106);
  const [footerHeight, setFooterHeight] = useState(80);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (visible) setMounted(true);
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: reduced ? 0 : visible ? 250 : 180,
      useNativeDriver: true,
      easing: Easing.out(Easing.cubic),
    }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [visible, reduced, progress]);
  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[
          s.overlay,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 },
        ]}
      >
        <Animated.View
          accessibilityViewIsModal
          style={[
            s.sheet,
            {
              width: Math.min(width - 24, maxWidth),
              height: Math.min(
                height - insets.top - insets.bottom - 24,
                bodyHeight + headerHeight + footerHeight,
              ),
              opacity: progress,
              transform: [
                {
                  translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [16, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <View
            style={s.sheetHeader}
            onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
          >
            <View style={{ flex: 1 }}>
              <Text accessibilityRole="header" style={tipo.titulo}>
                {title}
              </Text>
              {subtitle && <Text style={tipo.tenue}>{subtitle}</Text>}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cerrar"
              disabled={busy}
              accessibilityState={{ disabled: busy }}
              onPress={onClose}
              style={s.close}
            >
              <Text style={[tipo.subtitulo, { fontSize: 23 }]}>×</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 20, gap: 12 }}
            style={{ flex: 1 }}
            onContentSizeChange={(_, h) => setBodyHeight(h)}
          >
            {children}
          </ScrollView>
          <View
            style={s.footer}
            onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
          >
            {footer}
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
const s = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  key: {
    minHeight: 48,
    borderRadius: 10,
    backgroundColor: pos.hundido,
    justifyContent: "center",
    alignItems: "center",
    padding: 8,
  },
  card: {
    backgroundColor: pos.superficie,
    borderRadius: 14,
    padding: 24,
    borderWidth: 1,
    borderColor: pos.borde,
  },
  notice: { borderRadius: 8, borderLeftWidth: 3, padding: 12 },
  sync: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: 22,
    backgroundColor: "#EAF0F4",
    maxWidth: 300,
  },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(8,25,38,.65)",
    justifyContent: "center",
    alignItems: "center",
  },
  sheet: {
    backgroundColor: "#fff",
    borderRadius: 18,
    overflow: "hidden",
    flexShrink: 1,
  },
  sheetHeader: {
    flexShrink: 0,
    padding: 20,
    borderBottomWidth: 1,
    borderColor: pos.borde,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  close: {
    width: 48,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: pos.hundido,
    borderRadius: 12,
  },
  footer: { padding: 16, borderTopWidth: 1, borderColor: pos.borde, gap: 10 },
});

export function Pantalla({ children }: { children: ReactNode }) {
  const { width, fontScale } = useWindowDimensions();
  return (
    <SafeAreaView
      edges={
        width >= 1000 && fontScale <= 1.3 ? ["right", "bottom"] : ["right"]
      }
      style={{ flex: 1, backgroundColor: pos.fondo }}
    >
      {children}
    </SafeAreaView>
  );
}
