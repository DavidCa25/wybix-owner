/**
 * INVENTARIO DEL EVENTO: lo que hay es la suma de los hechos (recibido,
 * vendido, mermado, ajustado, regresado). Nunca se escribe "hay 8".
 */
import { useCallback, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { Dec, puede, type Accion, type CatalogoIndexado } from "@wybix/domain";
import { importarTransferencia, type Persona } from "@wybix/database";
import { verificarQr, aTransferencia } from "@wybix/sync";
import {
  Pantalla,
  Aviso,
  Boton,
  Tarjeta,
  pos as t,
  tipo,
} from "../../components/ui";
import { usePos } from "../../lib/contexto";
import { Encabezado } from "../../components/Encabezado";
import { Autorizar } from "../../components/Autorizar";
import { Escaner } from "../../components/Escaner";

interface Pendiente {
  uuid: string;
  source: string;
  lineas: Array<{
    product_uuid: string;
    product_name: string | null;
    qty_sent: string;
  }>;
}

export default function Inventario() {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
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
  const { width, fontScale } = useWindowDimensions();
  const wide = width >= 1000 && fontScale <= 1.3;
  const [search, setSearch] = useState("");
  const { pos, db, persona, identidad } = usePos();
  const [cat, setCat] = useState<CatalogoIndexado | null>(null);
  const [stock, setStock] = useState<
    Array<{ product_uuid: string; qty: string }>
  >([]);
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const [recibiendo, setRecibiendo] = useState<{
    t: Pendiente;
    cant: Record<string, string>;
  } | null>(null);
  const [manual, setManual] = useState<{
    tipo: "WASTE" | "ADJUSTMENT";
    producto: string | null;
    cantidad: string;
    razon: string;
  } | null>(null);
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
  const [escanear, setEscanear] = useState(false);

  const cargar = useCallback(async () => {
    if (!pos || !db) return;
    try {
      setCat(await pos.catalogoActual());
    } catch {
      setCat(null);
    }
    setStock(await pos.stock());
    const ts = await db.all<{ uuid: string; source: string }>(
      `SELECT uuid, source FROM transfers WHERE kind = 'IN' AND status = 'PENDING' ORDER BY created_at`,
    );
    setPendientes(
      await Promise.all(
        ts.map(async (x) => ({
          ...x,
          lineas: await db.all<Pendiente["lineas"][number]>(
            "SELECT product_uuid, product_name, qty_sent FROM transfer_lines WHERE transfer_uuid = ?",
            [x.uuid],
          ),
        })),
      ),
    );
  }, [pos, db]);
  useFocusEffect(
    useCallback(() => {
      cargar();
    }, [cargar]),
  );

  const nombre = (u: string) => cat?.producto.get(u)?.nombre ?? u.slice(0, 8);

  const conPermiso = async (
    accion: Accion,
    motivo: string,
    hacer: (aut: Persona | null) => Promise<void>,
    payload?: Record<string, unknown>,
  ) => {
    if (!persona) return;
    if (!puede(persona.role, accion)) {
      setPidiendo({ accion, motivo, payload, hacer: (a) => hacer(a) });
      return;
    }
    try {
      await run(async () => {
        await hacer(null);
      });
    } catch (e) {
      setMsg({ tono: "peligro", texto: (e as Error).message });
    }
  };

  const recibir = () =>
    recibiendo &&
    conPermiso(
      "RECIBIR_TRANSFERENCIA",
      "Recibir mercancía de la sucursal",
      async (aut) => {
        const r = await pos!.recibirTransferencia(
          persona!,
          recibiendo.t.uuid,
          recibiendo.cant,
          aut,
        );
        const dif = r.lineas?.filter((l) => Number(l.difference) !== 0) ?? [];
        setMsg({
          tono: dif.length ? "aviso" : "exito",
          texto: dif.length
            ? `Recibido con diferencias: ${dif.map((l) => `${nombre(l.product_uuid)} ${l.difference}`).join(", ")}`
            : "Mercancía recibida.",
        });
        setRecibiendo(null);
        cargar();
      },
      { transfer: recibiendo.t.uuid, recibido: Object.entries(recibiendo.cant).map(([u, q]) => ({ product_uuid: u, producto: nombre(u), cantidad: q })) },
    );

  const guardarManual = () =>
    manual?.producto &&
    conPermiso(
      manual.tipo === "WASTE" ? "MERMA" : "AJUSTE",
      manual.tipo === "WASTE" ? "Registrar una merma" : "Ajustar inventario",
      async (aut) => {
        if (manual.tipo === "WASTE")
          await pos!.registrarMerma(
            persona!,
            manual.producto!,
            manual.cantidad,
            manual.razon,
            aut,
          );
        else
          await pos!.registrarAjuste(
            persona!,
            manual.producto!,
            manual.cantidad,
            manual.razon,
            aut,
          );
        setMsg({
          tono: "exito",
          texto:
            manual.tipo === "WASTE"
              ? "Merma registrada."
              : "Ajuste registrado.",
        });
        setManual(null);
        cargar();
      },
      { producto: nombre(manual.producto), product_uuid: manual.producto, cantidad: manual.cantidad, razon: manual.razon },
    );

  const regresar = () =>
    conPermiso("RETORNO", "Regresar el sobrante a la sucursal", async (aut) => {
      const lineas = stock
        .filter((s) => Dec.de(s.qty).esPositivo())
        .map((s) => ({ product_uuid: s.product_uuid, quantity: s.qty }));
      const r = await pos!.regresarSobrante(persona!, lineas, aut);
      setMsg({
        tono: "exito",
        texto: `Sobrante enviado a la sucursal: ${r.lineas.map((l) => `${l.qty_sent} ${nombre(l.product_uuid)}`).join(", ")}`,
      });
      cargar();
    }, { lineas: stock.filter((s) => Dec.de(s.qty).esPositivo()).map((s) => ({ product_uuid: s.product_uuid, producto: nombre(s.product_uuid), cantidad: s.qty })) });

  const leerQr = async (texto: string) => {
    setEscanear(false);
    if (!db || !identidad) return;
    const llaves = await db.all<{ key_id: string; public_key: string }>(
      "SELECT key_id, public_key FROM trusted_keys",
    );
    const r = verificarQr(texto, llaves, {
      company_uuid: identidad.company_uuid,
      location_uuid: identidad.location_uuid,
    });
    if (!r.ok) {
      setMsg({ tono: "peligro", texto: r.error });
      return;
    }
    try {
      const imp = await importarTransferencia(
        db,
        aTransferencia(r.manifiesto),
        r.firma,
      );
      setMsg({
        tono: "exito",
        texto: imp.nueva
          ? "Comprobante válido: revisa y confirma lo recibido."
          : "Ese comprobante ya estaba registrado.",
      });
      cargar();
    } catch (e) {
      setMsg({ tono: "peligro", texto: (e as Error).message });
    }
  };

  return (
    <Pantalla>
      <Encabezado titulo="Inventario del evento" />
      <ScrollView
        contentContainerStyle={{
          padding: 24,
          gap: 20,
          maxWidth: 1200,
          width: "100%",
          alignSelf: "center",
        }}
      >
        {msg && (
          <Pressable onPress={() => setMsg(null)}>
            <Aviso tono={msg.tono} texto={msg.texto} />
          </Pressable>
        )}

        <View style={{ flexDirection: wide ? "row" : "column", gap: 24 }}>
          <View style={{ flex: 1, gap: 20 }}>
            <Tarjeta estilo={{ gap: 16 }}>
              <Text style={tipo.etiqueta}>RECEPCIONES</Text>
              <View style={s.fila}>
                <Text style={tipo.subtitulo}>Mercancía por recibir</Text>
                <Text style={[tipo.numero, { color: t.acento }]}>
                  {pendientes.length}
                </Text>
              </View>
              {pendientes.map((p) => (
                <View
                  key={p.uuid}
                  style={{
                    gap: 6,
                    borderTopWidth: 1,
                    borderColor: t.hundido,
                    paddingTop: 8,
                  }}
                >
                  <Text style={tipo.tenue}>
                    {p.source === "QR"
                      ? "Comprobante QR"
                      : "Enviada por la sucursal"}
                  </Text>
                  {p.lineas.map((l) => (
                    <Text key={l.product_uuid} style={tipo.cuerpo}>
                      {Dec.de(l.qty_sent).toString()} ×{" "}
                      {l.product_name ?? nombre(l.product_uuid)}
                    </Text>
                  ))}
                  <Boton
                    testID="recibir"
                    titulo="Contar y recibir"
                    onPress={() =>
                      setRecibiendo({
                        t: p,
                        cant: Object.fromEntries(
                          p.lineas.map((l) => [
                            l.product_uuid,
                            Dec.de(l.qty_sent).toString(),
                          ]),
                        ),
                      })
                    }
                  />
                </View>
              ))}
              {!pendientes.length && (
                <Text style={tipo.tenue}>
                  Nada pendiente. Si llegó mercancía y no aparece, escanea el
                  comprobante de la sucursal.
                </Text>
              )}
              <Boton
                titulo="Escanear comprobante"
                variante="secundario"
                onPress={() => setEscanear(true)}
              />
            </Tarjeta>

            {recibiendo && (
              <Tarjeta estilo={{ gap: 8 }}>
                <Text style={tipo.subtitulo}>¿Cuánto llegó?</Text>
                <Text style={tipo.tenue}>
                  Anota lo que realmente recibiste. Si es distinto de lo
                  enviado, la diferencia queda registrada.
                </Text>
                {recibiendo.t.lineas.map((l) => (
                  <View key={l.product_uuid} style={s.fila}>
                    <Text style={[tipo.cuerpo, { flex: 1 }]}>
                      {l.product_name ?? nombre(l.product_uuid)} (enviado{" "}
                      {Dec.de(l.qty_sent).toString()})
                    </Text>
                    <TextInput
                      editable={!busy}
                      keyboardType="decimal-pad"
                      value={recibiendo.cant[l.product_uuid]}
                      accessibilityLabel={`Recibido de ${l.product_name}`}
                      onChangeText={(v) =>
                        setRecibiendo({
                          ...recibiendo,
                          cant: {
                            ...recibiendo.cant,
                            [l.product_uuid]: v.replace(/[^0-9.]/g, ""),
                          },
                        })
                      }
                      style={s.cant}
                    />
                  </View>
                ))}
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <Boton
                    titulo="Cancelar"
                    deshabilitado={busy}
                    variante="secundario"
                    onPress={() => setRecibiendo(null)}
                    estilo={{ flex: 1 }}
                  />
                  <Boton
                    testID="confirmar-recepcion"
                    titulo="Confirmar recepción"
                    cargando={busy}
                    onPress={recibir}
                    estilo={{ flex: 2 }}
                  />
                </View>
              </Tarjeta>
            )}
          </View>
          <View style={{ flex: 1, gap: 20 }}>
            <Tarjeta estilo={{ gap: 12 }}>
              <Text style={tipo.etiqueta}>INVENTARIO ACTUAL</Text>
              <Text style={tipo.subtitulo}>Existencias</Text>
              <TextInput
                accessibilityLabel="Buscar existencias"
                value={search}
                onChangeText={setSearch}
                placeholder="Buscar producto…"
                placeholderTextColor={t.tenue}
                style={s.input}
              />
              <View
                style={[
                  s.fila,
                  { backgroundColor: t.hundido, paddingHorizontal: 12 },
                ]}
              >
                <Text style={tipo.etiqueta}>PRODUCTO</Text>
                <Text style={tipo.etiqueta}>HAY</Text>
              </View>
              {stock
                .filter((x) =>
                  nombre(x.product_uuid)
                    .toLocaleLowerCase("es-MX")
                    .includes(search.trim().toLocaleLowerCase("es-MX")),
                )
                .map((x) => (
                  <View key={x.product_uuid} style={s.fila}>
                    <Text style={[tipo.cuerpo, { flex: 1 }]}>
                      {nombre(x.product_uuid)}
                    </Text>
                    <Text
                      style={[
                        tipo.numero,
                        Dec.de(x.qty).esNegativo() && { color: t.peligro },
                      ]}
                    >
                      {Dec.de(x.qty).toString()}
                    </Text>
                  </View>
                ))}
              {stock.some((x) => Dec.de(x.qty).esNegativo()) && (
                <Aviso texto="Hay existencias negativas: se concilian al cerrar el evento. Ninguna venta se pierde." />
              )}
              <View
                style={{
                  flexDirection: "row",
                  gap: 8,
                  flexWrap: "wrap",
                  marginTop: 8,
                }}
              >
                <Boton
                  titulo="Merma"
                  variante="secundario"
                  onPress={() =>
                    setManual({
                      tipo: "WASTE",
                      producto: null,
                      cantidad: "",
                      razon: "",
                    })
                  }
                  estilo={{ flex: 1 }}
                />
                <Boton
                  titulo="Ajuste"
                  variante="secundario"
                  onPress={() =>
                    setManual({
                      tipo: "ADJUSTMENT",
                      producto: null,
                      cantidad: "",
                      razon: "",
                    })
                  }
                  estilo={{ flex: 1 }}
                />
                <Boton
                  testID="regresar"
                  titulo="Regresar sobrante"
                  cargando={busy}
                  onPress={regresar}
                  estilo={{ flex: 2 }}
                  deshabilitado={!stock.some((x) => Dec.de(x.qty).esPositivo())}
                />
              </View>
            </Tarjeta>

            {manual && (
              <Tarjeta estilo={{ gap: 8 }}>
                <Text style={tipo.subtitulo}>
                  {manual.tipo === "WASTE"
                    ? "Merma"
                    : "Ajuste (+ entra / − sale)"}
                </Text>
                <View
                  style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                >
                  {[...(cat?.producto.values() ?? [])]
                    .filter((p) => p.active)
                    .map((p) => (
                      <Pressable
                        key={p.uuid}
                        disabled={busy}
                        accessibilityRole="radio"
                        accessibilityState={{
                          checked: manual.producto === p.uuid,
                        }}
                        onPress={() =>
                          setManual({ ...manual, producto: p.uuid })
                        }
                        style={[
                          s.chip,
                          manual.producto === p.uuid && {
                            backgroundColor: t.acento,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            tipo.cuerpo,
                            manual.producto === p.uuid && {
                              color: t.acentoTexto,
                            },
                          ]}
                        >
                          {p.nombre}
                        </Text>
                      </Pressable>
                    ))}
                </View>
                <TextInput
                  editable={!busy}
                  keyboardType="numbers-and-punctuation"
                  accessibilityLabel="Cantidad del movimiento"
                  placeholder="Cantidad"
                  value={manual.cantidad}
                  onChangeText={(v) =>
                    setManual({
                      ...manual,
                      cantidad: v.replace(/[^0-9.-]/g, ""),
                    })
                  }
                  style={s.input}
                />
                <TextInput
                  editable={!busy}
                  accessibilityLabel="Razón del movimiento, obligatoria"
                  placeholder="Razón (obligatoria)"
                  value={manual.razon}
                  onChangeText={(v) => setManual({ ...manual, razon: v })}
                  style={s.input}
                />
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <Boton
                    titulo="Cancelar"
                    deshabilitado={busy}
                    variante="secundario"
                    onPress={() => setManual(null)}
                    estilo={{ flex: 1 }}
                  />
                  <Boton
                    titulo="Registrar"
                    cargando={busy}
                    onPress={guardarManual}
                    estilo={{ flex: 2 }}
                    deshabilitado={
                      !manual.producto ||
                      !manual.cantidad ||
                      !manual.razon.trim()
                    }
                  />
                </View>
              </Tarjeta>
            )}
          </View>
        </View>
      </ScrollView>
      <Autorizar
        visible={!!pidiendo}
        accion={pidiendo?.accion ?? "MERMA"}
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
      <Escaner
        visible={escanear}
        titulo="Escanea el comprobante de la sucursal"
        alCerrar={() => setEscanear(false)}
        alLeer={leerQr}
      />
    </Pantalla>
  );
}

const s = StyleSheet.create({
  fila: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    minHeight: 56,
    gap: 12,
    borderBottomWidth: 1,
    borderColor: t.hundido,
  },
  cant: {
    width: 100,
    borderWidth: 1.5,
    borderColor: t.borde,
    borderRadius: t.radio,
    minHeight: 48,
    textAlign: "center",
    fontSize: 18,
    color: t.texto,
  },
  chip: {
    backgroundColor: t.hundido,
    borderRadius: 999,
    paddingHorizontal: 14,
    minHeight: 48,
    justifyContent: "center",
  },
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
