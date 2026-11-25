/**
 * DOCK de Owner: la barra de secciones flota como el dock de la caja de
 * escritorio (riel #0F1826, radio 26, elegido con fondo elevado y raya cian).
 *
 * Por qué no la barra de pestañas de siempre: medía 60 px fijos y no sumaba el
 * área segura; en Safari (y como PWA, con viewport-fit=cover) el indicador de
 * inicio tapaba las etiquetas. El dock va EN el flujo, debajo de la pantalla,
 * y deja abajo el área segura + 12 px: nunca tapa contenido ni lo tapan a él.
 *
 * Wybix Guide a la izquierda (como en la caja): su cara se pone atenta si hay
 * alertas o riesgos. Cuatro secciones fijas y «Más», que abre un cajón con el resto (Blindaje,
 * Aprobaciones, Sucursales, Avisos, Seguridad). El aviso de Blindaje sube a
 * «Más» mientras el cajón está cerrado para que no se pierda.
 */
import { memo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Guide } from '@wybix/ui';
import { colors, fonts } from '../theme/tokens';

const d = {
  riel: '#0F1826',
  elevado: '#16233A',
  elegido: '#1B2740',
  borde: 'rgba(255,255,255,0.10)',
  tenue: '#7D8DA1',
  fuerte: '#F4F8FC',
  cian: '#45B3C3',
  rojo: '#DC2626',
  ambar: '#FBBF24',
};

type Icono = keyof typeof Ionicons.glyphMap;

/** Pestañas que van en el dock, en orden. El resto vive en «Más». */
const FIJAS: { ruta: string; nombre: string; icono: Icono; iconoOn: Icono }[] = [
  { ruta: 'index', nombre: 'Inicio', icono: 'home-outline', iconoOn: 'home' },
  { ruta: 'eventos', nombre: 'Eventos', icono: 'storefront-outline', iconoOn: 'storefront' },
  { ruta: 'cortes', nombre: 'Cortes', icono: 'cash-outline', iconoOn: 'cash' },
  { ruta: 'alertas', nombre: 'Alertas', icono: 'notifications-outline', iconoOn: 'notifications' },
];

type ItemMas = { id: string; nombre: string; icono: Icono; color: string; tab?: string; href?: Href };
const MAS: ItemMas[] = [
  { id: 'blindaje', nombre: 'Blindaje', icono: 'shield-checkmark-outline', color: d.cian, tab: 'blindaje' },
  { id: 'aprobaciones', nombre: 'Aprobaciones', icono: 'hand-left-outline', color: d.cian, href: '/aprobaciones' },
  { id: 'sucursales', nombre: 'Sucursales', icono: 'business-outline', color: d.cian, href: '/sucursales' },
  { id: 'avisos', nombre: 'Avisos', icono: 'chatbox-ellipses-outline', color: d.cian, href: '/avisos' },
  { id: 'seguridad', nombre: 'Seguridad', icono: 'lock-closed-outline', color: d.ambar, href: '/mfa' },
];

const cifra = (n: number) => (n > 9 ? '9+' : String(n));

/** Alto que ocupa el dock sin el área segura (para quien necesite medirlo). */
export const ALTO_DOCK = 8 + 56 + 8 + 2 + 12;

const Insignia = memo(function Insignia({ n, arriba = 4, derecha = 10 }: { n: number; arriba?: number; derecha?: number }) {
  if (n <= 0) return null;
  return (
    <View style={[s.insignia, { top: arriba, right: derecha }]} accessibilityElementsHidden importantForAccessibility="no">
      <Text style={s.insigniaTexto}>{cifra(n)}</Text>
    </View>
  );
});

function Item({
  nombre, icono, on, aviso = 0, onPress, testID,
}: { nombre: string; icono: Icono; on: boolean; aviso?: number; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      accessibilityLabel={aviso > 0 ? `${nombre}, ${aviso} pendientes` : nombre}
      onPress={onPress}
      style={({ pressed }) => [s.item, on && s.itemOn, pressed && !on && { backgroundColor: 'rgba(255,255,255,0.04)' }]}
    >
      <Ionicons name={icono} size={22} color={on ? d.fuerte : d.tenue} />
      <Text numberOfLines={1} style={[s.etiqueta, { color: on ? d.fuerte : d.tenue, fontFamily: on ? fonts.semibold : fonts.medium }]}>
        {nombre}
      </Text>
      {on && <View style={s.raya} />}
      <Insignia n={aviso} />
    </Pressable>
  );
}

export function Dock({ state, navigation, alertas, blindaje }: BottomTabBarProps & { alertas: number; blindaje: number }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const actual = state.routes[state.index]?.name;
  const enMas = !FIJAS.some((f) => f.ruta === actual);

  const ir = (ruta: string) => {
    const r = state.routes.find((x) => x.name === ruta);
    if (!r) return;
    const ev = navigation.emit({ type: 'tabPress', target: r.key, canPreventDefault: true });
    if (actual !== ruta && !ev.defaultPrevented) navigation.navigate(ruta);
  };
  const abrir = (it: ItemMas) => {
    setAbierto(false);
    if (it.tab) ir(it.tab);
    else if (it.href) router.push(it.href);
  };

  const abajo = insets.bottom + 12;
  const barra = (cerrar: boolean) => (
    <View style={s.barra} accessibilityRole="tablist">
      {/* Wybix Guide, como en el dock del POS: atento si algo espera. */}
      <View style={s.guide}>
        <Guide
          cara={alertas + blindaje > 0 ? 'atencion' : 'reposo'}
          size={32}
          etiqueta={alertas + blindaje > 0 ? `Wybix Guide: ${alertas + blindaje} pendientes` : 'Wybix Guide: todo en orden'}
        />
      </View>
      {FIJAS.map((f) => (
        <Item
          key={f.ruta}
          testID={`dock-${f.ruta}`}
          nombre={f.nombre}
          icono={actual === f.ruta && !cerrar ? f.iconoOn : f.icono}
          on={!cerrar && actual === f.ruta}
          aviso={f.ruta === 'alertas' ? alertas : 0}
          onPress={() => { setAbierto(false); ir(f.ruta); }}
        />
      ))}
      <Item
        testID="dock-mas"
        nombre={cerrar ? 'Cerrar' : 'Más'}
        icono={cerrar ? 'close' : 'ellipsis-horizontal'}
        on={cerrar || enMas}
        aviso={cerrar ? 0 : blindaje}
        onPress={() => setAbierto(!cerrar)}
      />
    </View>
  );

  return (
    <View style={[s.envoltura, { paddingBottom: abajo }]}>
      {barra(false)}
      <Modal
        visible={abierto}
        transparent
        animationType="fade"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setAbierto(false)}
      >
        <Pressable style={s.velo} onPress={() => setAbierto(false)} accessibilityLabel="Cerrar el cajón" accessibilityRole="button" />
        <View style={[s.cajonCaja, { bottom: abajo + ALTO_DOCK - 12 + 14 }]} pointerEvents="box-none">
          <View style={s.cajon} accessibilityLabel="Más secciones">
            <Text style={s.cajonTitulo}>MÁS</Text>
            <View style={s.rejilla}>
              {MAS.map((it) => (
                <Pressable
                  key={it.id}
                  testID={`mas-${it.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={it.id === 'blindaje' && blindaje > 0 ? `${it.nombre}, ${blindaje} riesgos altos` : it.nombre}
                  onPress={() => abrir(it)}
                  style={({ pressed }) => [s.celda, (pressed || actual === it.tab) && { backgroundColor: d.elegido }]}
                >
                  <Ionicons name={it.icono} size={24} color={it.color} />
                  <Text numberOfLines={1} style={s.celdaTexto}>{it.nombre}</Text>
                  {it.id === 'blindaje' && <Insignia n={blindaje} arriba={8} derecha={10} />}
                </Pressable>
              ))}
            </View>
          </View>
        </View>
        <View style={[s.envoltura, s.flotante, { paddingBottom: abajo }]}>{barra(true)}</View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  envoltura: { paddingHorizontal: 14, paddingTop: 8, backgroundColor: colors.bg, alignItems: 'center' },
  flotante: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'transparent' },
  barra: {
    width: '100%',
    maxWidth: 560,
    flexDirection: 'row',
    gap: 2,
    padding: 8,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: d.borde,
    backgroundColor: d.riel,
    shadowColor: '#060B11',
    shadowOpacity: 0.55,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 14 },
    elevation: 14,
  },
  guide: { width: 40, alignItems: 'center', justifyContent: 'center' },
  item: { flex: 1, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center', gap: 4 },
  itemOn: { backgroundColor: d.elegido },
  etiqueta: { fontSize: 11 },
  raya: { position: 'absolute', bottom: 5, width: 18, height: 2.5, borderRadius: 2, backgroundColor: d.cian },
  insignia: {
    position: 'absolute',
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 999,
    backgroundColor: d.rojo,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: d.riel,
  },
  insigniaTexto: { color: '#FFFFFF', fontSize: 10, fontFamily: fonts.bold },
  velo: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(5,10,15,0.55)' },
  cajonCaja: { position: 'absolute', left: 14, right: 14, alignItems: 'center' },
  cajon: {
    width: '100%',
    maxWidth: 560,
    gap: 6,
    padding: 14,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: d.borde,
    backgroundColor: d.riel,
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 22 },
    elevation: 16,
  },
  cajonTitulo: { fontSize: 11, fontFamily: fonts.semibold, letterSpacing: 1.5, color: d.tenue, paddingHorizontal: 8, paddingVertical: 4 },
  rejilla: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  celda: {
    flexBasis: '31%',
    flexGrow: 0,
    minHeight: 88,
    borderRadius: 18,
    backgroundColor: d.elevado,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 8,
  },
  celdaTexto: { fontSize: 12, fontFamily: fonts.semibold, color: d.fuerte },
});
