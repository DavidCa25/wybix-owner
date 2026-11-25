/**
 * CONTEO CON ESCÁNER: se cuenta escaneando (cada lectura suma una pieza; un
 * código de paquete suma sus piezas) o con +/−, y se ve al momento la
 * diferencia contra lo que dice la tablet. Al aplicar, cada diferencia es un
 * ajuste, todo en una transacción (pos.aplicarConteo). Es de encargado.
 *
 * Funciona sin Internet: los ajustes suben con la siguiente sincronización.
 */
import { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, FlatList, TextInput, StyleSheet } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Dec, buscarEntradas, indiceDeVenta, porCodigo, puede, type CatalogoIndexado } from "@wybix/domain";
import type { Persona } from "@wybix/database";
import { Marco, useAncho } from "../../components/Marco";
import { Aviso, Boton, Sheet, pos as t, tipo } from "../../components/ui";
import { Autorizar } from "../../components/Autorizar";
import { Escaner } from "../../components/Escaner";
import { usePos } from "../../lib/contexto";

export default function Conteo() {
  const { pos, persona } = usePos();
  const ancho = useAncho();
  const router = useRouter();
  const [cat, setCat] = useState<CatalogoIndexado | null>(null);
  const [stock, setStock] = useState<Record<string, string>>({});
  // product_uuid -> piezas contadas (en el orden en que se contaron).
  const [contado, setContado] = useState<Map<string, number>>(new Map());
  const [buscar, setBuscar] = useState("");
  const [escaneando, setEscaneando] = useState(false);
  const [ultimo, setUltimo] = useState<string | null>(null);
  const [revisando, setRevisando] = useState(false);
  const [razon, setRazon] = useState("");
  const [pidiendo, setPidiendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState<{ tono: "exito" | "aviso" | "peligro"; texto: string } | null>(null);

  useFocusEffect(useCallback(() => {
    if (!pos) return;
    pos.catalogoActual().then(setCat).catch(() => setCat(null));
    pos.stock().then((s) => setStock(Object.fromEntries(s.map((x) => [x.product_uuid, x.qty])))).catch(() => undefined);
  }, [pos]));

  const indice = useMemo(() => (cat ? indiceDeVenta(cat).filter((e) => !e.presentation_id) : []), [cat]);
  const sumar = (uuid: string, n: number) =>
    setContado((m) => { const x = new Map(m); x.set(uuid, Math.max(0, (x.get(uuid) ?? 0) + n)); return x; });
  const leer = (codigo: string) => {
    if (!cat) return;
    const hit = porCodigo(cat, codigo);
    if (!hit) { setUltimo(`El código ${codigo} no está en el catálogo.`); return; }
    sumar(hit.product_uuid, hit.piezas);
    setUltimo(`${cat.producto.get(hit.product_uuid)?.nombre ?? "Producto"} +${hit.piezas}`);
  };
  const filas = useMemo(() => [...contado.entries()].map(([uuid, n]) => {
    const antes = Dec.de(stock[uuid] ?? "0");
    const dif = Dec.de(n).menos(antes);
    return { uuid, nombre: cat?.producto.get(uuid)?.nombre ?? uuid, contado: n, antes: antes.toString(), dif };
  }).reverse(), [contado, stock, cat]);
  const conDiferencia = filas.filter((f) => !f.dif.esCero());
  const sugerencias = useMemo(() => (buscar.trim() ? buscarEntradas(indice, buscar, { limite: 6 }) : []), [indice, buscar]);

  const aplicar = async (aut: Persona | null) => {
    if (!pos || !persona) return;
    setGuardando(true);
    try {
      const r = await pos.aplicarConteo(persona, filas.map((f) => ({ product_uuid: f.uuid, contado: f.contado })), razon, aut);
      setRevisando(false);
      setContado(new Map());
      setRazon("");
      setMsg({ tono: "exito", texto: r.ajustes.length ? `Conteo aplicado: ${r.ajustes.length} ${r.ajustes.length === 1 ? "ajuste" : "ajustes"}.` : "Todo cuadró: no hubo ajustes." });
      pos.stock().then((s) => setStock(Object.fromEntries(s.map((x) => [x.product_uuid, x.qty])))).catch(() => undefined);
    } catch (e) { setMsg({ tono: "peligro", texto: (e as Error).message }); }
    finally { setGuardando(false); }
  };
  const confirmar = () => {
    if (!persona) return;
    if (!razon.trim()) { setMsg({ tono: "aviso", texto: "Escribe de qué es el conteo (pasillo, cierre…)." }); return; }
    if (puede(persona.role, "AJUSTE")) void aplicar(null);
    else { setRevisando(false); setPidiendo(true); }
  };

  return (
    <Marco seccion="inventario" titulo="Conteo con escáner">
      <View style={{ flex: 1, gap: 12, paddingHorizontal: ancho ? 0 : 16 }}>
        {msg && <Pressable onPress={() => setMsg(null)}><Aviso tono={msg.tono} texto={msg.texto} /></Pressable>}
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Boton titulo="Escanear" onPress={() => { setUltimo(null); setEscaneando(true); }} estilo={{ flex: 1, minHeight: 56 }} />
          <Boton titulo="Volver a inventario" variante="secundario" onPress={() => router.push("/caja/inventario")} estilo={{ flex: 1, minHeight: 56 }} />
        </View>
        <View style={s.buscar}>
          <Ionicons name="search" size={18} color={t.tenue} />
          <TextInput value={buscar} onChangeText={setBuscar} placeholder="Agregar sin código: busca el producto" placeholderTextColor={t.tenue}
            accessibilityLabel="Buscar producto para contar" style={{ flex: 1, minHeight: 48, fontSize: 15, color: t.texto }}
            onSubmitEditing={() => { leer(buscar.trim()); setBuscar(""); }} />
        </View>
        {sugerencias.map((e) => (
          <Pressable key={e.clave} accessibilityRole="button" onPress={() => { sumar(e.product_uuid, 1); setBuscar(""); }} style={s.sugerencia}>
            <Text style={tipo.cuerpo}>{e.nombre}</Text>
            <Text style={tipo.tenue}>+1</Text>
          </Pressable>
        ))}
        <FlatList
          data={filas}
          keyExtractor={(f) => f.uuid}
          style={{ flex: 1 }}
          ListEmptyComponent={<Text style={[tipo.tenue, { padding: 16 }]}>Escanea o busca lo primero que vas a contar.</Text>}
          renderItem={({ item: f }) => (
            <View style={s.fila}>
              <View style={{ flex: 1 }}>
                <Text style={tipo.cuerpo} numberOfLines={2}>{f.nombre}</Text>
                <Text style={[tipo.tenue, { color: f.dif.esCero() ? t.exito : f.dif.esNegativo() ? t.peligro : t.acentoTinta }]}>
                  Sistema {f.antes} · {f.dif.esCero() ? "cuadra" : `${f.dif.esNegativo() ? "" : "+"}${f.dif.toString()}`}
                </Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`Una menos de ${f.nombre}`} onPress={() => sumar(f.uuid, -1)} style={s.paso}><Text style={s.pasoTxt}>−</Text></Pressable>
              <Text style={[tipo.numero, { fontSize: 22, minWidth: 48, textAlign: "center" }]}>{f.contado}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Una más de ${f.nombre}`} onPress={() => sumar(f.uuid, 1)} style={[s.paso, { backgroundColor: t.navy }]}><Text style={[s.pasoTxt, { color: "#fff" }]}>+</Text></Pressable>
            </View>
          )}
        />
        <Boton
          titulo={filas.length ? `Revisar y aplicar · ${conDiferencia.length} con diferencia` : "Revisar y aplicar"}
          deshabilitado={!filas.length}
          onPress={() => setRevisando(true)}
          estilo={{ minHeight: 58, marginBottom: 12 }}
        />
      </View>
      <Escaner visible={escaneando} modo="barras" titulo="Cuenta escaneando" pie={ultimo} alLeer={leer} alCerrar={() => setEscaneando(false)} />
      <Sheet
        visible={revisando}
        onClose={() => setRevisando(false)}
        busy={guardando}
        title="Aplicar el conteo"
        subtitle={conDiferencia.length ? "Estas diferencias se ajustan en el inventario de la tablet." : "Todo lo contado cuadra con la tablet."}
        footer={<Boton titulo="Aplicar conteo" cargando={guardando} textoCargando="Aplicando…" onPress={confirmar} />}
      >
        {conDiferencia.map((f) => (
          <View key={f.uuid} style={[s.fila, { minHeight: 48 }]}>
            <Text style={[tipo.cuerpo, { flex: 1 }]}>{f.nombre}</Text>
            <Text style={[tipo.numero, { color: f.dif.esNegativo() ? t.peligro : t.acentoTinta }]}>{f.dif.esNegativo() ? "" : "+"}{f.dif.toString()}</Text>
          </View>
        ))}
        <TextInput value={razon} onChangeText={setRazon} placeholder="De qué es el conteo (p. ej. Pasillo 3, cierre)" placeholderTextColor={t.tenue}
          accessibilityLabel="Razón del conteo" style={s.input} />
      </Sheet>
      <Autorizar
        visible={pidiendo}
        accion="AJUSTE"
        motivo={`Aplicar un conteo con ${conDiferencia.length} diferencias`}
        payload={{ conteo: filas.map((f) => ({ producto: f.uuid, contado: f.contado })), razon }}
        alCancelar={() => setPidiendo(false)}
        alAutorizar={(aut) => { setPidiendo(false); void aplicar(aut); }}
      />
    </Marco>
  );
}

const s = StyleSheet.create({
  buscar: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: t.borde, borderRadius: 12, paddingHorizontal: 12, backgroundColor: t.superficie },
  sugerencia: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 48, paddingHorizontal: 12, borderRadius: 12, backgroundColor: t.superficie },
  fila: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 64, borderBottomWidth: 1, borderColor: t.hundido },
  paso: { width: 48, height: 48, borderRadius: 12, backgroundColor: t.hundido, alignItems: "center", justifyContent: "center" },
  pasoTxt: { fontSize: 24, color: t.texto },
  input: { borderWidth: 1.5, borderColor: t.borde, borderRadius: t.radio, minHeight: 48, paddingHorizontal: 12, fontSize: 16, color: t.texto, marginTop: 10 },
});
