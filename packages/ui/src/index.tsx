/**
 * @wybix/ui — piezas compartidas por Wybix Owner y Wybix POS Mobile.
 *
 * POS Mobile se usa en una feria: sol, prisa, dedos. Por eso el tema del POS
 * es claro y de alto contraste, con objetivos táctiles de al menos 48 dp y
 * números tabulares. Los colores de marca son los mismos de Wybix.
 */
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, ActivityIndicator, type ViewStyle, type TextStyle } from 'react-native';

export const marca = {
  navy: '#0F2A3F', cian: '#45B3C3', cianOscuro: '#2E8C9A',
};

/** Tema del POS (claro). */
export const pos = {
  fondo: '#F4F6F8', superficie: '#FFFFFF', hundido: '#E9EDF1', borde: '#D6DDE3',
  texto: '#0F2A3F', tenue: '#5B6B78', acento: '#1F7A8C', acentoTexto: '#FFFFFF',
  exito: '#1E8E5A', aviso: '#B26A00', peligro: '#C0392B', peligroSuave: '#FBEAEA', avisoSuave: '#FFF4E0', exitoSuave: '#E6F5EC',
  radio: 14, tactil: 52,
};

export const tipo = StyleSheet.create({
  titulo: { fontSize: 24, fontWeight: '700', color: pos.texto },
  subtitulo: { fontSize: 18, fontWeight: '600', color: pos.texto },
  cuerpo: { fontSize: 16, color: pos.texto },
  tenue: { fontSize: 14, color: pos.tenue },
  numero: { fontVariant: ['tabular-nums'], fontWeight: '700', color: pos.texto },
});

export function dinero(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type VarianteBoton = 'primario' | 'secundario' | 'peligro' | 'fantasma';
export function Boton({ titulo, onPress, variante = 'primario', deshabilitado, cargando, estilo, testID }: {
  titulo: string; onPress: () => void; variante?: VarianteBoton; deshabilitado?: boolean; cargando?: boolean; estilo?: ViewStyle; testID?: string;
}) {
  const fondo = { primario: pos.acento, secundario: pos.hundido, peligro: pos.peligro, fantasma: 'transparent' }[variante];
  const color = variante === 'primario' || variante === 'peligro' ? pos.acentoTexto : pos.texto;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={titulo} disabled={deshabilitado || cargando} onPress={onPress}
      style={({ pressed }) => [est.boton, { backgroundColor: fondo, opacity: deshabilitado ? 0.45 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }, estilo]}>
      {cargando ? <ActivityIndicator color={color} /> : <Text style={[est.botonTexto, { color }]}>{titulo}</Text>}
    </Pressable>
  );
}

/** Teclado numérico grande (PIN, cantidades, efectivo). */
export function Teclado({ alPulsar, extra = '.' }: { alPulsar: (t: string) => void; extra?: string | null }) {
  const filas = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], [extra ?? '', '0', '⌫']];
  return (
    <View style={est.teclado}>
      {filas.map((f, i) => (
        <View key={i} style={est.tecladoFila}>
          {f.map((t, j) => t === '' ? <View key={j} style={est.tecla} /> : (
            <Pressable key={j} accessibilityRole="button" accessibilityLabel={t === '⌫' ? 'Borrar' : t} onPress={() => alPulsar(t)}
              style={({ pressed }) => [est.tecla, est.teclaActiva, pressed && { backgroundColor: pos.borde }]}>
              <Text style={est.teclaTexto}>{t}</Text>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

/** Aplica una tecla del Teclado a un valor de texto. */
export function teclear(valor: string, t: string, max = 10): string {
  if (t === '⌫') return valor.slice(0, -1);
  if (t === '.' && valor.includes('.')) return valor;
  if (valor.length >= max) return valor;
  return valor + t;
}

/** Puntitos del PIN (nunca se muestra el número). */
export function Puntos({ n, max = 8 }: { n: number; max?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'center', marginVertical: 16 }}>
      {Array.from({ length: Math.max(4, Math.min(max, n || 4)) }, (_, i) => (
        <View key={i} style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: i < n ? pos.texto : pos.borde }} />
      ))}
    </View>
  );
}

/** "Todo sincronizado" / "18 operaciones pendientes" — lo único que el cajero necesita saber. */
export function BarraSync({ texto, pendientes, enLinea, revocado, enRevision = 0, onPress }: { texto: string; pendientes: number; enLinea: boolean; revocado?: boolean; enRevision?: number; onPress?: () => void }) {
  // Verde solo si TODO subió: un rechazo o una cuarentena "en revisión" es aviso.
  const color = revocado ? pos.peligro : !enLinea || pendientes > 0 || enRevision > 0 ? pos.aviso : pos.exito;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={texto} onPress={onPress} style={[est.barra, { borderColor: color }]}>
      <View style={[est.punto, { backgroundColor: color }]} />
      <Text style={[tipo.tenue, { color: pos.texto }]} numberOfLines={1}>{texto}</Text>
    </Pressable>
  );
}

export function Tarjeta({ children, estilo }: { children: ReactNode; estilo?: ViewStyle }) {
  return <View style={[est.tarjeta, estilo]}>{children}</View>;
}

export function Aviso({ texto, tono = 'aviso' }: { texto: string; tono?: 'aviso' | 'peligro' | 'exito' }) {
  const fondo = { aviso: pos.avisoSuave, peligro: pos.peligroSuave, exito: pos.exitoSuave }[tono];
  const color = { aviso: pos.aviso, peligro: pos.peligro, exito: pos.exito }[tono];
  return <View style={[est.aviso, { backgroundColor: fondo }]}><Text style={[tipo.cuerpo, { color }]}>{texto}</Text></View>;
}

export function useCargando() {
  const [c, setC] = useState(false);
  return { cargando: c, envolver: async <T,>(fn: () => Promise<T>) => { setC(true); try { return await fn(); } finally { setC(false); } } };
}

const est = StyleSheet.create({
  boton: { minHeight: pos.tactil, borderRadius: pos.radio, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  botonTexto: { fontSize: 17, fontWeight: '700' } as TextStyle,
  teclado: { gap: 10 },
  tecladoFila: { flexDirection: 'row', gap: 10 },
  tecla: { flex: 1, height: 64, borderRadius: pos.radio, alignItems: 'center', justifyContent: 'center' },
  teclaActiva: { backgroundColor: pos.hundido },
  teclaTexto: { fontSize: 26, fontWeight: '600', color: pos.texto, fontVariant: ['tabular-nums'] } as TextStyle,
  barra: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: pos.superficie, maxWidth: 360 },
  punto: { width: 10, height: 10, borderRadius: 5 },
  tarjeta: { backgroundColor: pos.superficie, borderRadius: pos.radio, padding: 16, borderWidth: 1, borderColor: pos.borde },
  aviso: { borderRadius: pos.radio, padding: 12 },
});
