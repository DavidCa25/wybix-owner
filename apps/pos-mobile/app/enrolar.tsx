/**
 * ENROLAMIENTO: el administrador generó un código (o QR) para este EVENT en
 * Wybix Owner. La tablet obtiene SU credencial (SecureStore), su caja y el
 * snapshot inicial. Sin código no hay manera de entrar a una empresa.
 */
import { useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";
import { Aviso, Boton, Tarjeta, pos as t, tipo } from "../components/ui";
import { usePos } from "../lib/contexto";
import { Acceso } from "../components/Acceso";
import { Ionicons } from "@expo/vector-icons";
import { Escaner } from "../components/Escaner";

export default function Enrolar() {
  const { width, fontScale } = useWindowDimensions();
  const wide = width >= 800 && fontScale <= 1.3;
  const lock = useRef(false);
  const { enrolar } = usePos();
  const router = useRouter();
  const [codigo, setCodigo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [escanear, setEscanear] = useState(false);

  const enviar = async (c = codigo) => {
    if (lock.current) return;
    lock.current = true;
    setCargando(true);
    setError(null);
    try {
      await enrolar(c);
      router.replace("/entrar");
    } catch (e) {
      setError((e as Error).message || "No se pudo enrolar.");
    } finally {
      lock.current = false;
      setCargando(false);
    }
  };

  return (
    <Acceso
      title="Enrolar caja"
      description="Vincula esta tablet al evento para comenzar a vender."
    >
      <View style={{ flexDirection: wide ? "row" : "column", gap: 24 }}>
        <View style={{ flex: 1, gap: 20 }}>
          <View
            style={{
              minHeight: 220,
              borderWidth: 1,
              borderColor: t.borde,
              borderRadius: 16,
              backgroundColor: t.superficie,
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              gap: 16,
            }}
          >
            <Ionicons name="qr-code-outline" size={64} color={t.acento} />
            <Text style={tipo.subtitulo}>Código de esta tablet</Text>
            <Text style={[tipo.tenue, { textAlign: "center", maxWidth: 320 }]}>
              Solicita el código o QR al dueño o administrador desde Wybix
              Owner, dentro del evento.
            </Text>
          </View>
          <Boton
            titulo="Escanear QR"
            variante="secundario"
            onPress={() => setEscanear(true)}
            deshabilitado={cargando}
          />
          <Text style={tipo.tenue}>
            Necesitas Internet para vincular la caja y descargar el catálogo
            inicial.
          </Text>
        </View>
        <Tarjeta
          estilo={{
            flex: 1,
            gap: 18,
            alignSelf: "flex-start",
            width: wide ? undefined : "100%",
          }}
        >
          <Text style={tipo.etiqueta}>VINCULAR DISPOSITIVO</Text>
          <Text style={tipo.subtitulo}>Ingresar código</Text>
          <Text style={tipo.tenue}>
            Captura el código de esta tablet. Lo genera el dueño o un
            administrador en Wybix Owner, dentro del evento.
          </Text>
          <TextInput
            testID="codigo"
            value={codigo}
            onChangeText={(v) => setCodigo(v.toUpperCase())}
            placeholder="XXXX-XXXX-XXXX"
            editable={!cargando}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={14}
            style={s.input}
            accessibilityLabel="Código de enrolamiento"
          />
          {error && <Aviso tono="peligro" texto={error} />}
          <Boton
            testID="enrolar"
            titulo="Enrolar tablet"
            textoCargando="Vinculando…"
            onPress={() => enviar()}
            cargando={cargando}
            deshabilitado={codigo.replace(/[^A-Z0-9]/g, "").length !== 12}
          />
        </Tarjeta>
      </View>
      <Escaner
        visible={escanear}
        titulo="Escanea el QR de enrolamiento"
        alCerrar={() => setEscanear(false)}
        alLeer={(d) => {
          setEscanear(false);
          const c = (
            d.match(/[A-Z0-9]{4}-?[A-Z0-9]{4}-?[A-Z0-9]{4}/i)?.[0] ?? d
          ).toUpperCase();
          setCodigo(c);
          enviar(c);
        }}
      />
    </Acceso>
  );
}

const s = StyleSheet.create({
  input: {
    borderWidth: 1.5,
    borderColor: t.borde,
    borderRadius: t.radio,
    paddingHorizontal: 16,
    minHeight: 56,
    fontSize: 24,
    letterSpacing: 3,
    textAlign: "center",
    color: t.texto,
    backgroundColor: t.superficie,
    fontVariant: ["tabular-nums"],
  },
});
