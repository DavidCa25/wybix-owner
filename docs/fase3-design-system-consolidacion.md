# Fase 3 · Consolidación técnica del sistema de diseño (informe para Astra)

> Informe técnico, no estético. Las decisiones visuales están marcadas como
> **Decisión de Astra**. Nada se migra hasta tenerlas.
> Estado del repositorio: 2026-10-04, rediseño de POS Mobile de Astra incluido.

## 1. Situación

Hay **dos fuentes de verdad** para los mismos componentes de POS Mobile:

| Fuente | Ubicación | Consumidores |
|---|---|---|
| `@wybix/ui` | `packages/ui/src/index.tsx` | `apps/pos-mobile/app/spike.tsx` (`Boton`, `Tarjeta`, `pos`, `tipo`), que es solo de desarrollo. También `dinero`, reexportado por `components/ui.tsx`. **Owner no lo usa.** |
| Sistema local de Astra | `apps/pos-mobile/components/ui.tsx` | Las 8 pantallas (`_layout`, `index`, `entrar`, `enrolar`, `caja/*`) y `Encabezado`, `Autorizar`, `Escaner`, `Acceso` |

El encabezado de `@wybix/ui` dice que son «piezas compartidas por Owner y POS
Mobile». Hoy no es cierto para ninguno de los dos.

## 2. Inventario de componentes

| Componente | `@wybix/ui` | `components/ui.tsx` (Astra) | Diferencia funcional | Legítima |
|---|---|---|---|---|
| `Boton` | 4 variantes; `cargando` cambia el texto por un spinner; presión con `scale` en el estilo | 4 variantes; `cargando` muestra spinner **y** texto (`textoCargando`); estado accesible `busy`; presión con `Pulse` animado y movimiento reducido | A11y `busy`, texto durante la carga, animación | Sí: Astra es un superconjunto |
| `Teclado` | Teclas de 64 de alto, sin `disabled` | Teclas de 48 o más, prop `disabled` para bloquear durante el proceso, `Pulse` | Bloqueo mientras procesa | Sí |
| `teclear` | Concatena sin límite de decimales | `lib/entrada.ts`: «.» inicial → «0.», máximo 2 decimales, el PIN conserva ceros a la izquierda | **Corrige errores** de captura de dinero | Sí, con prueba en `test/entrada.test.ts` |
| `Tarjeta` | padding 16, radio 14 | padding 24, radio 14 | Solo visual | Visual |
| `Aviso` | Sin rol accesible | `accessibilityLiveRegion` (assertive en peligro), borde izquierdo | **A11y**: lo anuncia el lector de pantalla | Sí |
| `Puntos` | Puntos de 16 | Puntos de 13 y `accessibilityLabel` con el número de dígitos | A11y | Sí |
| `BarraSync` | Borde de color, 1 línea, ancho máximo 360 | Sin borde, fondo hundido, 2 líneas, alto mínimo 48, ancho máximo 300 | Misma regla de color (verde solo si no hay nada pendiente ni en revisión) | Visual, más el objetivo táctil de 48 |
| `useCargando` | Existe | No existe; las pantallas usan `lock` y `busy` propios | Sin consumidores | Se puede retirar |
| `dinero` | Existe | Reexportado | Ninguna | — |
| `Pulse`, `Aparece`, `MotionProvider`, `useReducedMotion` | No existen | Movimiento con controlador nativo, respetan el movimiento reducido | Nuevo | Sí, debe pasar al paquete |
| `Sheet` | No existe | Modal acotado, cuerpo desplazable, `busy` bloquea el cierre | Nuevo | Sí |
| `Pantalla` | No existe | `SafeAreaView` con bordes según el ancho | Nuevo | Sí |
| `Marca` | No existe (solo el token `marca`) | Logotipo de texto «Wybix.» | Nuevo | Visual |
| `Encabezado`, `Acceso`, `Autorizar`, `Escaner`, navegación `caja/_layout` | — | Locales | Dependen de `usePos()`, `@wybix/database` y la cámara | **Deben quedarse en Mobile** |

## 3. Tokens comparados

| Token | `@wybix/ui` | Mobile (Astra) | Owner (`apps/owner/theme/tokens.ts`) | POS Windows (`src/styles/tokens.css`) |
|---|---|---|---|---|
| Tema | claro | claro | **oscuro** | claro y oscuro |
| Navy | `#0F2A3F` | `#102B40` | `#0F1C26` | navy-700 `#0F1826` (escala 900–400) |
| Cian de marca | `#45B3C3` | `#45B3C3` (solo selección) | `#45B3C3` (acción principal) | `#45B3C3` (acción, con tinta `#04161A`) |
| Acción primaria | teal `#1F7A8C` + blanco | teal `#167F92` + blanco (4.68:1) | cian `#45B3C3` | cian `#45B3C3` + tinta oscura (7.5:1) |
| Texto | `#0F2A3F` | `#102B40` | `#E6EEF3` (oscuro) | `#16212E` |
| Texto secundario | `#5B6B78` | `#53697B` (5.27:1) | `#8296A5` | `#55677A` |
| Éxito / aviso / peligro | `#1E8E5A` / `#B26A00` / `#C0392B` | `#167047` / `#865000` / `#B52E29` (oscurecidos por contraste) | `#34D399` / `#FBBF24` / `#F87171` | green-600 / amber-600 / red-600, con tintas `#945A06` y `#B6382F` |
| Tipografía | sistema (sin familia) | **Poppins** 400/600 (alias `Wybix`/`WybixSemi`) | **Poppins** 400–800 | **Geist** y Geist Mono |
| Escala de texto | 14/16/18/24 | 11/13/15/17/26 (+20, 23) | — | 11.5/13/14/16/21/28/40 |
| Radios | 14 | 10 (botón), 12, 14 (tarjeta), 18 (hoja), 999 | 10/14/20/999 | 6/9/13/18 |
| Objetivo táctil | 52 | 48 | — | — |
| Sombras | ninguna | ninguna (decisión de rendimiento) | — | 4 niveles |
| Movimiento | ninguno | presión 100/140, selección 190, entrada 200, hoja 250/180 | — | presión 110, micro 150, estado 190, menú 170, diálogo 230, layout 260 (1 ms con movimiento reducido) |
| Íconos | — | Ionicons | Ionicons (Expo) | Phosphor |

**Hallazgo técnico:** no hay ningún valor compartido entre los tres productos
salvo el cian `#45B3C3`. La documentación del rediseño dice que la
«tipografía es compatible con el POS de escritorio», pero el POS de escritorio
usa Geist y no Poppins.

## 4. Propuesta técnica

1. **`@wybix/ui` es la única fuente.** El paquete compartido ya existe y POS
   Mobile ya lo declara como dependencia (Owner todavía no). Absorbe las implementaciones de
   Astra, que son el superconjunto funcional: `Boton`, `Teclado`, `teclear`,
   `Aviso`, `Puntos`, `BarraSync`, `Tarjeta`, `Sheet`, `Pantalla`, `Pulse`,
   `Aparece`, `MotionProvider`/`useReducedMotion`, `Marca` y `dinero`.
   `components/ui.tsx` desaparece. Si conviene una transición, queda dos
   semanas como reexportación.
2. **Tokens en dos capas:**
   - `marca`: constantes de Wybix iguales en todos los productos;
   - `tema`: superficie, texto, estados, radios y escala, uno por superficie
     (`posClaro`, y `ownerOscuro` cuando Owner migre).

   Los componentes leen el tema, no colores literales.
3. **La tipografía va como token**, sin alias propios de una app. `@wybix/ui`
   expone `fuentes.{regular, semibold}` y cada app registra esos nombres en
   `useFonts`. Hoy `WybixSemi` solo existe en el `_layout` de Mobile.
4. **Se quedan en Mobile:** `Encabezado`, `Acceso`, `Autorizar`, `Escaner` y la
   navegación. Son composición sobre `usePos()`, no primitivas.
5. **Se retira:** `useCargando`, que no tiene consumidores.
6. **Owner no se migra en esta etapa.** Tiene tema oscuro propio y ningún
   componente compartido. Migrarlo es otro proyecto y lo decide producto.

## 5. API pública que se conserva

Las firmas actuales de Astra se conservan tal cual, para que las pantallas
solo cambien el `import`:

- `Boton({ titulo, onPress, variante, deshabilitado, cargando, textoCargando, estilo, testID, accessibilityLabel })`
- `Teclado({ alPulsar, extra, disabled })`
- `Sheet({ visible, onClose, title, subtitle, children, footer, busy, maxWidth })`
- `BarraSync({ texto, pendientes, enLinea, revocado, enRevision, onPress })`

`pos` y `tipo` se mantienen como nombres de exportación.

## 6. Migración por grupos

Después de cada grupo: `npm run typecheck`, `npm test` (raíz y `apps/pos-mobile`),
build release x86_64, y capturas en el emulador de las pantallas afectadas a
2560×1600, 720×1280 y texto al 150 %.

1. Tokens, `dinero` y `teclear`, con prueba de `teclear` movida al paquete.
2. `Boton`, `Teclado`, `Puntos`, `Aviso`, `Tarjeta` y `BarraSync`.
3. `MotionProvider`, `Pulse`, `Aparece`, `Sheet`, `Pantalla` y `Marca`.
4. Borrar `components/ui.tsx` y actualizar `spike.tsx`.

## 7. Riesgos

- **Regresión visual sin pruebas de render.** El repositorio no tiene
  pruebas de componentes de React Native. Mitigación: capturas antes/después
  por grupo, y que todo lo funcional (bloqueos, `busy`, movimiento reducido,
  48 dp) quede en las firmas.
- **Fuentes:** si el paquete referencia `WybixSemi` y una app no lo registra,
  React Native usa la fuente del sistema sin avisar.
- **Owner** no debe arrastrar dependencias de Mobile (`react-native-safe-area-context`
  ya lo tiene Owner; `Animated` es de RN). Sin nuevas dependencias.

## 8. Decisiones de Astra (abiertas)

1. **Navy oficial:** `#0F2A3F`, `#102B40`, `#0F1C26` (Owner) o la escala de Windows (`#0F1826`).
2. **Color de la acción primaria en tema claro:** teal oscuro con texto blanco
   (Mobile hoy) o cian de marca con tinta oscura (Windows hoy).
3. **Colores de estado** en tema claro: los oscurecidos de Mobile o las tintas de Windows.
4. **Tipografía:** Poppins (Owner y Mobile) o Geist (Windows). ¿Una sola
   familia para todos los productos o una por plataforma?
5. **Escala de radios** común (Mobile 10/12/14/18 frente a Windows 6/9/13/18).
6. **Objetivo táctil mínimo:** 48 (Mobile) o 52 (paquete anterior).
7. **Duraciones de movimiento:** unificar con las de Windows (110/150/190/230) o
   mantener las de Mobile.
8. **Íconos:** Ionicons (Mobile y Owner) frente a Phosphor (Windows).

Con las respuestas, la consolidación técnica queda a cargo del agente implementador y no cambia
el diseño aprobado del rediseño, salvo en lo que estas decisiones indiquen.

## 9. Contratos del cierre operativo

`accessibilityLabel` es opcional y permite distinguir el botón de reimpresión por folio sin alterar su texto visual. Conservar bloqueo durante autorización/consumo remoto y callback estable; el movimiento no debe reabrir una operación ya consumida. El estado pendiente/fallido de impresión y la revisión de sincronización necesitan anuncios accesibles. Cualquier consolidación debe preservar estos contratos, navegación, foco de modales y movimiento reducido. No se decidió aquí tipografía, paleta ni composición final.
