import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, TextInput, Image, StyleSheet, ActivityIndicator } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { normalizarColor, temaDeMarca, logoValido, contraste, COLOR_WYBIX, LOGO_MAX_CARACTERES } from '@wybix/domain';
import { eventos, mensaje } from '../lib/useEventos';
import { colors, fonts, radius } from '../theme/tokens';

/*
 * MARCA DEL NEGOCIO en Wybix POS Mobile.
 *
 * Es de la EMPRESA (no del evento): todas sus tablets la reciben con la
 * siguiente sincronización. Un solo color de acento y el logo; la barra, los
 * avisos y los textos siguen siendo de Wybix. Si el color no se lee bien, la
 * tablet ajusta solo el tono del texto o del botón (@wybix/domain · marca.ts)
 * y aquí se avisa antes de guardar.
 */
const SUGERIDOS = [COLOR_WYBIX, '#E91E63', '#C62828', '#EF6C00', '#F9A825', '#2E7D32', '#1F2E86', '#6A1B9A', '#4E342E', '#212121'];

async function prepararLogo(uri: string): Promise<string> {
  // PNG conserva la transparencia; si pesa demasiado se reduce y al final JPEG.
  for (const [ancho, formato, calidad] of [[480, SaveFormat.PNG, 1], [320, SaveFormat.PNG, 1], [320, SaveFormat.JPEG, 0.85]] as const) {
    const r = await manipulateAsync(uri, [{ resize: { width: ancho } }], { format: formato, compress: calidad, base64: true });
    const datos = `data:image/${formato === SaveFormat.PNG ? 'png' : 'jpeg'};base64,${r.base64}`;
    if (datos.length <= LOGO_MAX_CARACTERES) return datos;
  }
  throw new Error('El logo es demasiado pesado. Usa una imagen más sencilla (PNG con fondo transparente).');
}

export function MarcaNegocio({ empresa, administra }: { empresa: string; administra: boolean }) {
  const [cargando, setCargando] = useState(true);
  const [guardada, setGuardada] = useState<{ color: string | null; logo: string | null }>({ color: null, logo: null });
  const [colorTxt, setColorTxt] = useState('');
  const [logo, setLogo] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<{ texto: string; error: boolean } | null>(null);

  const cargar = useCallback(async () => {
    const r = await eventos.marca(empresa);
    const m = (r.ok ? (r.marca as { color: string | null; logo: string | null } | null) : null) ?? { color: null, logo: null };
    setGuardada(m); setColorTxt(m.color ?? ''); setLogo(m.logo); setCargando(false);
  }, [empresa]);
  useEffect(() => { void cargar(); }, [cargar]);

  const color = normalizarColor(colorTxt);
  const colorInvalido = colorTxt.trim() !== '' && !color;
  const tema = useMemo(() => temaDeMarca(color), [color]);
  const ajustado = !!color && (tema.acento !== color || tema.acentoTinta !== color);
  const cambios = (color ?? null) !== (guardada.color ?? null) || (logo ?? null) !== (guardada.logo ?? null);

  const elegirLogo = async () => {
    setAviso(null);
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (r.canceled || !r.assets?.[0]) return;
    setOcupado(true);
    try {
      const datos = await prepararLogo(r.assets[0].uri);
      if (!logoValido(datos)) throw new Error('No se pudo leer la imagen. Prueba con un PNG o JPG.');
      setLogo(datos);
    } catch (e) { setAviso({ texto: (e as Error).message, error: true }); }
    finally { setOcupado(false); }
  };

  const guardar = async () => {
    setOcupado(true); setAviso(null);
    const r = await eventos.guardarMarca(empresa, { color, logo });
    setOcupado(false);
    if (!r.ok) { setAviso({ texto: mensaje(r.code), error: true }); return; }
    setGuardada({ color, logo });
    setAviso({ texto: 'Marca guardada. Las tablets la toman en su siguiente sincronización.', error: false });
  };

  if (cargando) return <View style={st.card}><ActivityIndicator color={colors.primary} /></View>;

  return (
    <View style={st.card}>
      <Text style={st.sub}>Logo y color de tu negocio en todas tus tablets. Lo demás sigue siendo de Wybix para que todo se lea en la feria.</Text>

      {/* Vista previa: la barra y un botón como se ven en la tablet. */}
      <View style={st.preview} accessibilityLabel="Vista previa de la tablet">
        <View style={st.previewBarra}>
          {logo
            ? <View style={st.logoPill}><Image source={{ uri: logo }} style={st.logo} resizeMode="contain" accessibilityLabel="Logo del negocio" /></View>
            : <Text style={st.wybix}>Wybix<Text style={{ color: colors.sky }}>.</Text></Text>}
          <Text style={st.previewTitulo}>Vender</Text>
        </View>
        <View style={st.previewCuerpo}>
          <View style={[st.chip, { backgroundColor: tema.seleccion }]}><Text style={st.chipTxt}>Dona glaseada ✓</Text></View>
          <Text style={[st.precio, { color: tema.acentoTinta }]}>DISPONIBLE · $25.00</Text>
          <View style={[st.previewBtn, { backgroundColor: tema.acento }]}><Text style={[st.previewBtnTxt, { color: tema.acentoTexto }]}>Cobrar</Text></View>
        </View>
      </View>
      {ajustado && <Text style={st.sub}>Ese color es claro o medio: la tablet oscurece un poco el texto o el botón para que se lea (contraste {contraste(tema.acento, tema.acentoTexto).toFixed(1)}:1).</Text>}

      <Text style={st.lbl}>Color</Text>
      <View style={st.swatches}>
        {SUGERIDOS.map((c) => (
          <Pressable key={c} onPress={() => setColorTxt(c)} disabled={!administra} accessibilityRole="button" accessibilityLabel={`Usar color ${c}`}
            style={[st.swatch, { backgroundColor: c }, color === c && st.swatchOn]} />
        ))}
      </View>
      <TextInput value={colorTxt} onChangeText={setColorTxt} editable={administra} placeholder="#RRGGBB (vacío = color de Wybix)"
        placeholderTextColor={colors.muted} autoCapitalize="characters" maxLength={7} style={[st.input, colorInvalido && { borderColor: colors.danger }]}
        accessibilityLabel="Color de la marca en formato hexadecimal" />
      {colorInvalido && <Text style={st.error}>Escribe el color como #RRGGBB, por ejemplo #E91E63.</Text>}

      <Text style={st.lbl}>Logo</Text>
      <View style={st.fila}>
        <Boton titulo={logo ? 'Cambiar logo' : 'Elegir logo'} secundario onPress={elegirLogo} deshabilitado={!administra || ocupado} />
        {logo && <Boton titulo="Quitar logo" secundario onPress={() => setLogo(null)} deshabilitado={!administra || ocupado} />}
      </View>
      <Text style={st.sub}>Mejor PNG con fondo transparente. Se guarda pequeño para que viaje a la tablet y funcione sin Internet.</Text>

      {aviso && <Text style={aviso.error ? st.error : st.ok}>{aviso.texto}</Text>}
      {administra
        ? <Boton titulo={ocupado ? 'Guardando…' : 'Guardar marca'} onPress={guardar} deshabilitado={ocupado || colorInvalido || !cambios} />
        : <Text style={st.sub}>Solo el dueño o un administrador puede cambiar la marca.</Text>}
    </View>
  );
}

function Boton({ titulo, onPress, deshabilitado, secundario }: { titulo: string; onPress: () => void; deshabilitado?: boolean; secundario?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={deshabilitado} accessibilityRole="button"
      style={[st.btn, secundario ? st.btnSec : st.btnPri, deshabilitado && st.btnOff]}>
      <Text style={secundario ? st.btnSecTxt : st.btnPriTxt}>{titulo}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: 14, gap: 8 },
  sub: { fontFamily: fonts.regular, color: colors.muted, fontSize: 12.5 },
  lbl: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 13, marginTop: 6 },
  error: { fontFamily: fonts.medium, color: colors.danger, fontSize: 13 },
  ok: { fontFamily: fonts.medium, color: colors.success, fontSize: 13 },
  fila: { flexDirection: 'row', gap: 10 },
  preview: { borderRadius: radius.sm, overflow: 'hidden', borderWidth: 1, borderColor: colors.line },
  previewBarra: { backgroundColor: '#0F1826', flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  logoPill: { backgroundColor: '#FFFFFF', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  logo: { width: 96, height: 30 },
  wybix: { fontFamily: fonts.bold, color: '#FFFFFF', fontSize: 18 },
  previewTitulo: { fontFamily: fonts.semibold, color: '#FFFFFF', fontSize: 15 },
  previewCuerpo: { backgroundColor: '#F2F5F9', padding: 12, gap: 10 },
  chip: { alignSelf: 'flex-start', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  chipTxt: { fontFamily: fonts.semibold, color: '#102B40', fontSize: 13 },
  precio: { fontFamily: fonts.semibold, fontSize: 12, letterSpacing: 0.5 },
  previewBtn: { borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  previewBtnTxt: { fontFamily: fonts.semibold, fontSize: 14 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  swatch: { width: 36, height: 36, borderRadius: 18, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: '#FFFFFF' },
  input: { fontFamily: fonts.regular, color: colors.ink, fontSize: 14, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.bg },
  btn: { flex: 1, borderRadius: radius.sm, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  btnPri: { backgroundColor: colors.primary },
  btnPriTxt: { fontFamily: fonts.semibold, color: '#fff', fontSize: 14 },
  btnSec: { backgroundColor: 'rgba(255,255,255,0.06)' },
  btnSecTxt: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 14 },
  btnOff: { opacity: 0.45 },
});
