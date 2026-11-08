/**
 * MARCA DEL NEGOCIO (logo y color) para Wybix POS Mobile.
 *
 * La dueña elige UN color en Wybix Owner; la tablet lo recibe con el snapshot
 * del evento. Aquí se decide cómo se usa sin que nada quede ilegible, igual
 * que el ThemeService del POS de escritorio: el texto sobre el color se
 * calcula por contraste y, si el color es muy claro para escribir sobre
 * blanco, se oscurece solo para el texto. El resto de la interfaz (barra,
 * superficies, avisos) sigue siendo de Wybix: la marca acentúa, no repinta.
 *
 * Puro: sin React Native, se prueba en Node.
 */

export const COLOR_WYBIX = '#167F92';
/** Logo: imagen pequeña embebida (viaja con el snapshot y funciona sin Internet). */
export const LOGO_MAX_CARACTERES = 300_000;
const LOGO = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export interface Marca { color: string | null; logo: string | null }

export interface TemaMarca {
  /** Fondo de botones principales y elementos elegidos. */
  acento: string;
  /** Texto sobre `acento` (blanco o tinta oscura, el que se lea). */
  acentoTexto: string;
  /** El acento para TEXTO sobre fondo blanco (≥ 4.5:1). */
  acentoTinta: string;
  /** Fondo suave de una opción elegida, con texto oscuro encima. */
  seleccion: string;
}

const TINTA = '#04161A';
const TEXTO_OSCURO = '#102B40';

export function normalizarColor(c: string | null | undefined): string | null {
  const s = (c ?? '').trim();
  const m = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.exec(s);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
  return '#' + h.toUpperCase();
}

export function logoValido(logo: string | null | undefined): boolean {
  return !!logo && logo.length <= LOGO_MAX_CARACTERES && LOGO.test(logo);
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c: number[]) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Luminancia relativa (WCAG 2.1). */
export function luminancia(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Mezcla `color` con `con` (0 = color, 1 = con). */
export function mezclar(color: string, con: string, t: number): string {
  const a = rgb(color), b = rgb(con);
  return hex(a.map((v, i) => v + (b[i] - v) * t));
}

export function temaDeMarca(color: string | null | undefined): TemaMarca {
  const base = normalizarColor(color) ?? COLOR_WYBIX;
  // Colores medios (rosa, naranja) no llegan a 4.5:1 ni con blanco ni con
  // tinta: el botón se oscurece lo mínimo para que el blanco se lea.
  let acento = base;
  for (let t = 0.03; Math.max(contraste(acento, '#FFFFFF'), contraste(acento, TINTA)) < 4.5 && t <= 1; t += 0.03) acento = mezclar(base, '#000000', t);
  const acentoTexto = contraste(acento, '#FFFFFF') >= contraste(acento, TINTA) ? '#FFFFFF' : TINTA;
  let acentoTinta = base;
  for (let t = 0.05; contraste(acentoTinta, '#FFFFFF') < 4.5 && t <= 1; t += 0.05) acentoTinta = mezclar(base, '#000000', t);
  let seleccion = mezclar(base, '#FFFFFF', 0.55);
  for (let t = 0.6; contraste(seleccion, TEXTO_OSCURO) < 4.5 && t <= 1; t += 0.05) seleccion = mezclar(base, '#FFFFFF', t);
  return { acento, acentoTexto, acentoTinta, seleccion };
}
