import { useRef, useState } from "react";
import { Modal, View, Text, StyleSheet, Vibration } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useReducedMotion, Boton, pos as t, tipo } from "./ui";

/** Códigos de producto que lee la cámara al vender o contar. */
const BARRAS = ["ean13", "ean8", "upc_a", "upc_e", "code128", "code39", "itf14"] as const;

/**
 * Escáner con la cámara.
 *   modo 'qr'      enrolamiento o comprobante de transferencia: lee UNA vez.
 *   modo 'barras'  vender o contar: sigue leyendo; el mismo código no se repite
 *                  antes de 1.5 s (la cámara lo ve varias veces por segundo).
 * `pie` muestra lo último que se agregó, para no tener que cerrar para ver.
 */
export function Escaner({
  visible,
  titulo,
  alLeer,
  alCerrar,
  modo = "qr",
  pie,
}: {
  visible: boolean;
  titulo: string;
  alLeer: (texto: string) => void;
  alCerrar: () => void;
  modo?: "qr" | "barras";
  pie?: string | null;
}) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [permiso, pedir] = useCameraPermissions();
  const [leido, setLeido] = useState(false);
  const ultimo = useRef<{ codigo: string; at: number }>({ codigo: "", at: 0 });
  const continuo = modo === "barras";
  const leer = (texto: string) => {
    if (continuo) {
      const ahora = Date.now();
      if (ultimo.current.codigo === texto && ahora - ultimo.current.at < 1500) return;
      ultimo.current = { codigo: texto, at: ahora };
      Vibration.vibrate(40);
      alLeer(texto);
      return;
    }
    setLeido(true);
    alLeer(texto);
  };
  return (
    <Modal
      visible={visible}
      animationType={reduced ? "none" : "fade"}
      onRequestClose={alCerrar}
      onShow={() => { setLeido(false); ultimo.current = { codigo: "", at: 0 }; }}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: t.navy,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        }}
      >
        <Text style={[tipo.subtitulo, { color: "#fff", padding: 16 }]}>
          {titulo}
        </Text>
        {permiso?.granted ? (
          <View style={{ flex: 1 }}>
            <CameraView
              style={{ flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: continuo ? [...BARRAS, "qr"] : ["qr"] }}
              onBarcodeScanned={!continuo && leido ? undefined : (r) => leer(r.data)}
            />
            {continuo && (
              <View pointerEvents="none" style={s.mira}>
                <View style={s.marco} />
              </View>
            )}
          </View>
        ) : (
          <View style={s.centro}>
            <Text style={[tipo.cuerpo, { color: "#fff", textAlign: "center" }]}>
              Se necesita la cámara para leer el código.
            </Text>
            <Boton titulo="Permitir cámara" onPress={pedir} />
          </View>
        )}
        {!!pie && (
          <Text accessibilityLiveRegion="polite" style={[tipo.cuerpo, s.pie]} numberOfLines={2}>
            {pie}
          </Text>
        )}
        <View style={{ padding: 16 }}>
          <Boton titulo={continuo ? "Listo" : "Cerrar"} variante="secundario" onPress={alCerrar} />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  centro: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },
  mira: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  marco: { width: "72%", height: 140, borderWidth: 3, borderColor: t.acento, borderRadius: 16 },
  pie: { color: "#fff", backgroundColor: "rgba(255,255,255,0.08)", marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 12 },
});
