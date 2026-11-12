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
} from "react-native";
import { useFocusEffect } from "expo-router";
import { puede, type Accion } from "@wybix/domain";
import type { Persona } from "@wybix/database";
import {
  Pulse,
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
import { Marco, useAncho } from "../../components/Marco";
import { Autorizar } from "../../components/Autorizar";

type Resumen = Awaited<
  ReturnType<NonNullable<ReturnType<typeof usePos>["pos"]>["resumenTurno"]>
>;

export default function Turno() {
  const ancho = useAncho();
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

  const hora = (iso: string) =>
    new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  const operando = modo !== null;
  const metodos = resumen ? Object.entries(resumen.por_metodo) : [];
  const totalMetodos = metodos.reduce((a, [, v]) => a + Number(v), 0);
  const promedio = resumen?.ventas != null && resumen.tickets ? Number(resumen.ventas) / resumen.tickets : null;
  const d = resumen?.desglose;

  const vendido = resumen && (
    <Tarjeta estilo={{ gap: 14, flex: ancho ? 1.25 : undefined }}>
      <Text style={tipo.etiqueta}>VENDIDO EN ESTE TURNO</Text>
      {resumen.ventas != null ? (
        <Text style={[tipo.numero, { fontSize: ancho ? 52 : 40, letterSpacing: -1 }]} numberOfLines={1}>
          {dinero(resumen.ventas)}
        </Text>
      ) : (
        <Text style={tipo.tenue}>Los importes y el efectivo esperado los ve el encargado (corte a ciegas).</Text>
      )}
      <View style={{ flexDirection: "row", gap: 28 }}>
        <View>
          <Text style={[tipo.numero, { fontSize: 20 }]}>{resumen.tickets}</Text>
          <Text style={tipo.tenue}>{resumen.tickets === 1 ? "ticket" : "tickets"}</Text>
        </View>
        {promedio != null && (
          <View>
            <Text style={[tipo.numero, { fontSize: 20 }]}>{dinero(promedio.toFixed(2))}</Text>
            <Text style={tipo.tenue}>ticket promedio</Text>
          </View>
        )}
      </View>
      {metodos.length > 0 && (
        <View style={{ gap: 10, marginTop: 4 }}>
          {metodos.map(([m, v], i) => {
            const pct = totalMetodos ? Math.round((Number(v) / totalMetodos) * 100) : 0;
            return (
              <View key={m} style={{ gap: 6 }} accessible accessibilityLabel={`${nombreMetodo(m)}: ${dinero(v)}, ${pct} por ciento`}>
                <View style={s.fila}>
                  <Text style={tipo.cuerpo}>{nombreMetodo(m)}</Text>
                  <Text style={tipo.numero}>
                    {dinero(v)} <Text style={[tipo.tenue, { fontSize: 14 }]}>· {pct}%</Text>
                  </Text>
                </View>
                <View style={s.barra}>
                  <View style={[s.barraLlena, { width: `${pct}%`, backgroundColor: t.acento, opacity: i === 0 ? 1 : 0.5 }]} />
                </View>
              </View>
            );
          })}
        </View>
      )}
    </Tarjeta>
  );

  const partes: Array<[string, string, boolean]> = d
    ? [
        ["Fondo inicial", d.fondo, true],
        ["+ Ventas en efectivo", d.ventas_efectivo, true],
        ["+ Entradas", d.entradas, Number(d.entradas) > 0],
        ["− Retiros", d.retiros, true],
        ["− Egresos", d.egresos, true],
        ["− Devoluciones en efectivo", d.devoluciones, Number(d.devoluciones) > 0],
      ]
    : [];
  const esperado = resumen && d && resumen.esperado != null && (
    <Tarjeta estilo={{ gap: 12, flex: ancho ? 1 : undefined }}>
      <Text style={tipo.etiqueta}>EFECTIVO QUE DEBE HABER EN CAJA</Text>
      <Text style={[tipo.numero, { fontSize: ancho ? 38 : 32, letterSpacing: -0.6 }]}>{dinero(resumen.esperado)}</Text>
      <View style={s.punteado}>
        {partes
          .filter(([, , ver]) => ver)
          .map(([etiqueta, valor]) => (
            <View key={etiqueta} style={s.fila}>
              <Text style={tipo.tenue}>{etiqueta}</Text>
              <Text style={tipo.numero}>{dinero(valor)}</Text>
            </View>
          ))}
      </View>
    </Tarjeta>
  );

  const movimientos = resumen && !resumen.ciego && (
    <Tarjeta estilo={{ gap: 4, paddingVertical: 16 }}>
      <View style={[s.fila, { marginBottom: 6 }]}>
        <Text style={tipo.etiqueta}>MOVIMIENTOS DEL TURNO</Text>
        <Text style={tipo.tenue}>Las ventas están en tickets</Text>
      </View>
      {resumen.movimientos.map((m, i) => (
        <View key={i} style={[s.fila, s.linea]}>
          <View style={{ flexDirection: "row", gap: 12, flex: 1, minWidth: 0, alignItems: "center" }}>
            <Text style={[tipo.numero, { color: t.tenue, fontSize: 14 }]}>{hora(m.occurred_at)}</Text>
            <Text style={[tipo.cuerpo, { flexShrink: 1 }]} numberOfLines={1}>
              {ETIQUETA_MOV[m.type] ?? m.type}
              {m.reason ? ` · ${m.reason}` : ""}
              {m.persona ? <Text style={tipo.tenue}>{`  ${m.persona}`}</Text> : null}
            </Text>
          </View>
          <Text style={[tipo.numero, RESTA.has(m.type) && { color: t.peligro }]}>
            {RESTA.has(m.type) ? "−" : ""}
            {dinero(m.amount)}
          </Text>
        </View>
      ))}
      {resumen.movimientos.every((m) => m.type === "OPENING") && (
        <Text style={[tipo.tenue, { paddingTop: 8 }]}>Sin retiros ni egresos todavía.</Text>
      )}
    </Tarjeta>
  );

  const operacion = operando && (
    <Tarjeta estilo={{ gap: 16, flex: ancho && resumen ? 1 : undefined, width: ancho && !resumen ? 440 : undefined }}>
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
      <Text style={[tipo.numero, { fontSize: 34, textAlign: "center" }]}>{dinero(monto || "0")}</Text>
      <Teclado disabled={busy} alPulsar={(k) => setMonto((v) => teclear(v, k, 9))} />
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
          titulo={modo === "abrir" ? "Abrir turno" : modo === "corte" ? "Cerrar turno" : "Registrar"}
          estilo={{ flex: 2 }}
          cargando={busy}
          onPress={() =>
            run(async () => {
              if (modo === "abrir") await abrir();
              else if (modo === "corte") await cerrar();
              else if (modo) await movimiento(modo);
            })
          }
          deshabilitado={(modo === "CASH_OUT" || modo === "EXPENSE") && !Number(monto)}
        />
      </View>
    </Tarjeta>
  );

  return (
    <Marco
      seccion="turno"
      titulo="Turno y corte"
      derecha={
        resumen ? (
          <View style={[s.pill, { backgroundColor: t.exitoSuave }]}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.exito }} />
            <Text style={[tipo.subtitulo, { fontSize: 13, color: t.exito }]}>Abierto desde {hora(resumen.abierto_at)}</Text>
          </View>
        ) : undefined
      }
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 14, paddingHorizontal: ancho ? 0 : 16, paddingBottom: 16 }}>
        {msg && <Aviso tono={msg.tono} texto={msg.texto} />}
        {!resumen && modo !== "abrir" && (
          <Tarjeta estilo={{ gap: 12, maxWidth: 560 }}>
            <Text style={tipo.titulo}>No hay turno abierto</Text>
            <Text style={tipo.tenue}>Abre el turno con el efectivo que hay en la caja para empezar a vender.</Text>
            {desfaseMin != null && Math.abs(desfaseMin) >= 5 && (
              <Aviso
                texto={`La hora de esta tablet está ${Math.abs(desfaseMin)} min ${desfaseMin > 0 ? "atrasada" : "adelantada"}. Corrígela en los ajustes de Android; mientras tanto, la fecha del turno usa la hora de Wybix.`}
              />
            )}
            {!versionOk && (
              <Aviso tono="peligro" texto={`Esta versión ya no puede abrir turnos (mínima ${minima}). Actualiza Wybix POS Mobile.`} />
            )}
            <Boton testID="abrir-turno" titulo="Abrir turno" onPress={() => setModo("abrir")} deshabilitado={!versionOk} />
          </Tarjeta>
        )}
        {resumen && (
          <View style={{ flexDirection: ancho ? "row" : "column", gap: 14, alignItems: ancho ? "flex-start" : "stretch" }}>
            {vendido}
            {operando ? operacion : esperado}
          </View>
        )}
        {!resumen && operacion}
        {movimientos}
      </ScrollView>

      {resumen && !operando && (
        <View style={[s.dock, !ancho && { marginHorizontal: 12, marginBottom: 10, paddingLeft: 10 }]}>
          {ancho && (
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[tipo.tenue, { color: "#B8C3CF", fontSize: 12 }]}>Atiende {persona?.name}</Text>
              <Text style={[tipo.subtitulo, { color: "#fff", fontSize: 15 }]} numberOfLines={1}>
                Cuenta el efectivo y haz el corte al terminar
              </Text>
            </View>
          )}
          <BotonDock
            titulo="Retiro"
            onPress={() => {
              setModo("CASH_OUT");
              setRazon("Retiro a resguardo");
            }}
            flex={!ancho}
          />
          <BotonDock
            titulo="Egreso"
            onPress={() => {
              setModo("EXPENSE");
              setRazon("Hielo");
            }}
            flex={!ancho}
          />
          <Boton
            testID="hacer-corte"
            titulo={ancho ? "Hacer corte →" : "Hacer corte"}
            onPress={() => setModo("corte")}
            estilo={{ minHeight: 52, borderRadius: 14, paddingHorizontal: 26, flex: ancho ? undefined : 1.4 }}
          />
        </View>
      )}
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
    </Marco>
  );
}

/** Botón claro sobre la barra oscura (Retiro / Egreso). */
function BotonDock({ titulo, onPress, flex }: { titulo: string; onPress: () => void; flex?: boolean }) {
  return (
    <Pulse accessibilityRole="button" accessibilityLabel={titulo} onPress={onPress} style={[s.botonDock, flex ? { flex: 1 } : null]}>
      <Text style={[tipo.subtitulo, { fontSize: 14, color: "#fff" }]}>{titulo}</Text>
    </Pulse>
  );
}

const ETIQUETA_MOV: Record<string, string> = {
  OPENING: "Apertura · fondo",
  CASH_IN: "Entrada",
  CASH_OUT: "Retiro",
  EXPENSE: "Egreso",
  SALE_RETURN_CASH: "Devolución en efectivo",
};
/** Los que restan al cajón. */
const RESTA = new Set(["CASH_OUT", "EXPENSE", "SALE_RETURN_CASH"]);
function nombreMetodo(m: string) {
  const n: Record<string, string> = { EFECTIVO: "Efectivo", TARJETA: "Tarjeta", TRANSFERENCIA: "Transferencia" };
  return n[m] ?? m.charAt(0) + m.slice(1).toLowerCase();
}

const s = StyleSheet.create({
  fila: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 16 },
  linea: { minHeight: 44, borderTopWidth: 1, borderColor: t.hundido },
  punteado: { gap: 10, paddingTop: 12, borderTopWidth: 1, borderStyle: "dashed", borderColor: t.borde },
  barra: { height: 8, borderRadius: 4, backgroundColor: t.hundido, overflow: "hidden" },
  barraLlena: { height: 8, borderRadius: 4 },
  pill: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, minHeight: 36, borderRadius: 18 },
  dock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
    borderRadius: 24,
    paddingVertical: 10,
    paddingLeft: 22,
    paddingRight: 10,
    backgroundColor: t.navy,
  },
  botonDock: { minHeight: 52, borderRadius: 14, paddingHorizontal: 22, backgroundColor: "#1D2A3B", alignItems: "center", justifyContent: "center" },
});
