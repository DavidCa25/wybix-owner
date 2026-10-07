/** ¿Quién está en la caja? Persona asignada al evento + su PIN, sin Internet. */
import { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { identificar, personal } from "@wybix/database";
import { ETIQUETA_ROL, type RolEvento } from "@wybix/domain";
import {
  Pulse,
  Tarjeta,
  Aviso,
  Boton,
  Puntos,
  Teclado,
  teclear,
  BarraSync,
  pos as t,
  tipo,
} from "../components/ui";
import { Acceso } from "../components/Acceso";
import { usePos } from "../lib/contexto";

export default function Entrar() {
  const { width, fontScale } = useWindowDimensions();
  const wide = width >= 800 && fontScale <= 1.3;
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const { db, identidad, entrar, sync, sincronizar } = usePos();
  const router = useRouter();
  const [lista, setLista] = useState<
    Array<{ uuid: string; name: string; role: RolEvento }>
  >([]);
  const [elegido, setElegido] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (db) personal(db).then(setLista);
  }, [db, sync.ultima_sincronizacion]);

  const confirmar = async () => {
    if (!db || !elegido || lock.current) return;
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

  return (
    <Acceso
      focusKey={elegido}
      title="¿Quién atiende?"
      description={`${identidad?.location_name ?? "Evento"} · Caja ${identidad?.register.code ?? ""}. Selecciona tu nombre e ingresa tu PIN.`}
      status={
        <BarraSync
          texto={sync.texto}
          pendientes={sync.pendientes}
          enLinea={sync.en_linea}
          revocado={sync.revocado}
          enRevision={sync.rechazados + sync.cuarentena}
          onPress={sincronizar}
        />
      }
    >
      <View style={{ flexDirection: wide ? "row" : "column", gap: 28 }}>
        <View style={{ flex: 1, gap: 16 }}>
          <Text style={tipo.etiqueta}>PERSONAL DEL EVENTO</Text>
          <View style={s.lista}>
            {lista.map((p) => (
              <Pulse
                key={p.uuid}
                disabled={busy}
                accessibilityState={{
                  selected: elegido === p.uuid,
                  disabled: busy,
                }}
                testID={`persona-${p.name}`}
                accessibilityRole="button"
                accessibilityLabel={p.name}
                onPress={() => {
                  setElegido(p.uuid);
                  setPin("");
                  setError(null);
                }}
                style={[
                  s.persona,
                  elegido === p.uuid && {
                    borderColor: t.acento,
                    backgroundColor: "#E5F3F5",
                  },
                ]}
              >
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <Text style={[tipo.subtitulo, { flex: 1 }]}>{p.name}</Text>
                  {elegido === p.uuid && (
                    <Text style={[tipo.subtitulo, { color: t.acento }]}>✓</Text>
                  )}
                </View>
                <Text style={tipo.tenue}>{ETIQUETA_ROL[p.role] ?? p.role}</Text>
              </Pulse>
            ))}
            {!lista.length && (
              <Aviso texto="Nadie está asignado a este evento todavía. El administrador asigna al personal en Wybix Owner y la tablet lo recibe al sincronizar." />
            )}
          </View>
        </View>
        <Tarjeta
          estilo={{
            flex: wide ? 1 : undefined,
            width: wide ? undefined : "100%",
            maxWidth: wide ? 420 : undefined,
            gap: 16,
            alignSelf: "flex-start",
          }}
        >
          {elegido ? (
            <View style={{ gap: 12 }}>
              <Text style={tipo.subtitulo}>
                {lista.find((p) => p.uuid === elegido)?.name}
              </Text>
              <Text style={[tipo.cuerpo, { textAlign: "center" }]}>Tu PIN</Text>
              <Puntos n={pin.length} />
              <Teclado
                disabled={busy}
                extra={null}
                alPulsar={(k) => setPin((v) => teclear(v, k, 8))}
              />
              {error && <Aviso tono="peligro" texto={error} />}
              <Boton
                testID="entrar"
                titulo="Entrar"
                textoCargando="Verificando…"
                cargando={busy}
                onPress={confirmar}
                deshabilitado={pin.length < 4}
              />
            </View>
          ) : (
            <View style={{ paddingVertical: 56, gap: 10 }}>
              <Text style={tipo.subtitulo}>Tu caja, lista para operar</Text>
              <Text style={tipo.tenue}>
                Selecciona una persona para desbloquear el teclado. Tu PIN se
                verifica en esta tablet.
              </Text>
            </View>
          )}
        </Tarjeta>
      </View>
    </Acceso>
  );
}

const s = StyleSheet.create({
  lista: { gap: 12 },
  persona: {
    width: "100%",
    padding: 20,
    minHeight: 92,
    borderRadius: t.radio,
    borderWidth: 2,
    borderColor: t.borde,
    backgroundColor: t.superficie,
  },
});
