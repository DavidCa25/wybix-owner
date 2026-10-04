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
import {
  View,
  Text,
  ScrollView,
  TextInput,
  StyleSheet,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { useFocusEffect } from "expo-router";
import {
  Pantalla,
  Aviso,
  Boton,
  Tarjeta,
  pos as t,
  tipo,
} from "../../components/ui";
import { usePos } from "../../lib/contexto";
import { CONFIG } from "../../lib/config";
import { Encabezado } from "../../components/Encabezado";

export default function Sincronia() {
  const { width, fontScale } = useWindowDimensions();
  const wide = width >= 900 && fontScale <= 1.3;
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
  const [configPendiente, setConfigPendiente] = useState<{tipo: 'red' | 'sistema' | 'ninguna'; host?: string} | null>(null);
  const [imprimiendo, setImprimiendo] = useState<string | null>(null);
  const [configurando, setConfigurando] = useState(false);
  const lockImpresion = useRef(false);
  const lockConfig = useRef(false);

  const guardarImpresora = async (c: {tipo: 'red' | 'sistema' | 'ninguna'; host?: string}, aut?: Persona) => {
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
  const elegirImpresora = (c: {tipo: 'red' | 'sistema' | 'ninguna'; host?: string}) => {
    if (!persona) return;
    if (puede(persona.role, 'CONFIGURAR_IMPRESORA')) void guardarImpresora(c);
    else setConfigPendiente(c);
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

  return (
    <Pantalla>
      <Encabezado titulo="Estado de la tablet" />
      <ScrollView
        contentContainerStyle={{
          padding: 24,
          gap: 20,
          maxWidth: 1120,
          width: "100%",
          alignSelf: "center",
        }}
      >
        {desfaseMin != null && Math.abs(desfaseMin) >= 5 && (
          <Aviso
            texto={`La hora de esta tablet está ${Math.abs(desfaseMin)} min ${desfaseMin > 0 ? "atrasada" : "adelantada"}. Corrígela en los ajustes de Android; mientras tanto, la fecha del turno usa la hora de Wybix.`}
          />
        )}
        <Tarjeta estilo={{ gap: 8 }}>
          <Text style={tipo.etiqueta}>RESGUARDO Y SINCRONIZACIÓN</Text>
          <Text style={tipo.titulo}>{sync.texto}</Text>
          <Text style={tipo.tenue}>
            {sync.ultima_sincronizacion
              ? `Última sincronización: ${new Date(sync.ultima_sincronizacion).toLocaleString("es-MX")}`
              : "Aún no ha sincronizado."}
          </Text>
          <Text style={tipo.tenue}>
            Las ventas, turnos y movimientos se guardan primero en la tablet; se
            envían solos cuando hay Internet.
          </Text>
          <Boton
            testID="sincronizar"
            titulo="Sincronizar ahora"
            textoCargando="Sincronizando…"
            onPress={ahora}
            cargando={sincronizando}
          />
        </Tarjeta>

        <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Por sincronizar", value: sync.pendientes },
            { label: "En revisión", value: sync.rechazados + sync.cuarentena },
            { label: "Tickets sin imprimir", value: fallidos },
          ].map((item) => (
            <Tarjeta
              key={item.label}
              estilo={{ flex: 1, minWidth: 160, gap: 6 }}
            >
              <Text style={tipo.tenue}>{item.label}</Text>
              <Text
                style={[
                  tipo.numero,
                  { fontSize: 30, color: item.value ? t.aviso : t.texto },
                ]}
              >
                {item.value}
              </Text>
            </Tarjeta>
          ))}
        </View>
        {revision.length > 0 && (
          <Tarjeta estilo={{ gap: 6 }}>
            <Text style={tipo.subtitulo}>En revisión</Text>
            <Text style={tipo.tenue}>
              No se pierden: quedan guardados en la tablet y Wybix los revisa
              con el encargado.
            </Text>
            {revision.map((r, i) => (
              <Text key={i} style={tipo.cuerpo}>
                • {r.event_type} —{" "}
                {r.status === "QUARANTINED"
                  ? "en cuarentena"
                  : (r.last_error ?? "rechazado")}
              </Text>
            ))}
          </Tarjeta>
        )}

        <View style={{ flexDirection: wide ? "row" : "column", gap: 24 }}>
          <Tarjeta estilo={{ gap: 16, flex: wide ? 2 : undefined }}>
            <Text style={tipo.etiqueta}>PERIFÉRICOS</Text>
            <Text style={tipo.subtitulo}>Impresora de tickets</Text>
            <Text style={tipo.tenue}>
              Actual:{" "}
              {impresora.tipo === "red"
                ? "impresora de red (ESC/POS)"
                : impresora.tipo === "sistema"
                  ? "impresión de Android"
                  : "sin impresora"}
            </Text>
            {fallidos > 0 && (
              <Aviso
                texto={`${fallidos} ticket(s) no se imprimieron. Las ventas están guardadas.`}
              />
            )}
            {tickets.map(ticket => (
              <View key={ticket.sale_uuid} style={{gap: 6}}>
                <Text style={tipo.cuerpo}>{ticket.folio} · ${ticket.total}</Text>
                {ticket.last_error && <Text style={tipo.tenue}>{ticket.last_error}</Text>}
                <Boton titulo="Reimprimir ticket" variante="secundario"
                  accessibilityLabel={`Reimprimir ticket ${ticket.folio}`}
                  cargando={imprimiendo === ticket.sale_uuid}
                  deshabilitado={!!imprimiendo || impresora.tipo === "ninguna" || !puede(persona?.role, 'REIMPRIMIR')}
                  onPress={() => reimprimir(ticket.sale_uuid)} />
              </View>
            ))}
            <TextInput
              accessibilityLabel="Dirección IP de la impresora"
              value={host}
              onChangeText={setHost}
              placeholder="IP de la impresora de red (p. ej. 192.168.1.50)"
              keyboardType="numbers-and-punctuation"
              style={s.input}
            />
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <Boton
                titulo="Usar red"
                variante="secundario"
                onPress={() => elegirImpresora({tipo: "red", host: host.trim()})}
                deshabilitado={configurando || !/^\d+\.\d+\.\d+\.\d+$/.test(host.trim())}
                estilo={{ flex: 1 }}
              />
              <Boton
                titulo="Usar Android"
                variante="secundario"
                onPress={() => elegirImpresora({tipo: "sistema"})}
                deshabilitado={configurando}
                estilo={{ flex: 1 }}
              />
              <Boton
                titulo="Sin impresora"
                variante="secundario"
                onPress={() => elegirImpresora({tipo: "ninguna"})}
                deshabilitado={configurando}
                estilo={{ flex: 1 }}
              />
            </View>
            <Boton
              titulo="Imprimir prueba"
              onPress={async () => {
                try {
                  await impresora.imprimir({
                    negocio: "Wybix",
                    ubicacion: "Prueba de impresión",
                    folio: "PRUEBA",
                    fecha: new Date().toLocaleString("es-MX"),
                    cajero: persona?.name ?? "-",
                    lineas: [
                      {
                        cantidad: "1",
                        nombre: "Ticket de prueba",
                        importe: "$0.00",
                      },
                    ],
                    total: "$0.00",
                    pagos: [],
                    cambio: "0",
                  });
                  setMsg({ texto: "Prueba enviada.", tono: "exito" });
                } catch (e) {
                  setMsg({
                    texto: `No se pudo imprimir: ${(e as Error).message}`,
                    tono: "peligro",
                  });
                }
              }}
            />
            {msg && (
              <Pressable onPress={() => setMsg(null)}>
                <Aviso tono={msg.tono} texto={msg.texto} />
              </Pressable>
            )}
          </Tarjeta>

          <Tarjeta estilo={{ gap: 16, flex: wide ? 1 : undefined }}>
            <Text style={tipo.etiqueta}>DISPOSITIVO</Text>
            <Text style={tipo.subtitulo}>Versión</Text>
            <Text style={tipo.cuerpo}>
              Wybix POS Mobile {CONFIG.version}
              {minima ? ` · mínima permitida ${minima}` : ""}
            </Text>
            <Text style={tipo.tenue}>
              Canal {CONFIG.canal}
              {CONFIG.perfil === "desarrollo" ? " · DESARROLLO" : ""}
            </Text>
            {persona?.role !== "CASHIER" && (
              <Boton
                titulo="Reconstruir existencias desde los hechos"
                variante="fantasma"
                onPress={async () => {
                  const n = await pos?.reconstruirProyecciones();
                  setMsg({
                    texto: `Existencias reconstruidas de ${n} movimientos.`,
                    tono: "exito",
                  });
                }}
              />
            )}
          </Tarjeta>
        </View>
      </ScrollView>
      <Autorizar visible={!!configPendiente} accion="CONFIGURAR_IMPRESORA"
        motivo="Cambiar la configuración de la impresora de tickets."
        alCancelar={() => { if (!lockConfig.current) setConfigPendiente(null); }}
        alAutorizar={aut => { if (configPendiente) void guardarImpresora(configPendiente, aut); }} />
    </Pantalla>
  );
}

const s = StyleSheet.create({
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
