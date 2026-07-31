import { useEffect, useRef } from 'react';
import { Animated, ImageBackground, Image, StyleSheet, Platform, View, Easing } from 'react-native';
import { colors, fonts } from '../theme/tokens';

// Pantalla de bienvenida animada: se muestra al abrir la app (sobre el splash nativo)
// y se desvanece para revelar el login/tablero. No usa dependencias extra.
const NATIVE = Platform.OS !== 'web';

export default function AnimatedSplash({ onDone }: { onDone: () => void }) {
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale   = useRef(new Animated.Value(0.82)).current;
  const logoY       = useRef(new Animated.Value(14)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const overlay     = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.sequence([
      // 1) Entra el logo (aparece, escala y sube un poco)
      Animated.parallel([
        Animated.timing(logoOpacity, { toValue: 1, duration: 550, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE }),
        Animated.spring(logoScale,    { toValue: 1, friction: 7, tension: 60, useNativeDriver: NATIVE }),
        Animated.timing(logoY,        { toValue: 0, duration: 550, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE })
      ]),
      // 2) Entra el lema
      Animated.timing(textOpacity, { toValue: 1, duration: 400, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE }),
      // 3) Espera breve
      Animated.delay(650),
      // 4) Se desvanece toda la pantalla
      Animated.timing(overlay, { toValue: 0, duration: 480, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE })
    ]).start(() => onDone());
  }, []);

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: overlay }]}>
      <ImageBackground
        source={require('../assets/fondo_wybix.png')}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
      >
        <View style={styles.center}>
          <Animated.Image
            source={require('../assets/wybie_logo_white.png')}
            resizeMode="contain"
            style={[
              styles.logo,
              { opacity: logoOpacity, transform: [{ scale: logoScale }, { translateY: logoY }] }
            ]}
          />
          <Animated.Text style={[styles.tagline, { opacity: textOpacity }]}>
            Control de tu negocio
          </Animated.Text>
        </View>
      </ImageBackground>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { zIndex: 999, backgroundColor: colors.navyDeep },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  logo: { width: 150, height: 150 },
  tagline: { marginTop: 18, color: '#CBD9E6', fontFamily: fonts.medium, fontSize: 14, letterSpacing: 0.5 }
});
