# Rediseño de Wybix POS Mobile

Implementado el 4 de octubre de 2026 en `apps/pos-mobile`, siguiendo la tarjeta D aprobada y los flujos reales existentes.

## Diseño y adaptación

- Estructura navy, superficies claras, selección cian y tipografía Poppins ya disponible en el proyecto. Solo se empaquetan Regular y Semibold, con cifras tabulares.
- Cuatro destinos reales: Vender, Turno y corte, Inventario y Estado. Rail desde 1000 dp; navegación inferior en tamaños menores o texto ampliado.
- Tarjeta D sin fotografías: nombre, separación tipo ticket, precio y existencias. Selección con contorno/check/cantidad. El umbral visual de existencias bajas es de 1 a 5 unidades; no impide vender con existencias negativas ni altera las reglas de inventario.
- Catálogo y cuenta simultáneos desde 850 dp. En pantallas pequeñas, total y Cobrar permanecen anclados; tocar Cuenta abre las mismas cantidades editables en un diálogo.
- Cobro con importes y teclado en dos columnas en tablets amplias. Cuerpo desplazable en tamaños compactos, texto ampliado o contenido largo; encabezado y acciones permanecen fuera del desplazamiento. Métodos y montos rápidos se reacomodan con su ancho mínimo.
- Turno organiza resumen, desglose y operación. Conserva el corte a ciegas y los permisos del evento. Inventario separa recepciones y existencias; mantiene recepción, QR, merma, ajuste y retorno.
- Estado distingue pendientes, revisión y tickets sin imprimir. Un fallo de prueba de impresión usa aviso de error; configurar una impresora no se presenta como conexión verificada.
- Enrolamiento, acceso, autorización y escáner comparten el diseño y las áreas seguras. El acceso compacto desplaza al PIN seleccionado.

## Movimiento y peso

`Animated` de React Native, con controlador nativo de opacidad y transformación. Presión 100/140 ms; selección 190 ms; entrada de una línea nueva 200 ms; diálogo 250/180 ms. Se respeta `AccessibilityInfo.reduceMotionChanged`. No se anima el catálogo completo ni las cantidades/total en cada actualización. Sin dependencias nuevas de movimiento, imágenes decorativas, sombras costosas, desenfoques ni animaciones continuas.

Los componentes son locales a POS Mobile: `components/ui.tsx`, `Acceso.tsx` y `Encabezado.tsx`. No se modificó `packages/ui`, Owner, el POS de escritorio ni la landing para este rediseño.

## Interacción y accesibilidad

Roles y estados accesibles en navegación, productos, métodos, personal, modificadores, factura y acciones. Controles de al menos 48 dp; nombres/precios completos en las etiquetas accesibles de productos. Avisos persistentes con región viva, PIN enmascarado y estados de ocupado/deshabilitado. Las acciones de venta, caja, enrolamiento, acceso, autorización y movimientos de inventario bloquean repeticiones mientras procesan.

Se conserva la transacción local de venta y la impresión posterior. La cuenta se limpia solo después de registrar la venta. Si el guardado falla, se conserva para volver a intentar. El teclado monetario normaliza el decimal inicial a `0.` y admite dos cifras de centavos; los PIN conservan ceros iniciales.

Contraste calculado para texto normal: texto/fondo 13.42:1; texto secundario/fondo 5.27:1; blanco/acento 4.68:1; navy/cian 5.89:1; avisos de éxito 5.38:1, advertencia 6.05:1 y error 5.40:1. Los estados también usan texto y marcas, además del color.

## Verificación

- `npm run typecheck` en POS Mobile: aprobado.
- `npm test` en el monorepo: 53/53 pruebas aprobadas de dominio, base local, PIN, permisos, transacciones, QR y sincronización.
- `npm test` en POS Mobile: 3/3 aprobadas (ESC/POS y edición de efectivo/PIN).
- El código incluido en el bundle se comparó con las 24 fuentes locales de app/componentes/lib: coincidencia tras normalizar saltos de línea.
- Compilación Android release para x86_64: aprobada, con Expo SDK 54. El perfil usado en el emulador es desarrollo, con backend local `http://10.0.2.2:54321`; no se publicó ni desplegó.
- Android tablet 2560 × 1600 / 320 dpi: acceso por PIN, navegación, selección de productos, cantidades, métodos de cobro, turno, existencias, estado y formulario de enrolamiento.
- Android compacto 720 × 1280 / 320 dpi: acceso con desplazamiento al PIN, venta con dos columnas, cuenta editable y cobro con acciones alcanzables.
- Texto al 150 % y escala de transición en 0: acceso y navegación operativos, catálogo en una columna y controles principales alcanzables mediante desplazamiento.
- Venta real sobre los datos locales de prueba: $57 cobrados con $100, cambio $43, cuenta vaciada y operación pendiente sin red. Fallo de impresión mostrado como aviso; venta conservada. Las existencias negativas de esta evidencia pertenecen al escenario de prueba y siguen permitidas por el dominio.

Las capturas están en `evidencia/`. Cámara/lectura de QR con un dispositivo físico, impresora física, iOS y rendimiento bajo carga en hardware de feria no se validaron en esta sesión. No se hizo un nuevo enrolamiento contra la nube ni se modificaron datos de producción. La prueba de integración del dominio cubre recepción, merma, corte, permisos y persistencia; no se vuelve a afirmar una prueba manual completa de cada operación desde la interfaz.
