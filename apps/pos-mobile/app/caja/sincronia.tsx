/**
 * ESTADO: sincronización (sin tecnicismos para el cajero), lo que quedó en
 * revisión, la impresora y la versión. El detalle técnico existe para
 * diagnóstico, pero no estorba en la venta.
 */
import { useCallback, useRef, useState } from "react";
import { puede } from "@wybix/domain";
import type { Persona } from "@wybix/database";
import { Autorizar } from "../../components/Autorizar";
import { imprimirGuardado } from "../../lib/ticket-guardado";
import { bluetoothDisponible, impresorasEmparejadas, type ConfigImpresora, type DispositivoBt } from "../../lib/impresion";
import {
  View,
  Text,
  ScrollView,
  TextInput,
  StyleSheet,
  Pressable,
  Platform,
} from "react-native";
import { useFocusEffect } from "expo-router";
import {
  Aviso,
  Boton,
  Tarjeta,
  pos as t,
  tipo,
} from "../../components/ui";
import { usePos } from "../../lib/contexto";
import { CONFIG } from "../../lib/config";
import { Marco, useAncho } from "../../components/Marco";

export default function Sincronia() {
  const ancho = useAncho();
  const {
    db,
    pos,
    sync,
    sincronizar,
    impresora,
    configurarImpresora,
    persona,
    minima,
    desfaseMin,
  } = usePos();
  const [revision, setRevision] = useState<
    Array<{
      event_type: string;
      status: string;
      last_error: string | null;
      occurred_at: string;
    }>
  >([]);
  const [fallidos, setFallidos] = useState(0);
  const [host, setHost] = useState("");
  const [msg, setMsg] = useState<{
    texto: string;
    tono: "exito" | "peligro";
  } | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [tickets, setTickets] = useState<Array<{sale_uuid: string; folio: string; total: string; last_error: string | null}>>([]);
  const [configPendiente, setConfigPendiente] = useState<ConfigImpresora | null>(null);
  const [imprimiendo, setImprimiendo] = useState<string | null>(null);
  const [configurando, setConfigurando] = useState(false);
  const [dispositivos, setDispositivos] = useState<DispositivoBt[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [probando, setProbando] = useState(false);
  const [vista, setVista] = useState<VistaImpresora>(impresora.tipo);
  const lockImpresion = useRef(false);
  const lockConfig = useRef(false);

  const guardarImpresora = async (c: ConfigImpresora, aut?: Persona) => {
    if (lockConfig.current) return;
    lockConfig.current = true;
    setConfigurando(true);
    try {
      await configurarImpresora(c, aut);
      setConfigPendiente(null);
      setMsg({texto: 'Configuración de impresora guardada.', tono: 'exito'});
    } catch (e) { setMsg({texto: (e as Error).message, tono: 'peligro'}); }
    finally { lockConfig.current = false; setConfigurando(false); }
  };
  const elegirImpresora = (c: ConfigImpresora) => {
    if (!persona) return;
    if (puede(persona.role, 'CONFIGURAR_IMPRESORA')) void guardarImpresora(c);
    else setConfigPendiente(c);
  };
  const buscarBluetooth = async () => {
    setBuscando(true);
    try {
      const lista = await impresorasEmparejadas();
      setDispositivos(lista);
      if (!lista.length) setMsg({texto: 'No hay dispositivos emparejados. Empareja la impresora en Ajustes de Android > Bluetooth y vuelve a buscar.', tono: 'peligro'});
    } catch (e) { setMsg({texto: (e as Error).message, tono: 'peligro'}); }
    finally { setBuscando(false); }
  };
  const reimprimir = async (saleUuid: string) => {
    if (!pos || !persona || lockImpresion.current) return;
    lockImpresion.current = true;
    setImprimiendo(saleUuid);
    try {
      await imprimirGuardado(pos, impresora, saleUuid, persona);
      setMsg({texto: 'Ticket enviado. La venta sigue siendo la original.', tono: 'exito'});
    } catch (e) { setMsg({texto: (e as Error).message, tono: 'peligro'}); }
    finally { lockImpresion.current = false; setImprimiendo(null); await cargar(); }
  };

  const cargar = useCallback(async () => {
    if (!db) return;
    setRevision(
      await db.all(
        `SELECT event_type, status, last_error, occurred_at FROM outbox WHERE status IN ('REJECTED', 'QUARANTINED') ORDER BY local_seq DESC LIMIT 20`,
      ),
    );
    const pendientes = await pos?.ticketsSinImprimir() ?? [];
    setTickets(pendientes);
    setFallidos(pendientes.length);
  }, [db, pos]);
  useFocusEffect(
    useCallback(() => {
      cargar();
    }, [cargar]),
  );

  const ahora = async () => {
    setSincronizando(true);
    try {
      await sincronizar();
    } finally {
      setSincronizando(false);
      cargar();
    }
  };

  const enRevision = sync.rechazados + sync.cuarentena;
  const estado = sync.revocado
    ? { titulo: "Esta tablet fue dada de baja", color: t.peligro, suave: t.peligroSuave,
        texto: "Ya no recibe catálogo ni personal. Lo pendiente sigue guardado aquí. Avisa al encargado." }
    : !sync.en_linea
      ? { titulo: "Sin conexión · todo está guardado", color: t.aviso, suave: t.avisoSuave,
          texto: "Las ventas, turnos y movimientos se guardan primero en la tablet y se envían solos cuando hay Internet." }
      : sync.pendientes
        ? { titulo: `Enviando ${sync.pendientes} ${sync.pendientes === 1 ? "operación" : "operaciones"}`, color: t.aviso, suave: t.avisoSuave,
            texto: "Hay Internet: lo pendiente se está enviando a Wybix." }
        : { titulo: "Todo sincronizado", color: t.exito, suave: t.exitoSuave,
            texto: "Las ventas de esta tablet ya están en Wybix." };
  const ultima = sync.ultima_sincronizacion
    ? `Última sincronización: ${new Date(sync.ultima_sincronizacion).toLocaleString("es-MX")}.`
    : "Última sincronización: todavía no.";
  const contadores: Array<{ label: string; value: number; nota: string; mal: boolean }> = [
    { label: "Por enviar", value: sync.pendientes, nota: sync.pendientes ? (sync.en_linea ? "enviando" : "esperando red") : "al día", mal: sync.pendientes > 0 },
    { label: "En revisión", value: enRevision, nota: enRevision ? "las revisa el encargado" : "sin pendientes", mal: enRevision > 0 },
    { label: "Tickets sin imprimir", value: fallidos, nota: fallidos ? "ventas guardadas" : "todo impreso", mal: fallidos > 0 },
  ];
  const actual =
    impresora.tipo === "red"
      ? "Impresora de red (ESC/POS)"
      : impresora.tipo === "bluetooth"
        ? `Bluetooth · ${impresora.nombre ?? impresora.direccion}`
        : impresora.tipo === "sistema"
          ? Platform.OS === "web" ? "Impresión del navegador" : "Impresión de Android"
          : "Sin impresora";
  const opciones: Array<{ id: VistaImpresora; titulo: string }> = [
    ...(bluetoothDisponible ? [{ id: "bluetooth" as const, titulo: "Bluetooth" }] : []),
    ...(Platform.OS !== "web" ? [{ id: "red" as const, titulo: "Red (IP)" }] : []),
    { id: "sistema", titulo: Platform.OS === "web" ? "Navegador" : "Android" },
    { id: "ninguna", titulo: "Ninguna" },
  ];
  const elegirVista = (v: VistaImpresora) => {
    setVista(v);
    if (v === "sistema" && impresora.tipo !== "sistema") elegirImpresora({ tipo: "sistema" });
    if (v === "ninguna" && impresora.tipo !== "ninguna") elegirImpresora({ tipo: "ninguna" });
  };
  const probar = async () => {
    setProbando(true);
    try {
      await impresora.imprimir({
        negocio: "Wybix",
        ubicacion: "Prueba de impresión",
        folio: "PRUEBA",
        fecha: new Date().toLocaleString("es-MX"),
        cajero: persona?.name ?? "-",
        lineas: [{ cantidad: "1", nombre: "Ticket de prueba", importe: "$0.00" }],
        total: "$0.00",
        pagos: [],
        cambio: "0",
      });
      setMsg({ texto: "Prueba enviada.", tono: "exito" });
    } catch (e) {
      setMsg({ texto: `No se pudo imprimir: ${(e as Error).message}`, tono: "peligro" });
    } finally {
      setProbando(false);
    }
  };

  return (
    <Marco
      seccion="sincronia"
      titulo="Estado de la tablet"
      derecha={ancho ? <Text style={[tipo.numero, { color: t.tenue, fontSize: 13 }]}>POS Mobile {CONFIG.version}</Text> : undefined}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 14, paddingHorizontal: ancho ? 0 : 16, paddingBottom: 16 }}>
        {Platform.OS === "web" && (
          <Aviso texto="En la versión web, mantén la app abierta para sincronizar. Antes de borrar los datos de Safari o quitar el icono, comprueba que no haya ventas pendientes. La impresión usa el diálogo del navegador." />
        )}

        {/* Lo que pasa con la sincronización, en una frase */}
        <View style={[s.estado, { backgroundColor: estado.suave, borderColor: estado.color + "40", flexDirection: ancho ? "row" : "column", alignItems: ancho ? "center" : "stretch" }]}>
          <View style={{ flexDirection: "row", gap: 18, alignItems: "center", flex: ancho ? 1 : undefined }}>
            <View style={[s.punto, { backgroundColor: estado.color }]} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text accessibilityLiveRegion="polite" style={[tipo.titulo, { fontSize: ancho ? 24 : 20 }]}>{estado.titulo}</Text>
              <Text style={[tipo.tenue, { fontSize: 14 }]}>{estado.texto} {ultima}</Text>
            </View>
          </View>
          <Boton
            testID="sincronizar"
            titulo="Sincronizar ahora"
            textoCargando="Sincronizando…"
            onPress={ahora}
            cargando={sincronizando}
            estilo={{ minHeight: 52, borderRadius: 14, paddingHorizontal: 26 }}
          />
        </View>

        <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap" }}>
          {contadores.map((c) => (
            <Tarjeta key={c.label} estilo={{ flex: 1, minWidth: ancho ? 180 : 140, gap: 6, padding: 18 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Text style={tipo.tenue}>{c.label}</Text>
                <Text style={[s.nota, { color: c.mal ? t.aviso : t.exito, backgroundColor: c.mal ? t.avisoSuave : t.exitoSuave }]}>{c.nota}</Text>
              </View>
              <Text style={[tipo.numero, { fontSize: 32, color: c.mal ? t.aviso : t.texto }]}>{c.value}</Text>
            </Tarjeta>
          ))}
        </View>

        {revision.length > 0 && (
          <Tarjeta estilo={{ gap: 6 }}>
            <Text style={tipo.subtitulo}>En revisión</Text>
            <Text style={tipo.tenue}>No se pierden: quedan guardados en la tablet y Wybix los revisa con el encargado.</Text>
            {revision.map((r, i) => (
              <Text key={i} style={tipo.cuerpo}>
                • {r.event_type} — {r.status === "QUARANTINED" ? "en cuarentena" : (r.last_error ?? "rechazado")}
              </Text>
            ))}
          </Tarjeta>
        )}

        <View style={{ flexDirection: ancho ? "row" : "column", gap: 14, alignItems: ancho ? "flex-start" : "stretch" }}>
          {/* Impresora */}
          <Tarjeta estilo={{ gap: 14, flex: ancho ? 1.6 : undefined }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={tipo.etiqueta}>IMPRESORA DE TICKETS</Text>
                <Text style={[tipo.subtitulo, { fontSize: 18, marginTop: 4 }]} numberOfLines={1}>{actual}</Text>
              </View>
              <Boton
                titulo="Imprimir prueba"
                variante="secundario"
                textoCargando="Imprimiendo…"
                cargando={probando}
                deshabilitado={impresora.tipo === "ninguna"}
                onPress={probar}
              />
            </View>
            <View accessibilityRole="radiogroup" style={s.seg}>
              {opciones.map((o) => {
                const on = vista === o.id;
                return (
                  <Pressable
                    key={o.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on, disabled: configurando }}
                    disabled={configurando}
                    onPress={() => elegirVista(o.id)}
                    style={[s.segOpcion, on && s.segOn]}
                  >
                    <Text style={[tipo.subtitulo, { fontSize: 13, color: on ? t.texto : t.tenue }]} numberOfLines={1}>{o.titulo}</Text>
                  </Pressable>
                );
              })}
            </View>

            {vista === "bluetooth" && (
              <View style={{ gap: 8 }}>
                <Text style={tipo.tenue}>
                  Funciona sin Internet ni WiFi. Primero emparéjala en Ajustes de Android {">"} Bluetooth (si pide PIN, suele ser 0000 o 1234). Después búscala aquí y elígela.
                </Text>
                <Boton titulo="Buscar impresoras emparejadas" variante="secundario" textoCargando="Buscando…" cargando={buscando} deshabilitado={configurando} onPress={buscarBluetooth} />
                {dispositivos?.map((d) => {
                  const usada = impresora.tipo === "bluetooth" && impresora.direccion === d.direccion;
                  return (
                    <Boton
                      key={d.direccion}
                      titulo={`${usada ? "✓ " : ""}${d.nombre} · ${d.direccion}`}
                      variante={usada ? "primario" : "secundario"}
                      accessibilityLabel={`Usar la impresora Bluetooth ${d.nombre}`}
                      deshabilitado={configurando}
                      onPress={() => elegirImpresora({ tipo: "bluetooth", direccion: d.direccion, nombre: d.nombre })}
                    />
                  );
                })}
              </View>
            )}
            {vista === "red" && (
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <TextInput
                  accessibilityLabel="Dirección IP de la impresora"
                  value={host}
                  onChangeText={setHost}
                  placeholder="IP de la impresora (p. ej. 192.168.1.50)"
                  keyboardType="numbers-and-punctuation"
                  style={[s.input, { flex: 1 }]}
                />
                <Boton
                  titulo="Usar esta IP"
                  onPress={() => elegirImpresora({ tipo: "red", host: host.trim() })}
                  deshabilitado={configurando || !/^\d+\.\d+\.\d+\.\d+$/.test(host.trim())}
                />
              </View>
            )}
            {msg && (
              <Pressable onPress={() => setMsg(null)}>
                <Aviso tono={msg.tono} texto={msg.texto} />
              </Pressable>
            )}

            {tickets.length > 0 && (
              <View style={{ gap: 8, borderTopWidth: 1, borderColor: t.borde, paddingTop: 12 }}>
                <Text style={tipo.etiqueta}>NO SE IMPRIMIERON</Text>
                {tickets.map((ticket) => (
                  <View key={ticket.sale_uuid} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={tipo.numero}>{ticket.folio} · ${ticket.total}</Text>
                      {ticket.last_error && <Text style={tipo.tenue} numberOfLines={2}>{ticket.last_error}</Text>}
                    </View>
                    <Boton
                      titulo="Reimprimir"
                      variante="secundario"
                      accessibilityLabel={`Reimprimir ticket ${ticket.folio}`}
                      cargando={imprimiendo === ticket.sale_uuid}
                      deshabilitado={!!imprimiendo || impresora.tipo === "ninguna" || !puede(persona?.role, "REIMPRIMIR")}
                      onPress={() => reimprimir(ticket.sale_uuid)}
                    />
                  </View>
                ))}
              </View>
            )}
          </Tarjeta>

          {/* Dispositivo */}
          <Tarjeta estilo={{ gap: 12, flex: ancho ? 1 : undefined }}>
            <Text style={tipo.etiqueta}>DISPOSITIVO</Text>
            {[
              ["Versión", CONFIG.version],
              ["Mínima permitida", minima ?? "—"],
              ["Canal", `${CONFIG.canal}${CONFIG.perfil === "desarrollo" ? " · DESARROLLO" : ""}`],
            ].map(([k, v]) => (
              <View key={k} style={s.fila}>
                <Text style={tipo.tenue}>{k}</Text>
                <Text style={tipo.numero}>{v}</Text>
              </View>
            ))}
            <View style={s.fila}>
              <Text style={tipo.tenue}>Hora de la tablet</Text>
              {desfaseMin != null && Math.abs(desfaseMin) >= 5 ? (
                <Text style={[tipo.subtitulo, { fontSize: 14, color: t.aviso }]}>
                  {Math.abs(desfaseMin)} min {desfaseMin > 0 ? "atrasada" : "adelantada"}
                </Text>
              ) : (
                <Text style={[tipo.subtitulo, { fontSize: 14, color: desfaseMin == null ? t.tenue : t.exito }]}>{desfaseMin == null ? "Sin medir" : "Correcta"}</Text>
              )}
            </View>
            {desfaseMin != null && Math.abs(desfaseMin) >= 5 && (
              <Text style={tipo.tenue}>Corrígela en los ajustes del dispositivo; mientras tanto, la fecha del turno usa la hora de Wybix.</Text>
            )}
            {persona?.role !== "CASHIER" && (
              <View style={{ gap: 8, borderTopWidth: 1, borderColor: t.borde, paddingTop: 12, marginTop: 4 }}>
                <Text style={tipo.tenue}>Solo encargado</Text>
                <Boton
                  titulo="Reconstruir existencias"
                  variante="secundario"
                  onPress={async () => {
                    const n = await pos?.reconstruirProyecciones();
                    setMsg({ texto: `Existencias reconstruidas de ${n} movimientos.`, tono: "exito" });
                  }}
                />
              </View>
            )}
          </Tarjeta>
        </View>
      </ScrollView>
      <Autorizar visible={!!configPendiente} accion="CONFIGURAR_IMPRESORA"
        motivo="Cambiar la configuración de la impresora de tickets."
        alCancelar={() => { if (!lockConfig.current) setConfigPendiente(null); }}
        alAutorizar={aut => { if (configPendiente) void guardarImpresora(configPendiente, aut); }} />
    </Marco>
  );
}

type VistaImpresora = "bluetooth" | "red" | "sistema" | "ninguna";

const s = StyleSheet.create({
  estado: { borderWidth: 1, borderRadius: 16, padding: 20, gap: 18 },
  punto: { width: 14, height: 14, borderRadius: 7 },
  nota: { fontFamily: "WybixSemi", fontSize: 11, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 10, overflow: "hidden" },
  fila: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 16 },
  seg: { flexDirection: "row", gap: 4, backgroundColor: t.hundido, padding: 4, borderRadius: 12 },
  segOpcion: { flex: 1, minHeight: 44, borderRadius: 9, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  segOn: { backgroundColor: t.superficie, borderWidth: 1, borderColor: t.borde },
  input: {
    borderWidth: 1.5,
    borderColor: t.borde,
    borderRadius: t.radio,
    paddingHorizontal: 14,
    minHeight: 52,
    fontSize: 17,
    color: t.texto,
  },
});
