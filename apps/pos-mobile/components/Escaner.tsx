import { useState } from "react";
import { Modal, View, Text, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useReducedMotion, Boton, pos as t, tipo } from "./ui";

/** Escáner de QR (enrolamiento o comprobante de transferencia). */
export function Escaner({
  visible,
  titulo,
  alLeer,
  alCerrar,
}: {
  visible: boolean;
  titulo: string;
  alLeer: (texto: string) => void;
  alCerrar: () => void;
}) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [permiso, pedir] = useCameraPermissions();
  const [leido, setLeido] = useState(false);
  return (
    <Modal
      visible={visible}
      animationType={reduced ? "none" : "fade"}
      onRequestClose={alCerrar}
      onShow={() => setLeido(false)}
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
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={
              leido
                ? undefined
                : (r) => {
                    setLeido(true);
                    alLeer(r.data);
                  }
            }
          />
        ) : (
          <View style={s.centro}>
            <Text style={[tipo.cuerpo, { color: "#fff", textAlign: "center" }]}>
              Se necesita la cámara para leer el código.
            </Text>
            <Boton titulo="Permitir cámara" onPress={pedir} />
          </View>
        )}
        <View style={{ padding: 16 }}>
          <Boton titulo="Cerrar" variante="secundario" onPress={alCerrar} />
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
});
