/**
 * VENTAS DEL TURNO: buscar una venta, reimprimir su ticket, mandarlo por
 * WhatsApp y devolver (todo o parte), sin Internet.
 *
 * Devolver es de encargado: un cajero pide autorización (PIN del encargado o
 * aprobación desde Owner, el mismo componente que retiros y mermas). Lo que
 * regresa vuelve al inventario del evento y el efectivo sale del cajón.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, FlatList, TextInput, StyleSheet, Share, Linking } from "react-native";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Dec, normalizar, puede, type CatalogoIndexado } from "@wybix/domain";
import type { Persona } from "@wybix/database";
import { Marco, useAncho } from "../../components/Marco";
import { Aviso, Boton, Sheet, dinero, pos as t, tipo } from "../../components/ui";
import { Autorizar } from "../../components/Autorizar";
import { usePos } from "../../lib/contexto";
import { imprimirGuardado, textoTicket } from "../../lib/ticket-guardado";

type Venta = Awaited<ReturnType<NonNullable<ReturnType<typeof usePos>["pos"]>["ventasDelTurno"]>>[number];
type Detalle = NonNullable<Awaited<ReturnType<NonNullable<ReturnType<typeof usePos>["pos"]>["detalleVenta"]>>>;

const METODO: Record<string, string> = { EFECTIVO: "Efectivo", TARJETA: "Tarjeta", TRANSFERENCIA: "Transferencia", PLATAFORMA: "Plataforma", MIXTO: "Varias formas" };
const hora = (iso: string) => new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });

export default function Ventas() {
  const { pos, persona, impresora, sync } = usePos();
  const ancho = useAncho();
  const [ventas, setVentas] = useState<Venta[]>([]);
  const [filtro, setFiltro] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<Detalle | null>(null);
  const [msg, setMsg] = useState<{ tono: "exito" | "aviso" | "peligro"; texto: string } | null>(null);
  const [devolviendo, setDevolviendo] = useState(false);
  // Para nombrar el paquete de un renglón («Dona glaseada · Caja 6»).
  const [cat, setCat] = useState<CatalogoIndexado | null>(null);
  useEffect(() => { pos?.catalogoActual().then(setCat).catch(() => setCat(null)); }, [pos, sync.ultima_sincronizacion]);
  // Teléfono: la venta se abre en una hoja; tablet: lista y ficha lado a lado.
  const [verFicha, setVerFicha] = useState(false);

  const cargar = useCallback(async () => {
    if (!pos) return;
    const v = await pos.ventasDelTurno().catch(() => []);
    setVentas(v);
    setSel((x) => x ?? v[0]?.uuid ?? null);
  }, [pos]);
  useFocusEffect(useCallback(() => { void cargar(); }, [cargar]));
  useEffect(() => { void cargar(); }, [sync.ultima_sincronizacion, cargar]);
  useEffect(() => {
    if (!pos || !sel) { setDetalle(null); return; }
    let vivo = true;
    pos.detalleVenta(sel).then((d) => { if (vivo) setDetalle(d); }).catch(() => { if (vivo) setDetalle(null); });
    return () => { vivo = false; };
  }, [pos, sel, ventas]);

  // Folio, importe o producto, sin acentos.
  const visibles = useMemo(() => {
    const q = normalizar(filtro);
    if (!q) return ventas;
    return ventas.filter((v) => normalizar(`${v.folio} ${v.total} ${v.resumen ?? ""}`).includes(q));
  }, [ventas, filtro]);
  const totalTurno = useMemo(() => Dec.suma(ventas.map((v) => Dec.de(v.total).menos(v.refunded_total))).fijo(2), [ventas]);

  const reimprimir = async () => {
    if (!pos || !persona || !detalle) return;
    try {
      await imprimirGuardado(pos, impresora, detalle.uuid, persona);
      setMsg({ tono: "exito", texto: `Ticket ${detalle.folio} impreso.` });
      void cargar();
    } catch (e) { setMsg({ tono: "aviso", texto: (e as Error).message }); }
  };
  const compartir = async () => {
    if (!pos || !detalle) return;
    try {
      const texto = await textoTicket(pos, detalle.uuid);
      // WhatsApp si está instalado; si no, la hoja de compartir del sistema.
      const wa = `whatsapp://send?text=${encodeURIComponent(texto)}`;
      if (await Linking.canOpenURL(wa).catch(() => false)) await Linking.openURL(wa);
      else await Share.share({ message: texto });
    } catch (e) { setMsg({ tono: "aviso", texto: (e as Error).message }); }
  };

  const fila = ({ item: v }: { item: Venta }) => {
    const on = v.uuid === sel;
    const devuelta = v.status === "RETURNED";
    const parcial = !devuelta && Dec.de(v.refunded_total).esPositivo();
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        accessibilityLabel={`Venta ${v.folio}, ${hora(v.occurred_at)}, ${dinero(v.total)}`}
        onPress={() => { setSel(v.uuid); if (!ancho) setVerFicha(true); }}
        style={[s.fila, on && { backgroundColor: t.acentoSuave }]}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={tipo.subtitulo}>#{v.folio} · {hora(v.occurred_at)}</Text>
          <Text style={tipo.tenue} numberOfLines={1}>{v.resumen ?? ""}</Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <Text style={[tipo.numero, { fontSize: 16 }]}>{dinero(v.total)}</Text>
          <Text style={[tipo.etiqueta, s.estado, devuelta ? s.rojo : parcial ? s.ambar : v.printed ? s.verde : s.ambar]}>
            {devuelta ? "Devuelta" : parcial ? `Devuelto ${dinero(v.refunded_total)}` : v.printed ? "Impresa" : "Sin imprimir"}
          </Text>
        </View>
      </Pressable>
    );
  };

  const lista = (
    <View style={[s.panel, ancho ? { width: 440 } : { flex: 1 }]}>
      <View style={{ padding: 14, gap: 10, borderBottomWidth: 1, borderColor: t.hundido }}>
        <Text style={tipo.subtitulo}>{ventas.length} {ventas.length === 1 ? "venta" : "ventas"} · {dinero(totalTurno)}</Text>
        <View style={s.buscar}>
          <Ionicons name="search" size={18} color={t.tenue} />
          <TextInput
            value={filtro}
            onChangeText={setFiltro}
            placeholder="Folio, importe o producto"
            placeholderTextColor={t.tenue}
            accessibilityLabel="Buscar venta"
            style={{ flex: 1, minHeight: 44, fontSize: 15, color: t.texto }}
          />
        </View>
      </View>
      <FlatList
        data={visibles}
        keyExtractor={(v) => v.uuid}
        renderItem={fila}
        initialNumToRender={12}
        windowSize={7}
        ListEmptyComponent={<Text style={[tipo.tenue, { padding: 16 }]}>{ventas.length ? "Ninguna venta coincide." : "Todavía no hay ventas en este turno."}</Text>}
      />
    </View>
  );

  const ficha = detalle && (
    <View style={[s.panel, { flex: 1, padding: 18, gap: 14 }]}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={{ gap: 4, flex: 1 }}>
          <Text style={[tipo.titulo, { fontSize: 22 }]}>Venta #{detalle.folio}</Text>
          <Text style={tipo.tenue}>{hora(detalle.occurred_at)} · {detalle.pagos.map((p) => METODO[p.method] ?? p.method).join(" y ")}</Text>
        </View>
        <Text style={[tipo.numero, { fontSize: 26 }]}>{dinero(detalle.total)}</Text>
      </View>
      <View style={s.lineas}>
        {agrupar(detalle.lineas, cat).map((l) => (
          <View key={l.clave} style={s.linea}>
            <Text style={[tipo.numero, { minWidth: 34 }]}>{l.cantidad}</Text>
            <View style={{ flex: 1 }}>
              <Text style={tipo.cuerpo}>{l.nombre}</Text>
              {l.devueltas !== "0" && <Text style={[tipo.tenue, { color: t.peligro }]}>Devueltas {l.devueltas} piezas</Text>}
            </View>
            <Text style={tipo.numero}>{dinero(l.importe)}</Text>
          </View>
        ))}
      </View>
      {Dec.de(detalle.refunded_total).esPositivo() && <Aviso tono="aviso" texto={`Se devolvieron ${dinero(detalle.refunded_total)} de esta venta.`} />}
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Accion icono="print-outline" titulo="Reimprimir" nota="Queda registrado quién y cuándo" onPress={reimprimir} deshabilitado={!persona || !puede(persona.role, "REIMPRIMIR")} />
        <Accion icono="logo-whatsapp" titulo="Mandar ticket" nota="Por WhatsApp, sin papel" onPress={compartir} />
        <Accion icono="return-down-back-outline" titulo="Devolver" nota="PIN de encargado o aprobación en Owner" peligro
          deshabilitado={detalle.status === "RETURNED"} onPress={() => setDevolviendo(true)} />
      </View>
    </View>
  );

  return (
    <Marco seccion="ventas" titulo="Ventas del turno">
      {msg && <Pressable onPress={() => setMsg(null)} style={{ paddingBottom: 10 }}><Aviso tono={msg.tono} texto={msg.texto} /></Pressable>}
      {ancho ? (
        <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>{lista}{ficha ?? <View style={[s.panel, { flex: 1 }]} />}</View>
      ) : (
        <>
          {lista}
          <Sheet visible={verFicha && !!detalle && !devolviendo} onClose={() => setVerFicha(false)} title={detalle ? `Venta #${detalle.folio}` : "Venta"}
            footer={<Boton titulo="Cerrar" variante="secundario" onPress={() => setVerFicha(false)} />}>{ficha}</Sheet>
        </>
      )}
      {detalle && persona && (
        <Devolucion
          visible={devolviendo}
          detalle={detalle}
          cat={cat}
          persona={persona}
          alCerrar={() => setDevolviendo(false)}
          alTerminar={(texto) => { setDevolviendo(false); setMsg({ tono: "exito", texto }); void cargar(); }}
        />
      )}
    </Marco>
  );
}

type LineaVenta = Detalle["lineas"][number];

/** «Dona glaseada · Caja 6» si el renglón se vendió en paquete. */
function nombreLinea(l: LineaVenta, cat: CatalogoIndexado | null) {
  if (!l.presentation_id) return l.product_name;
  const x = cat?.producto.get(l.product_uuid)?.presentations?.find((p) => p.id === l.presentation_id);
  return `${l.product_name} · ${x?.name ?? "paquete"}`;
}

/**
 * Un paquete se guarda repartido en renglones (el centavo que no divide queda
 * en la última pieza): para leer la venta se juntan otra vez.
 */
function agrupar(lineas: LineaVenta[], cat: CatalogoIndexado | null) {
  const m = new Map<string, { clave: string; nombre: string; cantidad: Dec; importe: Dec; devueltas: Dec }>();
  for (const l of lineas) {
    const clave = l.presentation_id ? `${l.product_uuid}|${l.presentation_id}` : `${l.product_uuid}|${l.line_no}`;
    const g = m.get(clave) ?? { clave, nombre: nombreLinea(l, cat), cantidad: Dec.cero, importe: Dec.cero, devueltas: Dec.cero };
    g.cantidad = g.cantidad.mas(l.quantity); g.importe = g.importe.mas(l.subtotal); g.devueltas = g.devueltas.mas(l.returned_qty);
    m.set(clave, g);
  }
  return [...m.values()].map((g) => ({ clave: g.clave, nombre: g.nombre, cantidad: g.cantidad.toString(), importe: g.importe.fijo(2), devueltas: g.devueltas.toString() }));
}

function Accion({ icono, titulo, nota, onPress, peligro, deshabilitado }: {
  icono: keyof typeof Ionicons.glyphMap; titulo: string; nota: string; onPress: () => void; peligro?: boolean; deshabilitado?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${titulo}. ${nota}`}
      accessibilityState={{ disabled: !!deshabilitado }}
      disabled={deshabilitado}
      onPress={onPress}
      style={[s.accion, peligro && { borderColor: "rgba(240,85,91,0.35)", backgroundColor: t.peligroSuave }, deshabilitado && { opacity: 0.45 }]}
    >
      <Ionicons name={icono} size={20} color={peligro ? t.peligro : t.texto} />
      <Text style={[tipo.subtitulo, { fontSize: 15, color: peligro ? t.peligro : t.texto }]}>{titulo}</Text>
      <Text style={[tipo.tenue, { fontSize: 12 }]}>{nota}</Text>
    </Pressable>
  );
}

/** Qué regresa el cliente, por renglón y pieza. Lo que falta autorizar lo pide Autorizar. */
function Devolucion({ visible, detalle, cat, persona, alCerrar, alTerminar }: {
  visible: boolean; detalle: Detalle; cat: CatalogoIndexado | null; persona: Persona; alCerrar: () => void; alTerminar: (texto: string) => void;
}) {
  const { pos } = usePos();
  // Piezas a devolver por GRUPO (un paquete repartido en renglones es uno solo).
  const [cant, setCant] = useState<Record<string, number>>({});
  const [razon, setRazon] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pidiendo, setPidiendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  useEffect(() => { if (visible) { setCant({}); setRazon(""); setError(null); } }, [visible]);
  const grupos = useMemo(() => {
    const m = new Map<string, { clave: string; nombre: string; queda: number; lineas: Array<{ line_no: number; queda: number }> }>();
    for (const l of detalle.lineas) {
      const queda = Number(Dec.de(l.quantity).menos(l.returned_qty).toString());
      if (queda <= 0) continue;
      const clave = l.presentation_id ? `${l.product_uuid}|${l.presentation_id}` : `${l.product_uuid}|${l.line_no}`;
      const g = m.get(clave) ?? { clave, nombre: nombreLinea(l, cat), queda: 0, lineas: [] };
      g.queda += queda; g.lineas.push({ line_no: l.line_no, queda });
      m.set(clave, g);
    }
    return [...m.values()];
  }, [detalle, cat]);
  // Lo pedido por grupo se reparte entre sus renglones, del primero al último.
  const partidas = grupos.flatMap((g) => {
    let resta = cant[g.clave] ?? 0;
    return g.lineas.flatMap((l) => { const q = Math.min(resta, l.queda); resta -= q; return q > 0 ? [{ line_no: l.line_no, quantity: q }] : []; });
  });
  const importe = Dec.suma(partidas.map((x) => {
    const l = detalle.lineas.find((y) => y.line_no === x.line_no)!;
    return Dec.de(l.subtotal).por(x.quantity).dividir(l.quantity).redondear(2);
  })).fijo(2);
  const ejecutar = async (aut: Persona | null) => {
    if (!pos) return;
    setGuardando(true);
    try {
      const r = await pos.devolverVenta(persona, detalle.uuid, partidas, razon, aut);
      alTerminar(`Devolución de ${dinero(r.importe)} registrada. Sale del cajón y entra al corte.`);
    } catch (e) { setError((e as Error).message); }
    finally { setGuardando(false); }
  };
  const confirmar = () => {
    setError(null);
    if (!partidas.length) return setError("Elige qué regresa el cliente.");
    if (!razon.trim()) return setError("Escribe por qué se devuelve.");
    if (puede(persona.role, "DEVOLUCION")) void ejecutar(null);
    else setPidiendo(true);
  };
  return (
    <>
      <Sheet
        visible={visible && !pidiendo}
        onClose={alCerrar}
        busy={guardando}
        title={`Devolver de la venta #${detalle.folio}`}
        subtitle="Lo que regresa vuelve al inventario y el dinero sale del cajón."
        footer={<Boton titulo={`Devolver ${dinero(importe)}`} cargando={guardando} textoCargando="Guardando…" onPress={confirmar} />}
      >
        {grupos.map((g) => {
          const q = cant[g.clave] ?? 0;
          const mover = (d: number) => setCant((c) => ({ ...c, [g.clave]: Math.min(g.queda, Math.max(0, q + d)) }));
          return (
            <View key={g.clave} style={s.linea}>
              <View style={{ flex: 1 }}>
                <Text style={tipo.cuerpo}>{g.nombre}</Text>
                <Text style={tipo.tenue}>Se pueden devolver {g.queda} {g.queda === 1 ? "pieza" : "piezas"}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`Una menos de ${g.nombre}`} onPress={() => mover(-1)} style={s.paso}><Text style={s.pasoTxt}>−</Text></Pressable>
              <Text style={[tipo.numero, { minWidth: 30, textAlign: "center" }]}>{q}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Una más de ${g.nombre}`} onPress={() => mover(1)} style={s.paso}><Text style={s.pasoTxt}>+</Text></Pressable>
            </View>
          );
        })}
        <TextInput value={razon} onChangeText={setRazon} placeholder="Por qué se devuelve" placeholderTextColor={t.tenue}
          accessibilityLabel="Razón de la devolución" style={s.input} />
        {error && <Aviso tono="peligro" texto={error} />}
      </Sheet>
      <Autorizar
        visible={pidiendo}
        accion="DEVOLUCION"
        motivo={`Devolver ${dinero(importe)} de la venta #${detalle.folio}`}
        payload={{ venta: detalle.uuid, folio: detalle.folio, importe, partidas, razon }}
        alCancelar={() => setPidiendo(false)}
        alAutorizar={(aut) => { setPidiendo(false); void ejecutar(aut); }}
      />
    </>
  );
}

const s = StyleSheet.create({
  panel: { backgroundColor: t.superficie, borderRadius: 18, borderWidth: 1, borderColor: t.borde, overflow: "hidden" },
  buscar: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: t.borde, borderRadius: 12, paddingHorizontal: 12 },
  fila: { flexDirection: "row", gap: 12, alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, minHeight: 64, borderBottomWidth: 1, borderColor: t.hundido },
  estado: { fontSize: 11, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, overflow: "hidden" },
  verde: { color: t.exito, backgroundColor: t.exitoSuave },
  ambar: { color: t.aviso, backgroundColor: t.avisoSuave },
  rojo: { color: t.peligro, backgroundColor: t.peligroSuave },
  lineas: { borderWidth: 1, borderColor: t.hundido, borderRadius: 14 },
  linea: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderColor: t.hundido, minHeight: 56 },
  accion: { flexGrow: 1, flexBasis: 180, minHeight: 84, borderRadius: 14, borderWidth: 1, borderColor: t.borde, padding: 12, gap: 4 },
  paso: { width: 44, height: 44, borderRadius: 12, backgroundColor: t.hundido, alignItems: "center", justifyContent: "center" },
  pasoTxt: { fontSize: 22, color: t.texto },
  input: { borderWidth: 1.5, borderColor: t.borde, borderRadius: t.radio, minHeight: 48, paddingHorizontal: 12, fontSize: 16, color: t.texto, marginTop: 10 },
});
