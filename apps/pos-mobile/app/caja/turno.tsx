/**
 * TURNO Y CORTE. El mismo concepto de turno de la Fase 1: abre con fondo,
 * acumula efectivo, retiros y egresos, y cierra con el efectivo CONTADO. Quien
 * no puede ver el esperado cuenta a ciegas. Todo sin Internet.
 */
import { useCallback, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { puede, type Accion } from "@wybix/domain";
import type { Persona } from "@wybix/database";
import {
  Pantalla,
  Aviso,
  Boton,
  Tarjeta,
  Teclado,
  teclear,
  dinero,
  pos as t,
  tipo,
} from "../../components/ui";
import { usePos } from "../../lib/contexto";
import { Encabezado } from "../../components/Encabezado";
import { Autorizar } from "../../components/Autorizar";

type Resumen = Awaited<
  ReturnType<NonNullable<ReturnType<typeof usePos>["pos"]>["resumenTurno"]>
>;

export default function Turno() {
  const { width, fontScale } = useWindowDimensions();
  const wide = width >= 900 && fontScale <= 1.3;
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const { pos, persona, versionOk, minima, desfaseMin } = usePos();
  const [resumen, setResumen] = useState<Resumen>(null);
  const [monto, setMonto] = useState("");
  const [modo, setModo] = useState<
    "abrir" | "corte" | "CASH_OUT" | "EXPENSE" | null
  >(null);
  const [razon, setRazon] = useState("Retiro a resguardo");
  const [msg, setMsg] = useState<{
    tono: "exito" | "aviso" | "peligro";
    texto: string;
  } | null>(null);
  const [pidiendo, setPidiendo] = useState<{
    accion: Accion;
    motivo: string;
    hacer: (a: Persona) => Promise<void>;
    payload?: Record<string, unknown>;
  } | null>(null);

  const cargar = useCallback(async () => {
    if (pos && persona) setResumen(await pos.resumenTurno(persona));
  }, [pos, persona]);
  useFocusEffect(
    useCallback(() => {
      cargar();
      setModo(null);
      setMonto("");
    }, [cargar]),
  );

  const ejecutar = async (
    accion: Accion,
    motivo: string,
    hacer: (aut: Persona | null) => Promise<void>,
    payload?: Record<string, unknown>,
  ) => {
    if (!persona) return;
    try {
      if (puede(persona.role, accion)) await hacer(null);
      else {
        setPidiendo({
          accion,
          motivo,
          payload,
          hacer: async (a) => {
            await hacer(a);
          },
        });
        return;
      }
    } catch (e) {
      setMsg({ tono: "peligro", texto: (e as Error).message });
    }
  };

  const abrir = async () => {
    if (!pos || !persona) return;
    try {
      await pos.abrirTurno(persona, monto || "0", {
        versionMinimaOk: versionOk,
      });
      setMsg({ tono: "exito", texto: "Turno abierto." });
      setModo(null);
      setMonto("");
      cargar();
    } catch (e) {
      setMsg({ tono: "peligro", texto: (e as Error).message });
    }
  };

  const cerrar = () =>
    ejecutar(
      resumen && resumen.abierto_por !== persona?.uuid
        ? "CERRAR_TURNO_AJENO"
        : "CERRAR_TURNO_PROPIO",
      "Cerrar el turno de otra persona",
      async (aut) => {
        const r = await pos!.cerrarTurno(persona!, monto || "0", aut);
        setMsg({
          tono: "exito",
          texto:
            "difference" in r && r.difference != null
              ? `Turno cerrado. Esperado ${dinero(r.expected)} · Contado ${dinero(r.counted)} · Diferencia ${dinero(r.difference)}`
              : `Turno cerrado. Contado ${dinero(r.counted)}. El encargado revisa el corte.`,
        });
        setModo(null);
        setMonto("");
        cargar();
      },
      { turno: resumen?.shift_uuid ?? null, contado: monto || "0" },
    );

  const movimiento = (tipoMov: "CASH_OUT" | "EXPENSE") =>
    ejecutar(
      tipoMov === "EXPENSE" ? "EGRESO" : "RETIRO",
      tipoMov === "EXPENSE"
        ? "Registrar un egreso de caja"
        : "Retirar efectivo de la caja",
      async (aut) => {
        await pos!.movimientoCaja(persona!, tipoMov, monto, razon, aut);
        setMsg({
          tono: "exito",
          texto:
            tipoMov === "EXPENSE" ? "Egreso registrado." : "Retiro registrado.",
        });
        setModo(null);
        setMonto("");
        cargar();
      },
      { tipo: tipoMov === "EXPENSE" ? "EGRESO" : "RETIRO", monto, razon },
    );

  return (
    <Pantalla>
      <Encabezado titulo="Turno y corte" />
      <ScrollView
        contentContainerStyle={{
          padding: 24,
          gap: 20,
          maxWidth: 1120,
          width: "100%",
          alignSelf: "center",
        }}
      >
        {msg && <Aviso tono={msg.tono} texto={msg.texto} />}
        {!resumen && modo !== "abrir" && (
          <Tarjeta estilo={{ gap: 10 }}>
            <Text style={tipo.subtitulo}>No hay turno abierto</Text>
{desfaseMin != null && Math.abs(desfaseMin) >= 5 && (
              <Aviso
                texto={`La hora de esta tablet está ${Math.abs(desfaseMin)} min ${desfaseMin > 0 ? "atrasada" : "adelantada"}. Corrígela en los ajustes de Android; mientras tanto, la fecha del turno usa la hora de Wybix.`}
              />
            )}
            {!versionOk && (
              <Aviso
                tono="peligro"
                texto={`Esta versión ya no puede abrir turnos (mínima ${minima}). Actualiza Wybix POS Mobile.`}
              />
            )}
            <Boton
              testID="abrir-turno"
              titulo="Abrir turno"
              onPress={() => setModo("abrir")}
              deshabilitado={!versionOk}
            />
          </Tarjeta>
        )}
        <View
          style={{
            flexDirection: wide ? "row" : "column",
            gap: 24,
            alignItems: "flex-start",
          }}
        >
          {resumen && (
            <Tarjeta
              estilo={{
                gap: 16,
                flex: wide ? 1 : undefined,
                width: wide ? undefined : "100%",
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <Text style={tipo.etiqueta}>TURNO ACTUAL</Text>
                <Text
                  style={[
                    tipo.tenue,
                    {
                      color: t.exito,
                      backgroundColor: t.exitoSuave,
                      padding: 8,
                      borderRadius: 20,
                    },
                  ]}
                >
                  Abierto
                </Text>
              </View>
              <Text style={tipo.tenue}>
                Desde{" "}
                {new Date(resumen.abierto_at).toLocaleTimeString("es-MX", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </Text>
              <View style={s.fila}>
                <Text style={tipo.cuerpo}>Tickets</Text>
                <Text style={tipo.numero}>{resumen.tickets}</Text>
              </View>
              {resumen.ventas != null && (
                <View
                  style={{
                    paddingVertical: 20,
                    borderBottomWidth: 1,
                    borderColor: t.borde,
                  }}
                >
                  <Text style={tipo.tenue}>Total de ventas</Text>
                  <Text style={[tipo.numero, { fontSize: 40 }]}>
                    {dinero(resumen.ventas)}
                  </Text>
                </View>
              )}
              <Text style={tipo.etiqueta}>DESGLOSE DE COBROS</Text>
              {Object.entries(resumen.por_metodo).map(([m, v]) => (
                <View key={m} style={s.fila}>
                  <Text style={tipo.tenue}>{m}</Text>
                  <Text style={tipo.numero}>{dinero(v)}</Text>
                </View>
              ))}
              {resumen.ciego ? (
                <Text style={tipo.tenue}>
                  Los importes y el efectivo esperado los ve el encargado (corte
                  a ciegas).
                </Text>
              ) : (
                <View style={s.fila}>
                  <Text style={tipo.subtitulo}>Efectivo esperado</Text>
                  <Text style={[tipo.numero, { fontSize: 20 }]}>
                    {dinero(resumen.esperado)}
                  </Text>
                </View>
              )}
              {modo === null && (
                <View
                  style={{
                    flexDirection: "row",
                    gap: 8,
                    flexWrap: "wrap",
                    marginTop: 8,
                  }}
                >
                  <Boton
                    titulo="Retiro"
                    variante="secundario"
                    onPress={() => {
                      setModo("CASH_OUT");
                      setRazon("Retiro a resguardo");
                    }}
                    estilo={{ flex: 1 }}
                  />
                  <Boton
                    titulo="Egreso"
                    variante="secundario"
                    onPress={() => {
                      setModo("EXPENSE");
                      setRazon("Hielo");
                    }}
                    estilo={{ flex: 1 }}
                  />
                  <Boton
                    testID="hacer-corte"
                    titulo="Hacer corte"
                    onPress={() => setModo("corte")}
                    estilo={{ flex: 2 }}
                  />
                </View>
              )}
            </Tarjeta>
          )}
          {modo && (
            <Tarjeta
              estilo={{
                gap: 16,
                flex: wide ? 1 : undefined,
                width: wide ? undefined : "100%",
                maxWidth: wide ? 440 : undefined,
              }}
            >
              <Text style={tipo.etiqueta}>OPERACIÓN DE CAJA</Text>
              <Text style={tipo.subtitulo}>
                {modo === "abrir"
                  ? "Fondo inicial"
                  : modo === "corte"
                    ? "Efectivo contado"
                    : modo === "CASH_OUT"
                      ? "Monto del retiro"
                      : "Monto del egreso"}
              </Text>
              <Text
                style={[tipo.numero, { fontSize: 34, textAlign: "center" }]}
              >
                {dinero(monto || "0")}
              </Text>
              <Teclado
                disabled={busy}
                alPulsar={(k) => setMonto((v) => teclear(v, k, 9))}
              />
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Boton
                  titulo="Cancelar"
                  deshabilitado={busy}
                  variante="secundario"
                  onPress={() => {
                    setModo(null);
                    setMonto("");
                  }}
                  estilo={{ flex: 1 }}
                />
                <Boton
                  testID="confirmar-turno"
                  titulo={
                    modo === "abrir"
                      ? "Abrir turno"
                      : modo === "corte"
                        ? "Cerrar turno"
                        : "Registrar"
                  }
                  estilo={{ flex: 2 }}
                  cargando={busy}
                  onPress={() =>
                    run(async () => {
                      if (modo === "abrir") await abrir();
                      else if (modo === "corte") await cerrar();
                      else await movimiento(modo);
                    })
                  }
                  deshabilitado={
                    (modo === "CASH_OUT" || modo === "EXPENSE") &&
                    !Number(monto)
                  }
                />
              </View>
            </Tarjeta>
          )}
        </View>
      </ScrollView>
      <Autorizar
        visible={!!pidiendo}
        accion={pidiendo?.accion ?? "RETIRO"}
        motivo={pidiendo?.motivo ?? ""}
        payload={pidiendo?.payload}
        alCancelar={() => setPidiendo(null)}
        alAutorizar={async (a) => {
          const p = pidiendo;
          setPidiendo(null);
          try {
            await run(async () => {
              await p?.hacer(a);
            });
          } catch (e) {
            setMsg({ tono: "peligro", texto: (e as Error).message });
          }
        }}
      />
    </Pantalla>
  );
}

const s = StyleSheet.create({
  fila: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    minHeight: 48,
    gap: 16,
    borderBottomWidth: 1,
    borderColor: t.hundido,
  },
});
