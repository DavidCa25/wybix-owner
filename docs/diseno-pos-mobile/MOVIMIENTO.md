# Movimiento propuesto · Wybix POS Mobile

Dirección aprobada: tarjeta D tipo ticket. El movimiento debe explicar selección, cambio de estado y resultado de una operación. La interfaz de caja debe responder de inmediato y quedar estable.

| Pieza de diseño | Movimiento y estado | Duración objetivo | Implementación prevista |
| --- | --- | ---: | --- |
| `ProductTicket` | Al tocar: ligera compresión y retorno; al seleccionarse: contorno cian y marca. El ticket se agrega a la cuenta sin animar toda la retícula. | 90–140 ms presión; 160–220 ms selección | `Pressable` + `Animated` nativo para escala/opacidad. |
| `NavPill` | Fondo/indicador pasa al destino activo; icono y etiqueta conservan posición legible. | 180–240 ms | `Animated` nativo; sin transición de pantalla completa. |
| `CartLine` | Nueva línea aparece con 6–10 dp de desplazamiento y opacidad; si ya existe, solo responde la cantidad. El total actualiza su valor sin contar cada centavo. | 180–240 ms | `Animated` nativo; animación local de la línea. |
| `PaymentSegment` | Cambia el indicador y el estado del método. El contenido del método cambia con una transición breve y el total no se mueve. | 150–220 ms | `Animated` nativo; `LayoutAnimation` únicamente si la redistribución concreta se valida en Android. |
| `CheckoutSheet` | Entra y sale de forma contenida; confirmación visible durante procesamiento. Éxito: folio y cambio estáticos, con aparición breve. | 220–300 ms entrada; 160–220 ms salida | Modal nativo + `Animated`; progreso con `ActivityIndicator` existente. |
| `SyncStatus` | Cambio semántico corto al pasar de pendiente a sincronizado o revisión. Sin pulso permanente. | 180–240 ms | Opacidad/color de estado; no animar toda la cabecera. |
| `InlineNotice` | Error o confirmación aparece cerca de la operación y permanece legible hasta que se resuelva o descarte. | 150–220 ms | Opacidad + 6 dp; no toast efímero para información crítica. |

## Reglas del sistema

- Una acción frecuente (teclado PIN, teclado de cobro, `+`/`−`) responde sin espera; solo presión táctil y cambio de valor. No escalonar cada tecla.
- Animar transformaciones y opacidad cuando se pueda usar el controlador nativo. Evitar animaciones de sombra, blur, gradientes, altura de cada tarjeta o desplazamiento de toda la lista.
- No animar cientos de tickets dentro de `FlatList`. La respuesta se limita a la tarjeta tocada y a la línea afectada de la cuenta.
- Sin bucles de atención, confeti, rebotes grandes, haptics en cada tecla ni animaciones narrativas en la caja.
- Respetar la preferencia de reducir movimiento: mostrar directamente el estado final y mantener texto, foco y resultado claros.
- El estado de guardado de venta es real: bloquear confirmaciones repetidas y comunicar procesamiento, éxito o error. La animación nunca sustituye esa lógica.

## Dependencias

Primera implementación prevista: `Animated`, `Pressable`, `Modal` y `ActivityIndicator` de React Native, ya disponibles; no requiere añadir React Bits. `expo-haptics` sería la única dependencia opcional, para una señal suave al confirmar una operación importante, sujeta a prueba en tablet real. Reanimated solo se justificaría si después se aprueba un gesto complejo o una transición interactiva imposible de resolver con las API nativas.

Referencias técnicas: React Native 0.81 `Animated` y `AccessibilityInfo`; Expo SDK 54 `expo-haptics`. Verificar tiempos y FPS en el dispositivo objetivo antes de congelar valores.
