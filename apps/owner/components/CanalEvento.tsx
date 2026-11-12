import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { eventos, mensaje } from '../lib/useEventos';
import { colors, fonts, radius } from '../theme/tokens';

/*
 * CANAL DE PRECIOS DEL EVENTO.
 *
 * Los canales y sus precios los define la sucursal base en el panel comercial
 * del POS de escritorio. Aquí solo se elige con cuál EMPIEZA cada cuenta en
 * las tablets de este evento; la cajera puede cambiarlo en una cuenta. La
 * tablet lo toma en su siguiente sincronización.
 */
type Canal = { id: string; name: string; active: boolean };

export function CanalEvento({ empresa, evento, administra }: { empresa: string; evento: string; administra: boolean }) {
  const [cargando, setCargando] = useState(true);
  const [canales, setCanales] = useState<Canal[]>([]);
  const [actual, setActual] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<{ texto: string; error: boolean } | null>(null);

  const cargar = useCallback(async () => {
    const r = await eventos.canales(empresa, evento);
    if (r.ok) { setCanales(((r.canales as Canal[]) ?? []).filter((c) => c.active)); setActual((r.canal as string | null) ?? null); }
    else setAviso({ texto: mensaje(r.code), error: true });
    setCargando(false);
  }, [empresa, evento]);
  useEffect(() => { void cargar(); }, [cargar]);

  const elegir = async (id: string) => {
    const canal = id === 'LOCAL' ? null : id;
    if (canal === actual || ocupado) return;
    setOcupado(true); setAviso(null);
    const r = await eventos.guardarCanal(empresa, evento, canal);
    setOcupado(false);
    if (!r.ok) { setAviso({ texto: mensaje(r.code), error: true }); if (r.code === 'BAD_CHANNEL') void cargar(); return; }
    setActual(canal);
    setAviso({ texto: 'Guardado. Las tablets lo toman en su siguiente sincronización.', error: false });
  };

  if (cargando) return <View style={st.card}><ActivityIndicator color={colors.primary} /></View>;
  const lista: Canal[] = canales.some((c) => c.id === 'LOCAL') ? canales : [{ id: 'LOCAL', name: 'Mostrador', active: true }, ...canales];

  return (
    <View style={st.card}>
      <Text style={st.sub}>Con qué precios empieza cada cuenta en las tablets. La cajera puede cambiarlo en una venta.</Text>
      <View style={st.chips} accessibilityRole="radiogroup">
        {lista.map((c) => {
          const on = (actual ?? 'LOCAL') === c.id;
          return (
            <Pressable key={c.id} onPress={() => elegir(c.id)} disabled={!administra || ocupado}
              accessibilityRole="radio" accessibilityState={{ checked: on, disabled: !administra || ocupado }}
              style={[st.chip, on && st.chipOn, (!administra || ocupado) && !on && { opacity: 0.6 }]}>
              <Text style={[st.chipTxt, on && st.chipTxtOn]}>{c.name}</Text>
            </Pressable>
          );
        })}
      </View>
      {lista.length <= 1 && (
        <Text style={st.sub}>La sucursal base solo tiene Mostrador. Crea canales (p. ej. "Feria") con sus precios en el panel comercial del POS de escritorio y publica el catálogo.</Text>
      )}
      {aviso && <Text style={aviso.error ? st.error : st.ok}>{aviso.texto}</Text>}
      {!administra && <Text style={st.sub}>Solo el dueño o un administrador puede cambiarlo.</Text>}
    </View>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: 14, gap: 10 },
  sub: { fontFamily: fonts.regular, color: colors.muted, fontSize: 12.5 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, paddingHorizontal: 16, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.04)' },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipTxt: { fontFamily: fonts.semibold, color: colors.ink, fontSize: 14 },
  chipTxtOn: { color: '#04161A' },
  error: { fontFamily: fonts.medium, color: colors.danger, fontSize: 13 },
  ok: { fontFamily: fonts.medium, color: colors.success, fontSize: 13 },
});
