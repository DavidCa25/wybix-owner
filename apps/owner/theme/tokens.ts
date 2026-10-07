export const colors = {
  // Azul marino de la marca (encabezados, splash) — mismo tono oscuro que la landing
  navy:      '#0F1C26',
  navyDeep:  '#0B131A',   // fondo más oscuro (brand.dark de la landing)
  navySoft:  '#16202A',

  // Celeste/cian de acento (igual que la landing: brand.cyan)
  sky:       '#45B3C3',
  skyLight:  '#5EC6D6',
  skySoft:   'rgba(69,179,195,0.14)',   // chip cian tenue sobre fondo oscuro

  // Acción principal = cian de marca
  primary:   '#45B3C3',
  primaryDark:'#359AA9',

  // Neutros (tema OSCURO)
  ink:       '#E6EEF3',   // texto principal (claro)
  muted:     '#8296A5',   // texto secundario
  line:      '#213240',   // bordes / divisores
  bg:        '#0B131A',   // fondo de pantalla
  card:      '#16202A',   // superficie de tarjeta (brand.card)

  // Estados (brillantes para que resalten sobre oscuro)
  success:   '#34D399',
  warning:   '#FBBF24',
  danger:    '#F87171',
  white:     '#FFFFFF'
};

// Familia Poppins (se carga con expo-font en el layout)
export const fonts = {
  regular:  'Poppins_400Regular',
  medium:   'Poppins_500Medium',
  semibold: 'Poppins_600SemiBold',
  bold:     'Poppins_700Bold',
  black:    'Poppins_800ExtraBold'
};

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  pill: 999
};

export const spacing = {
  xs: 6, sm: 10, md: 16, lg: 24, xl: 32
};
