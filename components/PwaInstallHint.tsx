import { Platform, View, Text, Pressable, StyleSheet } from 'react-native';
import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, radius } from '../theme/tokens';

// Aviso "Agregar a inicio" — solo en Safari de iOS cuando aún no está instalada.
// En Android/iOS nativos y en la app ya instalada, no muestra nada.
export default function PwaInstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    try {
      const nav: any = window.navigator;
      const ua = String(nav.userAgent || '');
      const isIOS = /iphone|ipad|ipod/i.test(ua);
      const standalone = nav.standalone === true ||
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
      const dismissed = window.localStorage?.getItem('wybix_pwa_hint') === '1';
      if (isIOS && !standalone && !dismissed) setShow(true);
    } catch { /* noop */ }
  }, []);

  if (Platform.OS !== 'web' || !show) return null;

  const cerrar = () => {
    try { window.localStorage?.setItem('wybix_pwa_hint', '1'); } catch { /* noop */ }
    setShow(false);
  };

  return (
    <View style={styles.wrap}>
      <Ionicons name="phone-portrait-outline" size={22} color={colors.skyLight} />
      <Text style={styles.txt}>
        Instala Wybix: toca <Text style={styles.b}>Compartir</Text> y luego <Text style={styles.b}>Agregar a inicio</Text>.
      </Text>
      <Pressable onPress={cerrar} hitSlop={8}>
        <Ionicons name="close" size={20} color="#94a3b8" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute', left: 12, right: 12, bottom: 12, zIndex: 9999,
    backgroundColor: colors.navy, borderRadius: radius.md, padding: 14,
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  txt: { flex: 1, color: '#fff', fontFamily: fonts.medium, fontSize: 13 },
  b: { fontFamily: fonts.bold, color: colors.skyLight },
});
