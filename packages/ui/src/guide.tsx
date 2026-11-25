/**
 * WYBIX GUIDE y el LOGO: lo que comparten la caja de escritorio, POS Mobile y
 * Wybix Owner para que las tres se sientan una sola.
 *
 * GUIDE: el mismo personaje de wx-mascota (Blobatar, semilla `wybix:mascota`,
 * cian), dibujado fijo para no depender de la librería en la primera pantalla.
 * Cuatro caras, ni una más (regla del escritorio): `reposo`, `atencion`,
 * `exito`, `error`. El estado cambia la cara, nunca el personaje. El error
 * acompaña a su texto, no lo sustituye.
 *
 * Movimiento: `respira` mece la figura (3.2 s) y `asoma` la sube y baja para
 * verse asomada sobre una tarjeta. Con «reducir movimiento» queda quieta.
 *
 * LOGO: el PNG de la marca (la W), blanco sobre oscuro y navy sobre claro.
 * Nunca se redibuja.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, Text, View, type ImageStyle, type StyleProp } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';

export type CaraGuide = 'reposo' | 'atencion' | 'exito' | 'error';

const CUERPO =
  'M86.01 48.98C86.01 71.14 73.87 82.65 50.52 82.65C27.17 82.65 15.03 71.14 15.03 48.98C15.03 26.83 27.17 15.32 50.52 15.32C73.87 15.32 86.01 26.83 86.01 48.98Z';
const CUERPO_BAJO =
  'M86.01 52.98C86.01 72.14 73.87 82.65 50.52 82.65C27.17 82.65 15.03 72.14 15.03 52.98C15.03 30.83 27.17 19.32 50.52 19.32C73.87 19.32 86.01 30.83 86.01 52.98Z';
const OJOS: Record<CaraGuide, [string, string]> = {
  reposo: [
    'M44.31 49.3C42.69 58.74 42.69 58.74 39.69 58.23C36.68 57.71 36.68 57.71 38.31 48.27C39.93 38.82 39.93 38.82 42.94 39.34C45.94 39.85 45.94 39.85 44.31 49.3Z',
    'M65.13 49.82C63.49 58.1 63.49 58.1 60.83 57.58C58.18 57.05 58.18 57.05 59.82 48.77C61.46 40.49 61.46 40.49 64.11 41.01C66.76 41.54 66.76 41.54 65.13 49.82Z',
  ],
  atencion: [
    'M44.87 48.16C43.67 59.6 43.67 59.6 39.61 59.17C35.55 58.74 35.55 58.74 36.75 47.31C37.95 35.87 37.95 35.87 42.01 36.29C46.07 36.72 46.07 36.72 44.87 48.16Z',
    'M66.73 48.05C67.29 58.76 67.29 58.76 63.53 58.95C59.78 59.15 59.78 59.15 59.22 48.44C58.65 37.73 58.65 37.73 62.41 37.54C66.17 37.34 66.17 37.34 66.73 48.05Z',
  ],
  exito: [
    'M45 46.55C45.4 49.4 45.4 49.4 40.21 50.13C35.02 50.86 35.02 50.86 34.62 48.01C34.22 45.16 34.22 45.16 39.41 44.43C44.6 43.71 44.6 43.71 45 46.55Z',
    'M68.79 47.12C69.21 50.04 69.21 50.04 64.38 50.72C59.56 51.4 59.56 51.4 59.15 48.47C58.74 45.55 58.74 45.55 63.56 44.87C68.38 44.19 68.38 44.19 68.79 47.12Z',
  ],
  error: [
    'M44.31 49.3C42.69 58.74 42.69 58.74 39.69 58.23C36.68 57.71 36.68 57.71 38.31 48.27C39.93 38.82 39.93 38.82 42.94 39.34C45.94 39.85 45.94 39.85 44.31 49.3Z',
    'M65.13 49.82C63.49 58.1 63.49 58.1 60.83 57.58C58.18 57.05 58.18 57.05 59.82 48.77C61.46 40.49 61.46 40.49 64.11 41.01C66.76 41.54 66.76 41.54 65.13 49.82Z',
  ],
};
const SUBE: Record<CaraGuide, number> = { reposo: 0, atencion: -1.4, exito: -2.2, error: 0 };
const ETIQUETA: Record<CaraGuide, string> = {
  reposo: 'Wybix Guide', atencion: 'Wybix Guide, atento', exito: 'Wybix Guide, contento', error: 'Wybix Guide, algo salió mal',
};

/** Movimiento reducido del sistema, leído una vez y escuchado después. */
export function useMovimientoReducido(): boolean {
  const [reducido, setReducido] = useState(false);
  useEffect(() => {
    let vivo = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (vivo) setReducido(v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducido);
    return () => { vivo = false; sub.remove(); };
  }, []);
  return reducido;
}

export const Guide = memo(function Guide({
  cara = 'reposo',
  size = 48,
  movimiento = 'respira',
  etiqueta,
}: {
  cara?: CaraGuide;
  size?: number;
  /** `respira`: casi quieto (dock, tarjetas). `asoma`: sube y baja sobre una tarjeta. */
  movimiento?: 'respira' | 'asoma' | 'quieto';
  /** Texto para lector de pantalla; null lo oculta (decoración junto a un texto). */
  etiqueta?: string | null;
}) {
  const reducido = useMovimientoReducido();
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reducido || movimiento === 'quieto') { y.setValue(0); return; }
    const mitad = movimiento === 'asoma' ? 1500 : 1600;
    const ciclo = Animated.loop(Animated.sequence([
      Animated.timing(y, { toValue: 1, duration: mitad, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(y, { toValue: 0, duration: mitad, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    ciclo.start();
    return () => ciclo.stop();
  }, [reducido, movimiento, y]);
  const amplitud = movimiento === 'asoma' ? size * 0.05 : size * 0.03;
  const desplazar = y.interpolate({ inputRange: [0, 1], outputRange: [movimiento === 'asoma' ? amplitud : 0, movimiento === 'asoma' ? 0 : -amplitud] });
  const oculto = etiqueta === null;
  const [izq, der] = OJOS[cara];
  return (
    <Animated.View
      accessible={!oculto}
      accessibilityRole={oculto ? undefined : 'image'}
      accessibilityLabel={oculto ? undefined : (etiqueta ?? ETIQUETA[cara])}
      accessibilityElementsHidden={oculto}
      importantForAccessibility={oculto ? 'no-hide-descendants' : 'auto'}
      style={{ width: size, height: size, transform: [{ translateY: desplazar }] }}
    >
      <Svg viewBox="0 0 100 100" width={size} height={size}>
        <G transform={`translate(0 ${SUBE[cara]})`}>
          <Path d={cara === 'error' ? CUERPO_BAJO : CUERPO} fill="#00BFC6" />
          <G fill="#051213" transform={cara === 'error' ? 'translate(0 25) scale(1 0.55)' : undefined}>
            <Path d={izq} />
            <Path d={der} />
          </G>
        </G>
      </Svg>
    </Animated.View>
  );
});

const LOGO_BLANCO = require('../assets/logo-wybix-blanco.png');
const LOGO_NAVY = require('../assets/logo-wybix.png');

/** La W de Wybix en imagen. `sobre`: el fondo donde va (oscuro → blanca). */
export function LogoWybix({ size = 32, sobre = 'oscuro', style }: { size?: number; sobre?: 'oscuro' | 'claro'; style?: StyleProp<ImageStyle> }) {
  return (
    <Image
      source={sobre === 'oscuro' ? LOGO_BLANCO : LOGO_NAVY}
      style={[{ width: size, height: size }, style]}
      resizeMode="contain"
      accessibilityLabel="Wybix"
    />
  );
}

/** Logo + «Wybix.» + la línea del producto (POS MOBILE, OWNER). */
export function MarcaWybix({ producto, size = 40, fuente = 'Geist_700Bold' }: { producto: string; size?: number; fuente?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }} accessible accessibilityLabel={`Wybix ${producto}`}>
      <LogoWybix size={size} />
      <View style={{ gap: 1 }}>
        <Text style={{ fontFamily: fuente, fontSize: size * 0.6, letterSpacing: -size * 0.024, color: '#F4F8FC' }}>
          Wybix<Text style={{ color: '#45B3C3' }}>.</Text>
        </Text>
        <Text style={{ fontFamily: fuente, fontSize: 9, letterSpacing: 1.8, color: '#8FA0B3' }}>{producto.toUpperCase()}</Text>
      </View>
    </View>
  );
}

/**
 * Colores del POS de escritorio (tokens.css, tema oscuro). Los usan POS Mobile
 * y Owner para que una tarjeta, un borde o un elegido se vean igual en las tres.
 */
export const wx = {
  lienzo: '#0A1119',
  riel: '#0F1826',
  superficie: '#101A26',
  elevado: '#16233A',
  elegido: '#1B2740',
  borde: 'rgba(255,255,255,0.10)',
  bordeFuerte: 'rgba(255,255,255,0.16)',
  texto: '#F4F8FC',
  textoSuave: '#D5DEE8',
  tenue: '#8FA0B3',
  apagado: '#7D8DA1',
  cian: '#45B3C3',
  cianClaro: '#5FCEDE',
  tintaCian: '#04161A',
  exito: '#34D399',
  exitoTexto: '#6EE7B7',
  aviso: '#FBBF24',
  avisoTexto: '#FCD34D',
  peligro: '#F0555B',
  peligroTexto: '#F48084',
  insignia: '#DC2626',
  hero: '#13314A',
  /** Movimiento: los mismos --wx-dur-* del escritorio. */
  dur: { pulsar: 110, estado: 190, hoja: 230, reacomodo: 260 },
} as const;
