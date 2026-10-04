/**
 * VENDER, sin Internet. La venta se guarda completa en la tablet (venta,
 * líneas congeladas, pagos, inventario, caja, outbox) en UNA transacción. La
 * impresión va después: si falla, la venta sigue siendo válida.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import {
  Dec,
  type CatalogoIndexado,
  type LineaCarrito,
  type MetodoPago,
  type ProductoCat,
} from "@wybix/domain";
import {
  Aparece,
  Pulse,
  Sheet,
  Pantalla,
  Aviso,
  Boton,
  Teclado,
  teclear,
  dinero,
  pos as t,
  tipo,
} from "../../components/ui";
import { usePos } from "../../lib/contexto";
import { Encabezado } from "../../components/Encabezado";
import { imprimirGuardado } from "../../lib/ticket-guardado";

type Linea = LineaCarrito & {
  key: string;
  nombre: string;
  precio: string;
  etiqueta: string;
};

export default function Vender() {
  const { pos, db, persona, identidad, impresora, sync } = usePos();
  const router = useRouter();
  const { width, height, fontScale } = useWindowDimensions();
  const ancho = width >= 850 && fontScale <= 1.3;
  const compactAccount = !ancho && (height < 800 || fontScale > 1.3);
  const [cuentaVisible, setCuentaVisible] = useState(false);
  const columns =
    fontScale > 1.4
      ? 1
      : ancho
        ? width >= 1300
          ? 4
          : 3
        : width >= 560 && fontScale <= 1.3
          ? 3
          : 2;
  const [busqueda, setBusqueda] = useState("");
  const [guardando, setGuardando] = useState(false);
  const lock = useRef(false);
  const [cat, setCat] = useState<CatalogoIndexado | null>(null);
  const [stock, setStock] = useState<Record<string, string>>({});
  const [turno, setTurno] = useState<boolean | null>(null);
  const [carrito, setCarrito] = useState<Linea[]>([]);
  const [opciones, setOpciones] = useState<ProductoCat | null>(null);
  const [cobrando, setCobrando] = useState(false);
  const [aviso, setAviso] = useState<{
    tono: "exito" | "aviso" | "peligro";
    texto: string;
  } | null>(null);

  const cargar = useCallback(async () => {
    if (!pos) return;
    try {
      setCat(await pos.catalogoActual());
    } catch {
      setCat(null);
    }
    setStock(
      Object.fromEntries(
        (await pos.stock()).map((s) => [s.product_uuid, s.qty]),
      ),
    );
    setTurno(!!(await pos.turnoActual()));
  }, [pos]);
  useFocusEffect(
    useCallback(() => {
      cargar();
    }, [cargar]),
  );
  useEffect(() => {
    cargar();
  }, [sync.ultima_sincronizacion, cargar]);

  const productos = useMemo(
    () =>
      cat
        ? [...cat.producto.values()].filter((p) => p.active && p.sellable)
        : [],
    [cat],
  );
  const visibles = useMemo(
    () =>
      productos.filter((p) =>
        p.nombre
          .toLocaleLowerCase("es-MX")
          .includes(busqueda.trim().toLocaleLowerCase("es-MX")),
      ),
    [productos, busqueda],
  );
  const total = useMemo(
    () =>
      Dec.suma(carrito.map((l) => Dec.de(l.precio).por(l.quantity)))
        .redondear(2)
        .fijo(2),
    [carrito],
  );

  const cantidadPorProducto = useMemo(() => {
    const cantidades = new Map<string, number>();
    for (const linea of carrito)
      cantidades.set(
        linea.product_uuid,
        (cantidades.get(linea.product_uuid) ?? 0) + Number(linea.quantity),
      );
    return cantidades;
  }, [carrito]);
  const agregar = (
    p: ProductoCat,
    ops: Array<{ option_uuid: string; qty?: number }> = [],
    etiqueta = "",
  ) => {
    const delta = Dec.suma(
      ops.map((o) =>
        Dec.de(cat?.opcion.get(o.option_uuid)?.opcion.price_delta ?? "0").por(
          o.qty ?? 1,
        ),
      ),
    );
    const precio = Dec.de(p.price).mas(delta).fijo(2);
    setCarrito((c) => {
      const k =
        p.uuid +
        "|" +
        ops
          .map((o) => o.option_uuid)
          .sort()
          .join(",");
      const ya = c.find((l) => l.key === k);
      if (ya)
        return c.map((l) =>
          l.key === k ? { ...l, quantity: String(Number(l.quantity) + 1) } : l,
        );
      return [
        ...c,
        {
          key: k,
          product_uuid: p.uuid,
          quantity: "1",
          options: ops,
          nombre: p.nombre,
          precio,
          etiqueta,
        },
      ];
    });
  };
  const tocar = (p: ProductoCat) =>
    p.modifier_groups?.length ? setOpciones(p) : agregar(p);
  const cambiar = (k: string, d: number) =>
    setCarrito((c) =>
      c.flatMap((l) =>
        l.key !== k
          ? [l]
          : Number(l.quantity) + d <= 0
            ? []
            : [{ ...l, quantity: String(Number(l.quantity) + d) }],
      ),
    );

  const imprimir = async (saleUuid: string) => {
    if (!pos || impresora.tipo === "ninguna") return;
    try {
      await imprimirGuardado(pos, impresora, saleUuid);
    } catch (e) {
      setAviso({ tono: "aviso", texto: `Venta guardada. No se pudo imprimir el ticket: ${(e as Error).message}` });
    }
  };

  const confirmarCobro = async (
    pagos: Array<{
      method: MetodoPago;
      amount: string;
      received?: string;
      reference?: string;
    }>,
    factura: boolean,
  ) => {
    if (!pos || !persona || lock.current) return;
    lock.current = true;
    setGuardando(true);
    try {
      const r = await pos.registrarVenta(
        persona,
        carrito.map(({ product_uuid, quantity, options }) => ({
          product_uuid,
          quantity,
          options,
        })),
        pagos,
        { factura },
      );
      setCobrando(false);
      setCarrito([]);
      setAviso({
        tono: "exito",
        texto: `Venta ${r.folio} guardada${Number(r.cambio) > 0 ? ` · Cambio ${dinero(r.cambio)}` : ""}`,
      });
      cargar();
      void imprimir(r.sale_uuid);
    } catch (e) {
      setCobrando(false);
      setAviso({ tono: "peligro", texto: (e as Error).message });
    } finally {
      lock.current = false;
      setGuardando(false);
    }
  };

  const filasCuenta = (
    <>
      {carrito.map((l) => (
        <Aparece key={l.key} style={s.linea}>
          <View style={{ flex: 1 }}>
            <Text style={tipo.cuerpo} numberOfLines={2}>
              {l.nombre}
            </Text>
            {!!l.etiqueta && (
              <Text style={tipo.tenue} numberOfLines={1}>
                {l.etiqueta}
              </Text>
            )}
            <Text style={tipo.tenue}>{dinero(l.precio)} c/u</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Quitar uno de ${l.nombre}`}
            onPress={() => cambiar(l.key, -1)}
            style={s.paso}
          >
            <Text style={s.pasoTxt}>−</Text>
          </Pressable>
          <Text style={[tipo.numero, { minWidth: 28, textAlign: "center" }]}>
            {l.quantity}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Agregar uno de ${l.nombre}`}
            onPress={() => cambiar(l.key, 1)}
            style={s.paso}
          >
            <Text style={s.pasoTxt}>+</Text>
          </Pressable>
        </Aparece>
      ))}
      {!carrito.length && (
        <Text style={[tipo.tenue, { paddingVertical: 12 }]}>
          Toca un producto para agregarlo.
        </Text>
      )}
    </>
  );
  return (
    <Pantalla>
      <Encabezado titulo="Vender" />
      {turno === false && (
        <View style={{ padding: 16 }}>
          <Aviso texto="No hay turno abierto en esta caja. Ábrelo para empezar a vender." />
          <Boton
            titulo="Abrir turno"
            onPress={() => router.push("/caja/turno")}
            estilo={{ marginTop: 8 }}
          />
        </View>
      )}
      {!cat && (
        <View style={{ padding: 16 }}>
          <Aviso texto="Falta el catálogo del evento: sincroniza cuando haya Internet." />
        </View>
      )}
      {aviso && (
        <Pressable
          onPress={() => setAviso(null)}
          style={{ paddingHorizontal: 16, paddingTop: 8 }}
        >
          <Aviso tono={aviso.tono} texto={aviso.texto} />
        </Pressable>
      )}
      <View style={{ flex: 1, flexDirection: ancho ? "row" : "column" }}>
        <View style={{ flex: 1, minHeight: 0 }}>
          <View style={[s.catalogHeader, compactAccount && { padding: 12 }]}>
            {!compactAccount && (
              <View>
                <Text style={tipo.etiqueta}>CATÁLOGO DEL EVENTO</Text>
                <Text style={tipo.tenue}>
                  {productos.length} productos disponibles
                </Text>
              </View>
            )}
            <TextInput
              accessibilityLabel="Buscar producto"
              placeholder="Buscar producto…"
              placeholderTextColor={t.tenue}
              value={busqueda}
              onChangeText={setBusqueda}
              style={[
                s.input,
                { flex: 1, maxWidth: 340, minWidth: 160, fontSize: 14 },
              ]}
            />
          </View>
          <FlatList
            data={visibles}
            key={`g${columns}`}
            numColumns={columns}
            keyExtractor={(p) => p.uuid}
            contentContainerStyle={{ padding: 20, paddingTop: 4, gap: 12 }}
            columnWrapperStyle={columns > 1 ? { gap: 12 } : undefined}
            style={{ flex: 1 }}
            ListEmptyComponent={
              <Text style={[tipo.tenue, { padding: 16 }]}>
                {busqueda
                  ? "No encontramos ese producto."
                  : "El catálogo aún no tiene productos para vender."}
              </Text>
            }
            renderItem={({ item }) => {
              const q = stock[item.uuid];
              const direct = item.inventory_mode === "DIRECT";
              const bajo =
                direct && q != null && Number(q) > 0 && Number(q) <= 5;
              const agotado = direct && q != null && Number(q) <= 0;
              const cantidad = cantidadPorProducto.get(item.uuid) ?? 0;
              return (
                <Pulse
                  active={cantidad > 0}
                  selectionColor="#EAF8FA"
                  testID={`producto-${item.nombre}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.nombre}, ${dinero(item.price)}${direct ? `, existencias ${q ?? "0"}` : ""}`}
                  accessibilityState={{
                    disabled: !turno,
                    selected: cantidad > 0,
                  }}
                  disabled={!turno}
                  onPress={() => tocar(item)}
                  style={[
                    s.producto,
                    compactAccount && { padding: 12, minHeight: 128 },
                    {
                      borderColor: cantidad ? t.acento : t.borde,
                      backgroundColor: t.superficie,
                      opacity: !turno ? 0.55 : 1,
                    },
                  ]}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      gap: 6,
                    }}
                  >
                    <Text
                      style={[
                        tipo.etiqueta,
                        {
                          fontSize: 9,
                          color: agotado ? t.peligro : bajo ? t.aviso : t.tenue,
                        },
                      ]}
                    >
                      {agotado
                        ? "SIN EXISTENCIAS"
                        : bajo
                          ? "EXISTENCIAS BAJAS"
                          : direct
                            ? "DISPONIBLE"
                            : "PRODUCTO"}
                    </Text>
                    {cantidad > 0 && (
                      <Text style={[tipo.etiqueta, { color: t.acento }]}>
                        ✓ {cantidad}
                      </Text>
                    )}
                  </View>
                  <Text
                    style={[
                      tipo.subtitulo,
                      {
                        minHeight: compactAccount ? 42 : 48,
                        marginVertical: compactAccount ? 6 : 8,
                        fontSize: compactAccount ? 15 : 17,
                        lineHeight: compactAccount ? 21 : undefined,
                      },
                    ]}
                    numberOfLines={2}
                  >
                    {item.nombre}
                  </Text>
                  <View
                    style={[
                      s.ticketRule,
                      compactAccount && { marginBottom: 8 },
                    ]}
                  />
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "flex-end",
                      gap: 4,
                      flexWrap: "wrap",
                    }}
                  >
                    <Text
                      style={[
                        tipo.numero,
                        {
                          fontSize: compactAccount ? 20 : 22,
                          lineHeight: compactAccount ? 28 : undefined,
                        },
                      ]}
                    >
                      {dinero(item.price)}
                    </Text>
                    {direct && (
                      <Text style={[tipo.tenue, { fontSize: 11 }]}>
                        Hay {Dec.de(q ?? "0").toString()}
                      </Text>
                    )}
                  </View>
                </Pulse>
              );
            }}
          />
        </View>
        <View
          style={[
            s.carrito,
            ancho
              ? { width: 340 }
              : compactAccount
                ? {}
                : {
                    height: height < 600 ? 190 : 280,
                    maxHeight: height * 0.42,
                  },
          ]}
        >
          {compactAccount ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Ver cuenta, ${carrito.length} productos`}
              onPress={() => setCuentaVisible(true)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                minHeight: 48,
              }}
            >
              <View>
                <Text style={tipo.subtitulo}>Cuenta ›</Text>
                <Text style={tipo.tenue}>
                  {carrito.reduce((n, l) => n + Number(l.quantity), 0)}{" "}
                  artículos
                </Text>
              </View>
              <Text style={[tipo.numero, { fontSize: 24 }]}>
                {dinero(total)}
              </Text>
            </Pressable>
          ) : (
            <View
              style={{ flexDirection: "row", justifyContent: "space-between" }}
            >
              <Text style={tipo.subtitulo}>Cuenta</Text>
              <Text style={tipo.tenue}>
                {carrito.reduce((n, l) => n + Number(l.quantity), 0)} artículos
              </Text>
            </View>
          )}
          {!compactAccount && (
            <ScrollView style={{ flex: 1 }}>{filasCuenta}</ScrollView>
          )}
          {!compactAccount && (
            <View style={s.total}>
              <Text style={tipo.subtitulo}>Total</Text>
              <Text style={[tipo.numero, { fontSize: 26 }]}>
                {dinero(total)}
              </Text>
            </View>
          )}
          <Boton
            testID="cobrar"
            titulo="Cobrar"
            onPress={() => setCobrando(true)}
            deshabilitado={!carrito.length || !turno}
          />
        </View>
      </View>
      {compactAccount && (
        <Sheet
          visible={cuentaVisible}
          onClose={() => setCuentaVisible(false)}
          title="Cuenta"
          subtitle="Ajusta las cantidades antes de cobrar."
          footer={
            <Boton
              titulo="Volver a venta"
              variante="secundario"
              onPress={() => setCuentaVisible(false)}
            />
          }
        >
          {filasCuenta}
          <View style={s.total}>
            <Text style={tipo.subtitulo}>Total</Text>
            <Text style={[tipo.numero, { fontSize: 24 }]}>{dinero(total)}</Text>
          </View>
        </Sheet>
      )}
      <Opciones
        producto={opciones}
        cat={cat}
        alCerrar={() => setOpciones(null)}
        alAgregar={(p, ops, etq) => {
          agregar(p, ops, etq);
          setOpciones(null);
        }}
      />
      <Cobro
        visible={cobrando}
        total={total}
        alCerrar={() => setCobrando(false)}
        alConfirmar={confirmarCobro}
        guardando={guardando}
      />
    </Pantalla>
  );
}

function Opciones({
  producto,
  cat,
  alCerrar,
  alAgregar,
}: {
  producto: ProductoCat | null;
  cat: CatalogoIndexado | null;
  alCerrar: () => void;
  alAgregar: (
    p: ProductoCat,
    ops: Array<{ option_uuid: string; qty?: number }>,
    etiqueta: string,
  ) => void;
}) {
  const [sel, setSel] = useState<Record<string, string[]>>({});
  useEffect(() => setSel({}), [producto]);
  if (!producto || !cat) return null;
  const grupos = (producto.modifier_groups ?? [])
    .map((g) => cat.grupo.get(g))
    .filter((g) => g && g.active);
  const alternar = (g: string, o: string, max: number) =>
    setSel((s) => {
      const a = s[g] ?? [];
      if (a.includes(o)) return { ...s, [g]: a.filter((x) => x !== o) };
      return { ...s, [g]: max === 1 ? [o] : a.length < max ? [...a, o] : a };
    });
  const faltan = grupos.filter(
    (g) =>
      g!.required && (sel[g!.uuid]?.length ?? 0) < Math.max(1, g!.min_select),
  );
  const elegidas = Object.values(sel).flat();
  return (
    <Sheet
      visible
      onClose={alCerrar}
      title={producto.nombre}
      footer={
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Boton
            titulo="Cancelar"
            variante="secundario"
            onPress={alCerrar}
            estilo={{ flex: 1 }}
          />
          <Boton
            titulo="Agregar"
            onPress={() =>
              alAgregar(
                producto,
                elegidas.map((o) => ({ option_uuid: o })),
                elegidas.map((o) => cat.opcion.get(o)?.opcion.name).join(", "),
              )
            }
            deshabilitado={faltan.length > 0}
            estilo={{ flex: 1 }}
          />
        </View>
      }
    >
      <View>
        {grupos.map((g) => (
          <View key={g!.uuid} style={{ marginTop: 12, gap: 8 }}>
            <Text style={tipo.subtitulo}>
              {g!.name}
              {g!.required ? " *" : ""}
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {g!.options
                .filter((o) => o.active)
                .map((o) => {
                  const on = sel[g!.uuid]?.includes(o.uuid);
                  return (
                    <Pressable
                      key={o.uuid}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: !!on }}
                      onPress={() => alternar(g!.uuid, o.uuid, g!.max_select)}
                      style={[s.chip, on && { backgroundColor: t.acento }]}
                    >
                      <Text
                        style={[tipo.cuerpo, on && { color: t.acentoTexto }]}
                      >
                        {o.name}
                        {Number(o.price_delta)
                          ? ` +${dinero(o.price_delta)}`
                          : ""}
                      </Text>
                    </Pressable>
                  );
                })}
            </View>
          </View>
        ))}
      </View>
      {faltan.length > 0 && (
        <Aviso
          texto={`Falta elegir: ${faltan.map((g) => g!.name).join(", ")}`}
        />
      )}
    </Sheet>
  );
}

function Cobro({
  visible,
  total,
  alCerrar,
  alConfirmar,
  guardando,
}: {
  visible: boolean;
  total: string;
  guardando: boolean;
  alCerrar: () => void;
  alConfirmar: (
    pagos: Array<{
      method: MetodoPago;
      amount: string;
      received?: string;
      reference?: string;
    }>,
    factura: boolean,
  ) => void;
}) {
  const { width, fontScale } = useWindowDimensions();
  const split = width >= 850 && fontScale <= 1.3;
  const [metodo, setMetodo] = useState<MetodoPago>("EFECTIVO");
  const [recibido, setRecibido] = useState("");
  const [referencia, setReferencia] = useState("");
  const [factura, setFactura] = useState(false);
  useEffect(() => {
    if (visible) {
      setMetodo("EFECTIVO");
      setRecibido("");
      setReferencia("");
      setFactura(false);
    }
  }, [visible]);
  const rec = recibido
    ? Dec.de(recibido === "." ? "0" : recibido)
    : Dec.de(total);
  const cambio = rec.menos(total);
  const alcanza = metodo !== "EFECTIVO" || !cambio.esNegativo();
  const rapidos = ["50", "100", "200", "500"].filter(
    (v) => Number(v) >= Number(total),
  );
  return (
    <Sheet
      maxWidth={split ? 700 : 520}
      visible={visible}
      onClose={alCerrar}
      title="Cobrar cuenta"
      subtitle="La venta se guarda primero en esta tablet."
      busy={guardando}
      footer={
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Boton
            titulo="Volver"
            variante="secundario"
            onPress={alCerrar}
            deshabilitado={guardando}
            estilo={{ flex: 1, minWidth: 80 }}
          />
          <Boton
            testID="confirmar-cobro"
            titulo="Confirmar"
            cargando={guardando}
            deshabilitado={!alcanza}
            estilo={{ flex: 2 }}
            onPress={() =>
              alConfirmar(
                [
                  {
                    method: metodo,
                    amount: total,
                    received:
                      metodo === "EFECTIVO" ? recibido || total : undefined,
                    reference: referencia || undefined,
                  },
                ],
                factura,
              )
            }
          />
        </View>
      }
    >
      <Text style={tipo.tenue}>Total a cobrar</Text>
      <Text style={[tipo.numero, { fontSize: 40 }]}>{dinero(total)}</Text>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          marginVertical: 8,
        }}
      >
        {(["EFECTIVO", "TARJETA", "TRANSFERENCIA"] as MetodoPago[]).map((m) => (
          <Pulse
            active={metodo === m}
            selectionColor={t.acento}
            key={m}
            testID={`metodo-${m}`}
            disabled={guardando}
            accessibilityRole="radio"
            accessibilityState={{ checked: metodo === m, disabled: guardando }}
            onPress={() => setMetodo(m)}
            style={[
              s.chip,
              {
                flex: 1,
                minWidth: m === "TRANSFERENCIA" ? 140 : 96,
                alignItems: "center",
                paddingHorizontal: 6,
              },
            ]}
          >
            <Text
              style={[
                tipo.cuerpo,
                { fontSize: 12, textAlign: "center" },
                metodo === m && { color: t.acentoTexto },
              ]}
            >
              {m === "EFECTIVO"
                ? "Efectivo"
                : m === "TARJETA"
                  ? "Tarjeta"
                  : "Transferencia"}
            </Text>
          </Pulse>
        ))}
      </View>
      {metodo === "EFECTIVO" ? (
        <View style={{ flexDirection: split ? "row" : "column", gap: 20 }}>
          <View style={{ flex: split ? 1 : undefined, gap: 12 }}>
            <Text style={tipo.etiqueta}>EFECTIVO RECIBIDO</Text>
            <Text style={[tipo.numero, { fontSize: 32 }]}>
              {dinero(recibido === "." ? "0" : recibido || total)}
            </Text>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <Boton
                titulo="Exacto"
                deshabilitado={guardando}
                variante="secundario"
                onPress={() => setRecibido("")}
                estilo={{ flex: 1, minWidth: 80 }}
              />
              {rapidos.map((v) => (
                <Boton
                  key={v}
                  titulo={`$${v}`}
                  deshabilitado={guardando}
                  variante="secundario"
                  onPress={() => setRecibido(v)}
                  estilo={{ flex: 1, minWidth: 80 }}
                />
              ))}
            </View>
            <View
              style={{
                borderTopWidth: 1,
                borderColor: t.borde,
                paddingTop: 16,
                gap: 4,
              }}
            >
              <Text style={tipo.tenue}>Cambio</Text>
              <Text
                style={[
                  tipo.numero,
                  { fontSize: 28, color: alcanza ? t.exito : t.peligro },
                ]}
              >
                {alcanza ? dinero(cambio.fijo(2)) : "No alcanza"}
              </Text>
            </View>
          </View>
          <View style={{ flex: split ? 1 : undefined }}>
            <Teclado
              disabled={guardando}
              alPulsar={(key) => setRecibido((value) => teclear(value, key, 8))}
            />
          </View>
        </View>
      ) : (
        <>
          <Aviso
            texto={
              metodo === "TARJETA"
                ? "Cobra en la terminal y confirma solo cuando diga APROBADO. La venta no toca el efectivo de la caja."
                : "Confirma la transferencia antes de cerrar la venta."
            }
          />
          <TextInput
            editable={!guardando}
            value={referencia}
            onChangeText={setReferencia}
            placeholder="Referencia o folio (opcional)"
            style={s.input}
            accessibilityLabel="Referencia"
          />
        </>
      )}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: factura }}
        disabled={guardando}
        onPress={() => setFactura(!factura)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 48,
        }}
      >
        <View
          style={[
            s.casilla,
            factura && { backgroundColor: t.acento, borderColor: t.acento },
          ]}
        >
          <Text style={{ color: "#fff", textAlign: "center" }}>
            {factura ? "✓" : ""}
          </Text>
        </View>
        <Text style={[tipo.cuerpo, { flex: 1, fontSize: 13 }]}>
          El cliente pidió factura (se emite después, con Internet)
        </Text>
      </Pressable>
    </Sheet>
  );
}

const s = StyleSheet.create({
  catalogHeader: {
    padding: 20,
    gap: 16,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
  },
  ticketRule: {
    borderTopWidth: 1,
    borderStyle: "dashed",
    borderColor: t.borde,
    marginBottom: 12,
  },
  producto: {
    flex: 1,
    minHeight: 166,
    backgroundColor: t.superficie,
    borderRadius: t.radio,
    padding: 16,
    borderWidth: 1,
    borderColor: t.borde,
    justifyContent: "space-between",
  },
  carrito: {
    backgroundColor: t.superficie,
    borderLeftWidth: 1,
    borderTopWidth: 1,
    borderColor: t.borde,
    padding: 16,
    gap: 10,
  },
  linea: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: t.hundido,
  },
  paso: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: t.hundido,
    alignItems: "center",
    justifyContent: "center",
  },
  pasoTxt: { fontSize: 24, fontWeight: "700", color: t.texto },
  total: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  chip: {
    backgroundColor: t.hundido,
    borderRadius: 999,
    paddingHorizontal: 16,
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
  casilla: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: t.borde,
  },
});
