import {usePreciosComerciales} from '../../components/usePreciosComerciales';
import {Comercial} from '../../components/Comercial';
import {congelarLinea,uuidv7,canalInicial} from '@wybix/domain';
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
  Modal,
  Image,
  useWindowDimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  logoDeMarca,
} from "../../components/ui";
import { usePos } from "../../lib/contexto";
import { Avatar } from "../../components/Avatar";
import { imprimirGuardado } from "../../lib/ticket-guardado";

type Linea = LineaCarrito & {
  key: string;
  nombre: string;
  precio: string;
  etiqueta: string;
};

export default function Vender() {
  const { pos, db, persona, identidad, impresora, sync, salir, negocio, canalEvento } = usePos();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width, height, fontScale } = useWindowDimensions();
  const ancho = width >= 850 && fontScale <= 1.3;
  const [cuentaVisible, setCuentaVisible] = useState(false);
  const columns =
    fontScale > 1.4
      ? 1
      : ancho
        ? width >= 1200
          ? 4
          : 3
        : width >= 560 && fontScale <= 1.3
          ? 3
          : 2;
  const [categoria, setCategoria] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [guardando, setGuardando] = useState(false);
  const lock = useRef(false);
  const [cat, setCat] = useState<CatalogoIndexado | null>(null);
  const [stock, setStock] = useState<Record<string, string>>({});
  const [turno, setTurno] = useState<boolean | null>(null);
  const [carrito, setCarrito] = useState<Linea[]>([]);
  const [channel,setChannel]=useState('LOCAL'),[audiences,setAudiences]=useState<string[]>([]);
  // Cada cuenta empieza en el canal del evento (Owner); la cajera puede cambiarlo.
  const canalBase=canalInicial(cat?.commercial,canalEvento);
  const vacio=carrito.length===0;
  useEffect(()=>{if(vacio)setChannel(canalBase);},[canalBase,vacio]);
  const {total:commercialTotal,discount:commercialDiscount,pricing,error:pricingError,lines:linePrices}=usePreciosComerciales(pos,cat,carrito,channel,audiences);
  const catalogPrice=(p:ProductoCat)=>{const policy=cat?.commercial,c=policy?.channels.find(c=>c.id===channel),price=policy?.prices.find(x=>x.channel===channel&&x.product===p.uuid&&!x.variant);return price?.price??((!c||c.inheritBase)?p.price:null);};
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
  // Categorías del catálogo con productos a la venta; "Todo" siempre primero.
  const categorias = useMemo(() => {
    const nombres = cat?.categorias ?? new Map<string, string>();
    const n = new Map<string, number>();
    for (const p of productos) if (p.category_uuid && nombres.has(p.category_uuid)) n.set(p.category_uuid, (n.get(p.category_uuid) ?? 0) + 1);
    if (!n.size) return [];
    // En el orden del catálogo; "Todo" al final.
    return [...[...nombres.keys()].filter((u) => n.has(u)).map((uuid) => ({ uuid, nombre: nombres.get(uuid)!, n: n.get(uuid)! })),
      { uuid: "TODO", nombre: "Todo", n: productos.length }];
  }, [cat, productos]);
  // Al cargar (o si la categoría desaparece) se elige la primera.
  useEffect(() => {
    if (!categorias.length) { if (categoria !== "TODO") setCategoria("TODO"); return; }
    if (categoria === "" || !categorias.some((c) => c.uuid === categoria)) setCategoria(categorias[0].uuid);
  }, [categorias, categoria]);
  const visibles = useMemo(
    () =>
      productos.filter((p) =>
        (busqueda.trim() || categoria === "TODO" || categoria === "" || p.category_uuid === categoria) &&
        p.nombre
          .toLocaleLowerCase("es-MX")
          .includes(busqueda.trim().toLocaleLowerCase("es-MX")),
      ),
    [productos, busqueda, categoria],
  );
  const total = useMemo(
    () =>
      commercialTotal ?? Dec.suma(carrito.map((l) => Dec.de(l.precio).por(l.quantity))).redondear(2).fijo(2),
    [carrito,commercialTotal],
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
        carrito.map(({ product_uuid, quantity, options,combo }) => ({
          product_uuid,
          quantity,
          options,combo,
        })),
        pagos,
        { factura,commercial:{channel,audiences} },
      );
      setCobrando(false);
      setCarrito([]);setChannel(canalBase);setAudiences([]);
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
            <Text style={tipo.tenue}>{dinero(linePrices[l.key]?.amount??Dec.de(l.precio).por(l.quantity).fijo(2))} por esta línea</Text>
            {!!linePrices[l.key]?.label&&<Text style={[tipo.tenue,{color:t.acentoTinta}]}>{linePrices[l.key].label}</Text>}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={l.combo?`Quitar combo ${l.etiqueta}`:`Quitar uno de ${l.nombre}`}
            onPress={() => l.combo?setCarrito(c=>c.filter(x=>x.combo?.instance!==l.combo!.instance)):cambiar(l.key, -1)}
            style={s.paso}
          >
            <Text style={s.pasoTxt}>−</Text>
          </Pressable>
          <Text style={[tipo.numero, { minWidth: 28, textAlign: "center" }]}>
            {l.quantity}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={!!l.combo}
            accessibilityState={{disabled:!!l.combo}}
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
  const articulos = carrito.reduce((n, l) => n + Number(l.quantity), 0);
  const huecos = visibles.length % columns ? columns - (visibles.length % columns) : 0;
  const cuadricula: Array<ProductoCat | null> = [...visibles, ...Array<null>(huecos).fill(null)];
  const importeLinea = (l: Linea) =>
    linePrices[l.key]?.amount ?? Dec.de(l.precio).por(l.quantity).fijo(2);
  const nombreCategoria =
    categoria === "TODO" ? "Todo" : (cat?.categorias?.get(categoria) ?? "Todo");
  const sinCobro = !carrito.length || !turno || pricing || !!pricingError;
  // Tablet: las tarjetas llenan el alto en dos filas (como el diseño); con más
  // productos, la cuadrícula se desplaza.
  const [altoCuadricula, setAltoCuadricula] = useState(0);
  const gap = ancho ? 14 : 10;
  const altoTarjeta = ancho ? Math.max(200, (altoCuadricula - gap) / 2) : 186;
  const logo = logoDeMarca();
  const nombreNegocio = negocio ?? identidad?.location_name ?? "Wybix";
  const estadoRed = sync.revocado
    ? { texto: "Tablet dada de baja", color: t.peligro }
    : sync.en_linea
      ? { texto: sync.pendientes ? `Enviando ${sync.pendientes}` : "Al día", color: t.exito }
      : { texto: `Sin red · ${sync.pendientes}${ancho ? " por enviar" : ""}`, color: t.aviso };
  const cambiarPersona = () => { salir(); router.replace("/entrar"); };

  const insigniaNegocio = logo ? (
    <View style={[s.marca, { backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: t.borde }]}>
      <Image source={{ uri: logo }} style={{ width: 32, height: 32 }} resizeMode="contain" accessibilityLabel={nombreNegocio} />
    </View>
  ) : (
    <View style={[s.marca, { backgroundColor: t.acento }]} accessibilityElementsHidden>
      <Text style={[tipo.subtitulo, { fontSize: 13, color: t.acentoTexto }]}>{iniciales(nombreNegocio)}</Text>
    </View>
  );

  const chipRed = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${estadoRed.texto}. Ver estado de la tablet`}
      onPress={() => router.push("/caja/sincronia")}
      style={ancho ? s.estadoTablet : s.estadoCel}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: estadoRed.color }} />
      <Text style={[tipo.tenue, { fontSize: ancho ? 13 : 12 }]} numberOfLines={1}>{estadoRed.texto}</Text>
    </Pressable>
  );

  const botonPersona = (estilo: object) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Cambiar de persona: ${persona?.name ?? ""}`}
      onPress={cambiarPersona}
      style={estilo}
    >
      {persona ? <Avatar uuid={persona.uuid} nombre={persona.name} size={36} /> : <Text style={[tipo.subtitulo, { fontSize: 16 }]}>?</Text>}
    </Pressable>
  );

  const categoriasUi = categorias.length > 0 && categorias.map((c) => {
    const on = categoria === c.uuid;
    return (
      <Pressable
        key={c.uuid}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        accessibilityLabel={`${c.nombre}, ${c.n} productos`}
        onPress={() => setCategoria(c.uuid)}
        style={[ancho ? s.categoria : s.categoriaChip, on && { backgroundColor: t.acento, borderColor: t.acento }]}
      >
        <Text style={[tipo.subtitulo, { fontSize: ancho ? 16 : 15, color: on ? t.acentoTexto : t.texto }]} numberOfLines={1}>
          {c.nombre}
        </Text>
        {ancho && (
          <Text style={[tipo.numero, { fontSize: 13, color: on ? t.acentoTexto : t.tenue }]}>{c.n}</Text>
        )}
      </Pressable>
    );
  });

  const busquedaUi = (
    <View style={[s.buscar, ancho ? { width: 340 } : null]}>
      <Ionicons name="search" size={18} color={t.tenue} />
      <TextInput
        accessibilityLabel="Buscar producto"
        placeholder="Buscar o escanear"
        placeholderTextColor={t.tenue}
        value={busqueda}
        onChangeText={setBusqueda}
        style={{ flex: 1, fontFamily: "Wybix", fontSize: 15, color: t.texto, minHeight: 48 }}
      />
    </View>
  );

  const avisos = (
    <>
      {cat&&persona&&<Comercial cat={cat} channel={channel} predeterminado={canalBase} onChannel={setChannel} audiences={audiences} onAudiences={setAudiences} role={persona.role} onAdd={lines=>{try{const added=lines.map(l=>{const frozen=congelarLinea(cat,l,1);return {...l,key:uuidv7(),nombre:frozen.product_name,precio:frozen.unit_price,etiqueta:(cat.commercial?.combos.find(c=>c.id===l.combo?.id)?.name??'')+' · '+frozen.modifiers.map(m=>m.option_name).join(', ')};});setCarrito(c=>[...c,...added]);}catch(e){setAviso({tono:'peligro',texto:(e as Error).message});}}}/>}
      {pricing?<Text style={[tipo.tenue,{padding:12}]}>Calculando precios…</Text>:Number(commercialDiscount)>0?<Text style={[tipo.cuerpo,{padding:12}]}>Ahorro de esta cuenta: {dinero(commercialDiscount)}</Text>:null}
      {pricingError?<Aviso tono="peligro" texto={pricingError}/>:null}
      {turno === false && (
        <View style={{ gap: 8, paddingBottom: 10 }}>
          <Aviso texto="No hay turno abierto en esta caja. Ábrelo para empezar a vender." />
          <Boton titulo="Abrir turno" onPress={() => router.push("/caja/turno")} />
        </View>
      )}
      {!cat && (
        <View style={{ paddingBottom: 10 }}>
          <Aviso texto="Falta el catálogo del evento: sincroniza cuando haya Internet." />
        </View>
      )}
      {aviso && (
        <Pressable onPress={() => setAviso(null)} style={{ paddingBottom: 10 }}>
          <Aviso tono={aviso.tono} texto={aviso.texto} />
        </Pressable>
      )}
    </>
  );

  const tarjeta = ({ item, index }: { item: ProductoCat | null; index: number }) => {
    // Hueco de relleno: la última fila no estira sus tarjetas.
    if (!item) return <View style={{ flex: 1 }} />;
    const q = stock[item.uuid];
    const direct = item.inventory_mode === "DIRECT";
    const bajo = direct && q != null && Number(q) > 0 && Number(q) <= 5;
    const agotado = direct && q != null && Number(q) <= 0;
    const cantidad = cantidadPorProducto.get(item.uuid) ?? 0;
    const precio = catalogPrice(item);
    const enCuenta = cantidad > 0;
    return (
      <Pulse
        testID={`producto-${item.nombre}`}
        accessibilityRole="button"
        accessibilityLabel={`${item.nombre}, ${precio==null?"Precio sin configurar":dinero(precio)}${direct ? `, existencias ${q ?? "0"}` : ""}${cantidad ? `, ${cantidad} en la cuenta` : ""}`}
        accessibilityState={{ disabled: !turno||precio==null, selected: enCuenta }}
        disabled={!turno||precio==null}
        onPress={() => tocar(item)}
        style={[
          s.producto,
          { height: altoTarjeta, borderColor: enCuenta ? t.acento : "transparent" },
          enCuenta && { boxShadow: `0 0 0 4px ${t.acentoSuave}` },
        ]}
      >
        <View style={[s.foto, { backgroundColor: index % 2 ? t.hundido : t.acentoSuave }, agotado && { opacity: 0.5 }]}>
          {/* Sin fotos en el catálogo todavía: el recuadro queda reservado. */}
          <Text style={[tipo.etiqueta, { fontSize: 10, color: t.tenue }]}>FOTO</Text>
          {enCuenta && (
            <View style={[s.insignia, { backgroundColor: t.acento }]}>
              <Text style={[tipo.numero, { fontSize: 15, color: t.acentoTexto }]}>{cantidad}</Text>
            </View>
          )}
        </View>
        <View style={{ paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12, gap: 2 }}>
          <Text style={[tipo.subtitulo, { fontSize: 15, lineHeight: 20, color: agotado ? t.tenue : t.texto }]} numberOfLines={1}>
            {item.nombre}
          </Text>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
            <Text style={[tipo.numero, { fontSize: precio == null ? 12 : 18, color: agotado ? t.tenue : t.texto }]}>
              {precio == null ? "Precio sin configurar" : precioCorto(precio)}
            </Text>
            {ancho && direct && (
              <Text
                style={[tipo.numero, { fontSize: 11, color: agotado ? t.peligro : bajo ? t.aviso : t.tenue }]}
                numberOfLines={1}
              >
                {agotado ? "Agotada" : Dec.de(q ?? "0").toString()}
              </Text>
            )}
          </View>
        </View>
      </Pulse>
    );
  };

  const cuadriculaUi = (
    <View style={{ flex: 1, minHeight: 0 }} onLayout={(e) => setAltoCuadricula(e.nativeEvent.layout.height)}>
      <FlatList
        data={cuadricula}
        key={`g${columns}`}
        numColumns={columns}
        keyExtractor={(p, i) => (p ? p.uuid : `hueco-${i}`)}
        contentContainerStyle={{ gap, paddingHorizontal: ancho ? 0 : 16, paddingBottom: ancho ? 0 : 12 }}
        columnWrapperStyle={columns > 1 ? { gap } : undefined}
        style={{ flex: 1 }}
        ListEmptyComponent={
          <Text style={[tipo.tenue, { padding: 16 }]}>
            {busqueda ? "No encontramos ese producto." : "El catálogo aún no tiene productos para vender."}
          </Text>
        }
        renderItem={tarjeta}
      />
    </View>
  );

  const dock = (
    <View style={[s.dock, { backgroundColor: t.navy }, !ancho && { marginHorizontal: 12, marginBottom: 10, padding: 10, paddingLeft: 16 }]}>
      {ancho ? (
        <>
          <View style={{ width: 96 }}>
            <Text style={[tipo.tenue, { color: "#B8C3CF", fontSize: 12 }]}>Cuenta</Text>
            <Text style={[tipo.subtitulo, { color: "#fff", fontSize: 15 }]}>
              {articulos} {articulos === 1 ? "artículo" : "artículos"}
            </Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ gap: 8, alignItems: "center" }}>
            {carrito.map((l) => (
              <Aparece key={l.key} style={s.lineaDock}>
                <Text style={[tipo.subtitulo, { color: "#fff", fontSize: 14, maxWidth: 180 }]} numberOfLines={1}>{l.nombre}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={l.combo?`Quitar combo ${l.etiqueta}`:`Quitar uno de ${l.nombre}`}
                  onPress={() => l.combo?setCarrito(c=>c.filter(x=>x.combo?.instance!==l.combo!.instance)):cambiar(l.key, -1)}
                  style={s.pasoDock}
                >
                  <Text style={s.pasoDockTxt}>−</Text>
                </Pressable>
                <Text style={[tipo.numero, { color: "#fff", minWidth: 22, textAlign: "center" }]}>{l.quantity}</Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={!!l.combo}
                  accessibilityState={{disabled:!!l.combo}}
                  accessibilityLabel={`Agregar uno de ${l.nombre}`}
                  onPress={() => cambiar(l.key, 1)}
                  style={[s.pasoDock, l.combo && { opacity: 0.4 }]}
                >
                  <Text style={s.pasoDockTxt}>+</Text>
                </Pressable>
              </Aparece>
            ))}
            {!carrito.length && <Text style={[tipo.tenue, { color: "#B8C3CF" }]}>Toca un producto para agregarlo.</Text>}
          </ScrollView>
          <Text style={[tipo.numero, { color: "#fff", fontSize: 34, paddingHorizontal: 6, letterSpacing: -1 }]}>{dinero(total)}</Text>
        </>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Ver cuenta, ${articulos} artículos, ${dinero(total)}`}
          onPress={() => setCuentaVisible(true)}
          style={{ flex: 1, minHeight: 48, justifyContent: "center" }}
        >
          <Text style={[tipo.tenue, { color: "#B8C3CF", fontSize: 12 }]}>{articulos} {articulos === 1 ? "artículo" : "artículos"}</Text>
          <Text style={[tipo.numero, { color: "#fff", fontSize: 26, letterSpacing: -0.5 }]}>{dinero(total)}</Text>
        </Pressable>
      )}
      <Pulse
        testID="cobrar"
        accessibilityRole="button"
        accessibilityLabel={`Cobrar ${dinero(total)}`}
        accessibilityState={{ disabled: !!sinCobro }}
        disabled={!!sinCobro}
        onPress={() => setCobrando(true)}
        style={[s.cobrar, { backgroundColor: t.acento, opacity: sinCobro ? 0.45 : 1 }, ancho ? { width: 210, minHeight: 72 } : { minWidth: 120, minHeight: 58 }]}
      >
        <Text style={[tipo.subtitulo, { fontSize: ancho ? 19 : 18, color: t.acentoTexto }]}>Cobrar</Text>
        {ancho && <Ionicons name="arrow-forward" size={18} color={t.acentoTexto} />}
      </Pulse>
    </View>
  );

  return (
    <Pantalla>
      {ancho ? (
        <View style={{ flex: 1, flexDirection: "row", gap: 16, padding: 16, paddingBottom: 0, paddingTop: insets.top + 16 }}>
          {/* Columna: negocio, categorías, estado y accesos. */}
          <View style={{ width: 210, gap: 10 }}>
            <View style={s.tarjetaNegocio}>
              {insigniaNegocio}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[tipo.subtitulo, { fontSize: 15 }]} numberOfLines={1}>{nombreNegocio}</Text>
                <Text style={[tipo.tenue, { fontSize: 11 }]} numberOfLines={1}>
                  {identidad?.location_name} · Caja {identidad?.register.code}
                </Text>
              </View>
            </View>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 10 }} accessibilityRole="tablist">
              {categoriasUi || (
                <View style={[s.categoria, { backgroundColor: t.acento, borderColor: t.acento }]}>
                  <Text style={[tipo.subtitulo, { fontSize: 16, color: t.acentoTexto }]}>Todo</Text>
                  <Text style={[tipo.numero, { fontSize: 13, color: t.acentoTexto }]}>{productos.length}</Text>
                </View>
              )}
            </ScrollView>
            {chipRed}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable accessibilityRole="button" accessibilityLabel="Turno y corte" onPress={() => router.push("/caja/turno")} style={s.acceso}>
                <Ionicons name="card-outline" size={20} color={t.texto} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Inventario" onPress={() => router.push("/caja/inventario")} style={s.acceso}>
                <Ionicons name="cube-outline" size={20} color={t.texto} />
              </Pressable>
              {botonPersona(s.acceso)}
            </View>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={s.cabecera}>
              <Text accessibilityRole="header" style={[tipo.titulo, { flex: 1, fontSize: 30, letterSpacing: -0.8 }]} numberOfLines={1}>
                {busqueda.trim() ? "Resultados" : nombreCategoria}
              </Text>
              {busquedaUi}
            </View>
            {avisos}
            {cuadriculaUi}
          </View>
        </View>
      ) : (
        <View style={{ flex: 1, paddingTop: insets.top }}>
          <View style={s.cabeceraCel}>
            {insigniaNegocio}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text accessibilityRole="header" style={[tipo.subtitulo, { fontSize: 17 }]}>Vender</Text>
              <Text style={[tipo.tenue, { fontSize: 11 }]} numberOfLines={1}>
                {identidad?.location_name} · Caja {identidad?.register.code}
              </Text>
            </View>
            {chipRed}
            {botonPersona(s.personaCel)}
          </View>
          <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>{busquedaUi}</View>
          {categoriasUi && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 12 }}>
              {categoriasUi}
            </ScrollView>
          )}
          <View style={{ paddingHorizontal: 16 }}>{avisos}</View>
          {cuadriculaUi}
        </View>
      )}
      {dock}

      {!ancho && (
        <Sheet
          visible={cuentaVisible}
          onClose={() => setCuentaVisible(false)}
          title="Cuenta"
          subtitle="Ajusta las cantidades antes de cobrar."
          footer={<Boton titulo="Volver a venta" variante="secundario" onPress={() => setCuentaVisible(false)} />}
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
        encabezado={`${identidad?.location_name ?? ""} · Caja ${identidad?.register.code ?? ""}${persona ? ` · ${persona.name}` : ""}`}
        lineas={carrito.map((l) => ({ key: l.key, texto: `${l.quantity} × ${l.nombre}${l.etiqueta ? ` (${l.etiqueta})` : ""}`, importe: importeLinea(l) }))}
        alCerrar={() => setCobrando(false)}
        alConfirmar={confirmarCobro}
        guardando={guardando}
      />
    </Pantalla>
  );
}

/** "$25" cuando no hay centavos; "$27.50" cuando sí (como en el diseño). */
function precioCorto(v: string) {
  const d = dinero(v);
  return d.endsWith(".00") ? d.slice(0, -3) : d;
}

function iniciales(nombre: string) {
  const p = nombre.split(/\s+/).map((x) => x.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "W";
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

/**
 * COBRAR (pantalla completa). Tablet: el ticket a la izquierda y el pago a la
 * derecha. Celular: lo mismo apilado, con el botón de confirmar siempre a la
 * vista. Contrato igual que antes: un pago por venta, efectivo con cambio.
 */
function Cobro({
  visible,
  total,
  encabezado,
  lineas,
  alCerrar,
  alConfirmar,
  guardando,
}: {
  visible: boolean;
  total: string;
  encabezado: string;
  lineas: Array<{ key: string; texto: string; importe: string }>;
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
  const insets = useSafeAreaInsets();
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
  const cerrar = () => { if (!guardando) alCerrar(); };
  const confirmar = () =>
    alConfirmar(
      [
        {
          method: metodo,
          amount: total,
          received: metodo === "EFECTIVO" ? recibido || total : undefined,
          reference: referencia || undefined,
        },
      ],
      factura,
    );
  const METODOS: Array<{ m: MetodoPago; label: string; icon: "cash-outline" | "card-outline" | "swap-horizontal-outline" | "bag-handle-outline" }> = [
    { m: "EFECTIVO", label: "Efectivo", icon: "cash-outline" },
    { m: "TARJETA", label: "Tarjeta", icon: "card-outline" },
    { m: "TRANSFERENCIA", label: "Transferencia", icon: "swap-horizontal-outline" },
    { m: "PLATAFORMA", label: "Plataforma", icon: "bag-handle-outline" },
  ];

  const ticket = (
    <View style={[s.ticket, split ? { width: 360, flex: undefined } : { padding: 16, gap: 8, flex: undefined }]}>
      <View style={{ alignItems: "center", gap: 2, paddingBottom: 4 }}>
        <Text style={[tipo.etiqueta, { color: t.texto, fontSize: 12 }]}>CUENTA</Text>
        <Text style={[tipo.tenue, { fontSize: 12, textAlign: "center" }]} numberOfLines={1}>
          {encabezado}
        </Text>
      </View>
      <View style={s.punteado} />
      <ScrollView style={split ? { flex: 1 } : { maxHeight: 96 }} contentContainerStyle={{ gap: split ? 8 : 4 }}>
        {lineas.map((l) => (
          <View key={l.key} style={{ flexDirection: "row", gap: 10 }}>
            <Text style={[tipo.cuerpo, { flex: 1, fontSize: 14 }]}>{l.texto}</Text>
            <Text style={[tipo.numero, { fontSize: 14 }]}>{dinero(l.importe)}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={s.punteado} />
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Text style={tipo.subtitulo}>Total</Text>
        <Text style={[tipo.numero, { fontSize: split ? 42 : 28, letterSpacing: -1 }]}>{dinero(total)}</Text>
      </View>
      {split && casillaFactura()}
    </View>
  );

  function casillaFactura() {
    return (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: factura }}
        disabled={guardando}
        onPress={() => setFactura(!factura)}
        style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 }}
      >
        <View style={[s.casilla, factura && { backgroundColor: t.acento, borderColor: t.acento }]}>
          <Text style={{ color: t.acentoTexto, textAlign: "center" }}>{factura ? "✓" : ""}</Text>
        </View>
        <Text style={[tipo.cuerpo, { flex: 1, fontSize: 13, color: t.tenue }]}>
          El cliente pidió factura (se emite después, con Internet)
        </Text>
      </Pressable>
    );
  }

  const metodos = (
    <View style={{ flexDirection: "row", flexWrap: split ? "nowrap" : "wrap", justifyContent: "space-between", gap: split ? 12 : 8 }}>
      {METODOS.map(({ m, label, icon }) => {
        const on = metodo === m;
        return (
          <View key={m} style={split ? { flex: 1 } : { width: "48.5%" }}>
          <Pulse
            active={on}
            selectionColor={t.acento}
            testID={`metodo-${m}`}
            disabled={guardando}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityState={{ checked: on, disabled: guardando }}
            onPress={() => setMetodo(m)}
            style={[s.metodo, { minHeight: split ? 68 : 46 }]}
          >
            <Ionicons name={icon} size={20} color={on ? t.acentoTexto : t.texto} />
            <Text style={[tipo.subtitulo, { fontSize: 14, color: on ? t.acentoTexto : t.texto }]} numberOfLines={1}>
              {label}
            </Text>
          </Pulse>
          </View>
        );
      })}
    </View>
  );

  const efectivo = (
    <View style={[s.panel, split ? { flex: 1 } : { padding: 14, gap: 10 }]}>
      <View style={{ gap: 4 }}>
        <Text style={tipo.etiqueta}>EFECTIVO RECIBIDO</Text>
        <Text style={[tipo.numero, { fontSize: split ? 50 : 26, letterSpacing: -1 }]}>
          {dinero(recibido === "." ? "0" : recibido || total)}
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {[{ v: "", label: "Exacto" }, ...rapidos.map((v) => ({ v, label: `$${v}` }))].map(({ v, label }) => {
          const on = recibido === v;
          return (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled: guardando }}
              disabled={guardando}
              onPress={() => setRecibido(v)}
              style={[s.rapido, on && { borderColor: t.acento, borderWidth: 2, backgroundColor: t.acentoSuave }]}
            >
              <Text style={[tipo.subtitulo, { fontSize: 14, color: on ? t.acentoTinta : t.texto }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      {split && <View style={{ flex: 1 }} />}
      <View style={[s.cambio, { backgroundColor: alcanza ? t.exitoSuave : t.peligroSuave }, !split && { paddingVertical: 8 }]}>
        <Text style={[tipo.subtitulo, { fontSize: 15, color: alcanza ? t.exito : t.peligro }]}>Cambio</Text>
        <Text style={[tipo.numero, { fontSize: split ? 34 : 22, color: alcanza ? t.exito : t.peligro }]}>
          {alcanza ? dinero(cambio.fijo(2)) : "No alcanza"}
        </Text>
      </View>
    </View>
  );

  const otroMetodo = (
    <View style={[s.panel, split && { flex: 1 }]}>
      <Aviso
        texto={
          metodo === "TARJETA"
            ? "Cobra en la terminal y confirma solo cuando diga APROBADO. La venta no toca el efectivo de la caja."
            : metodo === "PLATAFORMA" ? "Confirma que el pedido está pagado en la plataforma. No suma efectivo al cajón." : "Confirma la transferencia antes de cerrar la venta."
        }
      />
      <TextInput
        editable={!guardando}
        value={referencia}
        onChangeText={setReferencia}
        placeholder="Referencia o folio (opcional)"
        placeholderTextColor={t.tenue}
        style={s.input}
        accessibilityLabel="Referencia"
      />
    </View>
  );

  const teclado = metodo === "EFECTIVO" && (
    <View style={split ? { width: 320 } : null}>
      <Teclado
        alto={split ? 76 : 46}
        disabled={guardando}
        alPulsar={(key) => setRecibido((value) => teclear(value, key, 8))}
      />
    </View>
  );

  const botones = (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <Boton titulo="Volver" variante="secundario" onPress={cerrar} deshabilitado={guardando} estilo={{ width: split ? 180 : 110, minHeight: 60 }} />
      <Boton
        testID="confirmar-cobro"
        titulo={`Confirmar cobro · ${dinero(total)}`}
        textoCargando="Guardando venta…"
        cargando={guardando}
        deshabilitado={!alcanza}
        estilo={{ flex: 1, minHeight: 60 }}
        onPress={confirmar}
      />
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={cerrar} supportedOrientations={["portrait", "landscape"]}>
      <View
        style={{
          flex: 1,
          backgroundColor: t.fondo,
          paddingTop: insets.top + (split ? 20 : 8),
          paddingBottom: insets.bottom + 16,
          paddingLeft: Math.max(insets.left, split ? 28 : 16),
          paddingRight: Math.max(insets.right, split ? 28 : 16),
        }}
      >
        {split ? (
          <View style={{ flex: 1, flexDirection: "row", gap: 28 }}>
            <View style={{ gap: 12 }}>
              <Pressable accessibilityRole="button" onPress={cerrar} style={s.volver}>
                <Ionicons name="arrow-back" size={18} color={t.tenue} />
                <Text style={[tipo.cuerpo, { color: t.tenue }]}>Volver a la venta</Text>
              </Pressable>
              {ticket}
            </View>
            <View style={{ flex: 1, gap: 18 }}>
              <Text accessibilityRole="header" style={[tipo.titulo, { fontSize: 32, letterSpacing: -0.8 }]}>Cobrar</Text>
              {metodos}
              <View style={{ flex: 1, flexDirection: "row", gap: 18, minHeight: 0 }}>
                {metodo === "EFECTIVO" ? efectivo : otroMetodo}
                {teclado}
              </View>
              {botones}
            </View>
          </View>
        ) : (
          <View style={{ flex: 1, gap: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Pressable accessibilityRole="button" accessibilityLabel="Volver a la venta" onPress={cerrar} style={s.volverIcono}>
                <Ionicons name="arrow-back" size={22} color={t.texto} />
              </Pressable>
              <Text accessibilityRole="header" style={[tipo.titulo, { fontSize: 22 }]}>Cobrar</Text>
            </View>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 10, paddingBottom: 8 }}>
              {ticket}
              {metodos}
              {metodo === "EFECTIVO" ? efectivo : otroMetodo}
              {teclado}
              {casillaFactura()}
            </ScrollView>
            {botones}
          </View>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  marca: { width: 38, height: 38, borderRadius: 11, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  tarjetaNegocio: {
    minHeight: 64, borderRadius: 20, backgroundColor: t.superficie, borderWidth: 1, borderColor: t.borde,
    flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12,
  },
  estadoTablet: {
    minHeight: 52, borderRadius: 16, backgroundColor: t.superficie, borderWidth: 1, borderColor: t.borde,
    flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14,
  },
  estadoCel: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, maxWidth: 120 },
  acceso: {
    flex: 1, height: 52, borderRadius: 16, backgroundColor: t.superficie, borderWidth: 1, borderColor: t.borde,
    alignItems: "center", justifyContent: "center",
  },
  personaCel: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: t.superficie, borderWidth: 1, borderColor: t.borde,
    alignItems: "center", justifyContent: "center",
  },
  cabeceraCel: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12 },
  buscar: {
    flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, borderRadius: 16,
    backgroundColor: t.superficie, borderWidth: 1, borderColor: t.borde, paddingHorizontal: 16,
  },
  cobrar: { borderRadius: 18, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 22 },
  cabecera: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingBottom: 12,
  },
  categoria: {
    minHeight: 60,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: t.borde,
    backgroundColor: t.superficie,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  categoriaChip: {
    minHeight: 44,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: t.borde,
    backgroundColor: t.superficie,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  producto: {
    flex: 1,
    borderRadius: 20,
    borderWidth: 2,
    backgroundColor: t.superficie,
    overflow: "hidden",
  },
  foto: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  insignia: {
    position: "absolute",
    top: 10,
    right: 10,
    minWidth: 32,
    height: 32,
    borderRadius: 16,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  dock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    margin: 16,
    marginTop: 4,
    borderRadius: 24,
    paddingVertical: 12,
    paddingLeft: 22,
    paddingRight: 12,
  },
  lineaDock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 56,
    borderRadius: 16,
    backgroundColor: "#223040",
    paddingLeft: 14,
    paddingRight: 6,
  },
  pasoDock: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: "#33465A",
    alignItems: "center",
    justifyContent: "center",
  },
  pasoDockTxt: { fontSize: 20, color: "#fff", fontWeight: "600" },
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
    borderWidth: 1,
    borderColor: t.borde,
    borderRadius: 14,
    backgroundColor: t.superficie,
    paddingHorizontal: 14,
    minHeight: 50,
    fontSize: 16,
    color: t.texto,
  },
  casilla: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: t.borde,
    justifyContent: "center",
  },
  ticket: {
    backgroundColor: t.superficie,
    borderRadius: 18,
    padding: 22,
    gap: 12,
    flex: 1,
    shadowColor: "#101828",
    shadowOpacity: 0.12,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 3,
  },
  punteado: {
    borderTopWidth: 1,
    borderStyle: "dashed",
    borderColor: t.borde,
  },
  metodo: {
    minHeight: 52,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.borde,
    backgroundColor: t.superficie,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
  },
  panel: {
    backgroundColor: t.superficie,
    borderWidth: 1,
    borderColor: t.borde,
    borderRadius: 20,
    padding: 18,
    gap: 14,
  },
  rapido: {
    flex: 1,
    minHeight: 50,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.borde,
    backgroundColor: t.superficie,
    alignItems: "center",
    justifyContent: "center",
  },
  cambio: {
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  volver: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
  },
  volverIcono: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
