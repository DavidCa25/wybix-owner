/**
 * Tokens de Wybix Owner: los MISMOS del POS de escritorio en su tema oscuro
 * (filtros_lubs_rios/src/styles/tokens.css), compartidos con POS Mobile en
 * @wybix/ui · wx. Una tarjeta, un borde o un elegido se ven igual en las tres
 * apps. Letra Geist; montos en Geist Mono, como la caja.
 *
 * Los nombres de siempre (navy, card, line…) se conservan para no tocar cada
 * pantalla: cambian sus valores.
 */
import { wx } from '@wybix/ui';

export const colors = {
  // Riel y lienzo del escritorio
  navy:      wx.riel,
  navyDeep:  wx.lienzo,
  navySoft:  wx.superficie,

  // Cian de Wybix
  sky:       wx.cianClaro,
  skyLight:  wx.cianClaro,
  skySoft:   'rgba(69,179,195,0.14)',

  // Acción principal = cian de marca, con tinta oscura encima (como la caja)
  primary:   wx.cian,
  primaryDark: '#2A8494',
  onPrimary: wx.tintaCian,

  // Neutros (tema oscuro del escritorio)
  ink:       wx.texto,
  muted:     wx.tenue,
  line:      wx.borde,
  lineStrong: wx.bordeFuerte,
  bg:        wx.lienzo,
  card:      wx.superficie,
  raised:    wx.elevado,
  selected:  wx.elegido,
  hero:      wx.hero,

  // Estados (como texto o punto sobre oscuro)
  success:   wx.exito,
  warning:   wx.aviso,
  danger:    wx.peligroTexto,
  dangerStrong: '#B6382F',
  badge:     wx.insignia,
  white:     '#FFFFFF'
};

// Geist (se carga con expo-font en el layout), igual que la caja y POS Mobile
export const fonts = {
  regular:  'Geist_400Regular',
  medium:   'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  bold:     'Geist_700Bold',
  black:    'Geist_800ExtraBold',
  /** Montos, folios y códigos. */
  mono:     'GeistMono_600SemiBold'
};

export const radius = {
  sm: 12,
  md: 16,
  lg: 22,
  pill: 999
};

export const spacing = {
  xs: 6, sm: 10, md: 16, lg: 24, xl: 32
};

/** Movimiento: los --wx-dur-* del escritorio. */
export const dur = wx.dur;
