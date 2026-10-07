# Concepto de rediseño integral · Wybix POS Mobile

Estado: rediseño implementado el 4 de octubre de 2026. Ver [implementación y verificación](IMPLEMENTACION.md). La dirección visual fue aprobada por el usuario. Tarjeta de producto elegida: **D, compacta tipo ticket**. Referencia inicial: tablet horizontal de feria. Las imágenes son conceptos generados con ImageGen, no especificaciones finales ni pantallas ejecutables.

## Láminas

1. `01-venta-cobro.png` — venta y diálogo de cobro.
2. `02-turno-inventario-estado.png` — los otros tres destinos operativos.
3. `03-tarjetas-sin-fotos.png` — cuatro alternativas de tarjeta con estados.
4. `04-enrolamiento-acceso.png` — enrolamiento y selección de persona/PIN.

## Dirección propuesta

- **Identidad:** estructura navy, espacio de trabajo claro y cian Wybix para acción/selección. El tema claro conserva legibilidad exterior. Tipografía de interfaz compatible visualmente con el POS de escritorio; cifras tabulares.
- **Navegación:** cuatro destinos reales de la app (Vender, Turno y corte, Inventario, Estado) con una selección inequívoca tipo pill. La barra/rail debe adaptarse al tamaño del dispositivo y respetar áreas seguras.
- **Producto sin imagen:** la tarjeta D, compacta tipo ticket, es la base aprobada. Nombre con peso, línea divisoria, precio tabular y existencias en una estructura reconocible. El estado seleccionado añade contorno cian y marca visible; existencias bajas usan un indicador ámbar discreto. El estado agotado debe seguir siendo legible. Mantener suficiente densidad para operar el catálogo.
- **Venta:** catálogo y cuenta visibles a la vez donde el ancho lo permita. Total y Cobrar anclados en la cuenta. La selección de producto usa respuesta inmediata y discreta.
- **Cobro:** total, método, recibido/cambio y confirmación ordenados por importancia. La composición se adapta a pantallas bajas y texto ampliado. Confirmar muestra progreso hasta concluir y evita repetición accidental.
- **Turno e inventario:** priorizar operación y cifras actuales; usar filas y grupos de información, no una pila de tarjetas equivalentes.
- **Estado:** diferenciar guardado local, sincronización, revisión y resultado de impresión con texto y color semántico.
- **Entrada:** enrolamiento, selección de persona y PIN pertenecen a la misma familia visual, con objetivos táctiles amplios y errores claros.
- **Movimiento:** respuesta corta a selección, agregado a cuenta y confirmación. Sin animación ambiental en las pantallas de operación.

## Alcance y cautelas de las imágenes

Los nombres, fechas, importes, cantidades, SKU, categorías, iconos y eventos visibles son datos ilustrativos generados. La segunda lámina introduce rótulos de navegación que no coinciden con los cuatro destinos actuales; no se proponen rutas nuevas. La cuarta lámina ilustra una opción «¿Olvidaste tu PIN?» y pasos de enrolamiento que tampoco se autorizan como funciones nuevas. Antes de programar, la implementación debe conservar los flujos y estados reales del repositorio, salvo decisión explícita de producto.

Las láminas muestran composición y estilo. No validan contraste final, accesibilidad, longitud real del catálogo ni adaptación a teléfono. Las medidas, los estados y el movimiento se concretaron en la implementación; la evidencia de Android y los límites de verificación se documentan en `IMPLEMENTACION.md`.

## Prompts de origen

Las cuatro láminas se generaron con ImageGen integrado, modo `ui-mockup`, usando la captura de cobro de `docs/evidencia/fase2/10-cobro-efectivo.png` y la captura del POS de escritorio `C:/Users/Casillas/filtros_lubs_rios/tmp/touch-turno.png` como referencias visuales iniciales. Los prompts pidieron: tema claro de alto contraste, estructura navy, cian de marca, tipografía precisa, números tabulares, controles táctiles y tarjetas sin fotos; evitar degradados, brillo, vidrio, ilustraciones, decoraciones y dispositivos 3D. Las láminas posteriores pidieron coherencia con la primera y cubren los destinos restantes, variantes de tarjeta y acceso.
