# Auditoría · Wybix POS Mobile y Wybix Owner

Fecha: 2026-11-24 · Repositorio: `wybix-owner` (monorepo Expo 54) y `filtros_lubs_rios` (POS de escritorio)

## Las dos preguntas

### ¿Hacen falta dos apps?

**Sí, conviene que sigan siendo dos apps.** El código ya se comparte en el monorepo (`packages/domain`, `database`, `sync`, `ui`, `api`, `auth`), así que el costo de tener dos apps es bajo. Separarlas protege tres cosas:

| | POS Mobile | Owner |
|---|---|---|
| Quién la usa | El cajero, en un equipo compartido | El dueño o el encargado, en su teléfono |
| Credencial | La del **equipo** (`devices`, se da de baja desde Owner) y un PIN por persona | Una **cuenta personal** con MFA (AAL2) |
| Sin Internet | Vende con SQLite cifrado y outbox | Solo consulta la nube |
| Permisos del sistema | Cámara, Bluetooth para impresora, tarea en segundo plano | Notificaciones push |

Si fueran una sola app, la sesión del dueño (con MFA, que aprueba retiros y ve todas las sucursales) viviría en la tablet de la caja. Además, la tablet necesitaría un modo kiosco que no se puede mezclar con la cuenta personal. Lo que **sí** conviene unificar:
- el sistema de diseño (`packages/ui` frente a `apps/pos-mobile/components/ui.tsx`: dos fuentes, ver `fase3-design-system-consolidacion.md`);
- el acceso: desde POS Mobile, un encargado ya aprueba con Owner a distancia. Falta poder **abrir Owner desde la tablet** con un enlace profundo, no instalar todo en un solo binario.

### ¿Hace falta registrar un evento para que funcione POS Mobile?

**Hoy sí, y es el principal freno.** `aplicarSnapshot` rechaza todo lo que no es evento:

```ts
if (s.location.tipo !== 'EVENT') throw new ErrorPos('NO_EVENT', 'Wybix POS Mobile solo opera ubicaciones de tipo evento.');
```

Todo el modelo está hecho para la feria: inventario propio del evento, transferencias desde la sucursal base, conciliación al cerrar. Para usar la tablet **dentro del local**, como segunda caja, para cobrar en fila o en el piso de venta, hay que inventar un evento, y el inventario del evento queda separado del de la tienda. Por eso la tablet no se siente como el POS.

**Propuesta: dos modos de operación con la misma app.**

1. **Caja de sucursal (nuevo, por red local).** La tablet se empareja con el **Local Host** de la computadora principal (`electron/local-host`, puerto 7427, que ya sirve Mesero, Inventario, Preparación y Mi jornada). La venta se registra con `sp_register_sale` en la misma base de SQL Server: mismo inventario, mismas promociones, clientes, crédito, folios y corte. No hace falta evento ni nube. Si se cae la red local, la tablet guarda la venta en su outbox y la entrega al volver; es idempotente por `event_uuid`, igual que hoy con la nube.
2. **Evento (lo de hoy, por la nube).** Para la feria o el punto de venta temporal, sin computadora principal cerca. Se conserva tal cual.

El modo sale del emparejamiento: un QR de Local Host da «caja de sucursal» y un código de Owner da «evento». La pantalla Vender es la misma.

## Por qué tarda en sincronizar

Mediciones en el código (`packages/sync/src/motor.ts`, `apps/pos-mobile/lib/contexto.tsx`, `mobile_snapshot`):

| # | Hallazgo | Efecto |
|---|---|---|
| S1 | Cada ciclo hace **3 o 4 viajes en serie**: `events`, `mobile_inbox`, `mobile_snapshot` y `mobile_heartbeat` | Con red móvil, cada viaje son 300–800 ms más el arranque en frío de la Edge Function |
| S2 | **El snapshot manda el catálogo completo siempre.** El cliente envía `catalog_version`, pero `pos-sync` no se lo pasa a `mobile_snapshot`, y la función devuelve `v_cat.payload` entero sin compararlo. El personal y las llaves también viajan siempre | Con 500 productos y modificadores, unos cientos de KB por ciclo |
| S3 | Cada venta dispara un ciclo completo un segundo después (`aviso` con antirrebote), **incluido el snapshot** | Tras cada cobro se vuelve a bajar el catálogo |
| S4 | Además corre cada minuto con la app al frente | Consumo de datos y batería sin cambios que bajar |
| S5 | `aplicarSnapshot` borra y reinserta `products` y `staff` aunque no hayan cambiado (el personal entra con `>=`, no con `>`) | Escrituras en SQLite cifrado en cada ciclo |
| S6 | No hay aviso de la nube a la tablet (sondeo de 60 s) | Un precio cambiado en el escritorio tarda hasta un minuto más un ciclo |
| S7 | No hay métricas: el latido no reporta cuánto duró el ciclo ni cuántos bytes bajó | No se puede ver dónde se va el tiempo |

### Cambios de sincronización (en orden de impacto)

1. **Snapshot condicional.** `pos-sync` pasa `catalog_version`, `security_revision` y `snapshot_version` a `mobile_snapshot`. La función devuelve `catalog: null` y `staff: null` cuando la tablet ya los tiene, más un campo `sin_cambios: true`. `aplicarSnapshot` deja de borrar lo que no cambió. *Resuelve S2 y S5.*
2. **Vía rápida tras vender.** Después de una venta solo se suben los eventos. La respuesta de `events` trae las versiones vigentes (`catalog_version`, `security_revision`, `inbox_cursor`) y solo se pide el snapshot o el inbox si alguna cambió. *Resuelve S3.*
3. **Un solo viaje: acción `sync`.** Sube eventos, devuelve los resultados, el inbox desde el cursor y el snapshot, si hace falta, en una sola respuesta. El latido va dentro. *Resuelve S1: de 4 viajes a 1.*
4. **Aviso en vivo.** Supabase Realtime (canal por `location_id`) avisa «hay catálogo nuevo» o «hay inbox», y la tablet sincroniza en ese momento. El sondeo se queda como respaldo cada 5 minutos. *Resuelve S4 y S6.*
5. **Catálogo por diferencias.** `catalog_publications` guarda, además del total, los cambios por producto entre versiones. La tablet pide `desde=v` y recibe solo lo que cambió. Se vuelve al catálogo completo si la diferencia es grande o la tablet viene de muy atrás.
6. **Métricas en el latido:** duración de cada fase, bytes y pendientes. Owner las muestra en Eventos → Tablets. *Resuelve S7.*

En modo **caja de sucursal** la mayor parte de esto no aplica. La red local responde en milisegundos y la venta queda en SQL Server al momento; no hay sincronización que esperar.

## Lo que el POS de escritorio hace y la tablet no

Contrastado con `packages/database/src/pos.ts` (`abrirTurno`, `registrarVenta`, `registrarMerma`, `registrarAjuste`, `movimientoCaja`, `cerrarTurno`, transferencias, reimpresión) y con `ProductoCat`:

| Función | Escritorio | Mobile hoy | Propuesta |
|---|---|---|---|
| Escanear código de barras para vender | Sí | **No** (el escáner solo se usa para QR; `ProductoCat` no trae `bar_code`) | Código en el catálogo y escaneo con cámara o lector Bluetooth en Vender |
| Presentaciones y paquetes (0089), venta suelta (0073) | Sí | No | Mismas tarjetas «Suelto · Paquete» que en Touch |
| Cliente en la venta, crédito, puntos y club | Sí | No | Hoja «Cliente» en la cuenta |
| Cancelar o devolver una venta | Sí | **No** | Historial → venta → devolver (con PIN o aprobación) |
| Historial de ventas del turno y reimpresión | Sí | Solo tickets sin imprimir | Pantalla Ventas |
| Descuento manual por línea o cuenta | Sí, con permiso | No | Con PIN de encargado o aprobación de Owner |
| Pago dividido | Sí | No | Varias formas de pago en Cobro |
| Cuentas abiertas o mesas (Hospitality) | Sí | No | Solo en caja de sucursal (Local Host ya tiene Mesero) |
| Recibir compra o pedido sugerido | Sí | No | Solo en caja de sucursal |
| Conteo de inventario | Sí | Ajuste suelto | Conteo guiado con escáner |
| Pedir factura del ticket | Sí | No | QR de autofactura en el ticket (la nube ya tiene `fiscal-*`) |

## Mejores prácticas que faltan

- **Una sola fuente del sistema de diseño:** cerrar el pendiente de `fase3-design-system-consolidacion.md` antes de agregar pantallas, para no duplicar componentes. Es la misma regla de `wx-*` del escritorio.
- **Pantallas grandes en archivos chicos:** `vender.tsx` tiene 1,291 líneas. Separar Catálogo, Cuenta, Cobro y Opciones en componentes y la lógica en hooks (`useCuenta`, `useCobro`). Se prueba mejor y se reusa en el modo caja de sucursal.
- **Listas virtualizadas** con `FlashList` para catálogos de cientos de productos, e índice de búsqueda sin acentos, el mismo de `catalog.service` del escritorio.
- **Contratos versionados** del snapshot y de los eventos en `packages/domain`, con pruebas de compatibilidad tablet vieja ↔ nube nueva. Hoy se resuelve con `UPDATE_REQUIRED` caso por caso.
- **Telemetría de sincronización** (punto 6) y un panel en Owner.
- **E2E de la tablet:** hoy hay pruebas de Node y SQL. Falta un recorrido con Maestro o Detox: vender, cobrar, quedarse sin red y sincronizar.

## Pantallas nuevas (propuesta, ver Claude Design)

POS Mobile:
1. **Emparejar:** elegir «Caja de sucursal» (QR de Local Host) o «Evento» (código de Owner).
2. **Vender con escáner:** barra de búsqueda y escaneo, tarjetas de paquete y suelto, cliente en la cuenta.
3. **Cobro dividido:** varias formas de pago, recibido y cambio.
4. **Ventas del turno:** historial, reimprimir, devolver y facturar.
5. **Estado de sincronización:** qué falta subir, qué bajó, cuánto tardó y la conexión con la nube o con Local Host.

Owner:
6. **Tablets en vivo:** cada tablet con su modo, sus pendientes, su último ciclo y su versión, y la acción de dar de baja.

## Orden sugerido

1. **Sincronización** (snapshot condicional y vía rápida): poco código y el efecto se nota el mismo día.
2. **Escáner, paquetes y cliente** en Vender: es lo que más pide la operación diaria.
3. **Ventas del turno con devolución.**
4. **Modo caja de sucursal por Local Host:** el cambio grande de arquitectura. Necesita una superficie nueva `caja` en `electron/local-host/superficies` y un emparejamiento.
5. **Aviso en vivo, catálogo por diferencias y Tablets en vivo** en Owner.

---

# Parte 2 · Qué más le falta a POS Mobile

Se revisaron los 30 destinos del POS de escritorio (`src/app/app.routes.ts`), sus 10 módulos de pago (`src/core/modulos.ts`), las superficies que ya sirve Local Host (`electron/local-host/superficies`: mesero, preparación, inventario, jornada, técnico, pedidos del día, cliente) y lo que ofrecen los POS móviles del mercado.

## 1. Lo que ya existe en el escritorio y no llega a la tablet

Cada fila dice en qué modo de la tablet tiene sentido: **S** = caja de sucursal (Local Host) y **E** = evento (nube).

### Caja diaria (lo primero)

| Función | Escritorio | Modo | Qué se hace en la tablet |
|---|---|---|---|
| Escanear para vender | Venta, Touch | S, E | Cámara con lectura continua y lector Bluetooth (teclado HID). Suena y vibra al leer |
| Presentaciones, paquetes y venta suelta (0073, 0089) | Venta, Touch | S, E | Tarjetas «Suelto · Paquete» y paquetes de menor a mayor, como en Touch |
| Clientes, crédito y abonos | Clientes, Venta | S | Buscar o dar de alta un cliente, vender a crédito y cobrar un abono |
| Puntos y Club (cartera) | Fidelización | S, E | Escanear el pase del cliente (ya existe `club:wallet-resolver`) y acumular o canjear |
| Lista de precios por cliente (mayoreo) | Venta | S | Se cambia la lista al asignar el cliente |
| Descuento manual | Venta, con permiso | S, E | Con PIN de encargado o aprobación de Owner (las aprobaciones ya existen) |
| Pago dividido | Venta | S, E | Varias formas de pago en un cobro |
| Devolución o cancelación | tablaVenta | S, E | Desde Ventas del turno |
| Propinas | Propinas (módulo) | S, E | Pregunta de propina al cobrar con tarjeta y reparto en el corte |
| Factura | Facturación | S, E | QR de autofactura en el ticket. En sucursal, también facturar desde la tablet |
| Pago de servicios | Pago de servicios (módulo) | S | Recargas y servicios cobrados en la misma cuenta |

### Por giro (cuando el negocio tiene el módulo)

| Giro o módulo | Escritorio | Qué se hace en la tablet |
|---|---|---|
| Mesas y comandas | Mesas, Touch/mesas, Cocina | **Modo mesero en el teléfono:** tomar la orden en la mesa, mandarla a cocina, dividir la cuenta y cobrar en la mesa. Local Host ya tiene la superficie Mesero; falta llevarla a la app nativa (sin navegador, con impresora Bluetooth y sin red estable) |
| Pedidos en línea | Pedidos en línea | Aviso push en la tablet cuando llega un pedido, aceptarlo y marcarlo listo |
| Servicios y agenda | Agenda, Órdenes de servicio | Agenda del día, registrar la llegada del cliente, cobrar la orden terminada. Local Host ya tiene Técnico |
| Salud | Farmacia, Pacientes | Venta con receta: lote y caducidad al escanear. El expediente se queda en el escritorio |
| Producción | Producción | Marcar tandas hechas o mermas desde la cocina |
| Socios | Socios | Nada en la tablet: se resuelve en el corte del escritorio |

### Inventario en la mano

| Función | Qué se hace en la tablet |
|---|---|
| Conteo físico guiado | Escanear y contar por pasillo; las diferencias se aplican con `sp_inventory_count_apply`. Funciona sin red en evento |
| Recibir mercancía | Foto del ticket del proveedor: OCR (0077) y memoria de compra (0092) llenan la recepción. Se comparan cantidades contra el pedido sugerido |
| Caducidades | Escanear lote y fecha al recibir; aviso al vender un lote vencido |
| Etiquetas de precio | Imprimir etiquetas con código en impresora Bluetooth de etiquetas tras un cambio de precio |
| Traspasos | Enviar o recibir entre sucursales escaneando (ya hay traspasos con QR firmado) |
| Pedido sugerido | Ver lo que se acaba y mandarlo por WhatsApp al proveedor (0090 y 0092) |

### Personal

| Función | Qué se hace en la tablet |
|---|---|
| Asistencia | Checador con PIN y foto. En evento, con ubicación para comprobar que se está en la feria. Local Host ya tiene Mi jornada |
| Comisiones | Que cada vendedor vea lo que lleva vendido en su turno |

## 2. Lo que el teléfono sabe hacer y no se usa

| Capacidad | Uso en Wybix | Estado |
|---|---|---|
| **NFC: cobrar con el teléfono** | Cobrar con tarjeta sin terminal. Mercado Pago ofrece Point Tap en Android 10+ con NFC, con tope de $3,000 por cobro y comisión de 3.5 % + IVA, y Clip anunció su Tap to Pay. Wybix ya tiene el diseño a prueba de doble cobro (`packages/database/src/cobros.ts`, spike 2.5). Falta el proveedor real | Diseño listo, sin integración |
| Cámara | Escanear para vender, foto del ticket del proveedor, foto del producto para el catálogo | Solo QR |
| Compartir | Mandar el ticket por WhatsApp o como PDF, sin papel | No |
| Notificaciones | Pedido en línea, aprobación respondida, catálogo nuevo | No |
| Biometría | Que el encargado autorice con huella en vez de PIN | No |
| Ubicación | Checador del personal en evento | No |
| Báscula Bluetooth | Venta a granel con peso | No (el escritorio ya redondea el granel) |
| Lector de código Bluetooth | Leer rápido con lector de mano | No |
| Pantalla al cliente | Girar la tablet para que el cliente vea el total, elija propina y firme. Con dos pantallas, segunda vista | No |
| Modo kiosco (Android) | Que la tablet de la caja solo abra Wybix | No |
| Actualización por aire | `expo-updates` ya está instalado; falta un despliegue gradual por canal (piloto, todos) | Instalado, sin canales |

## 3. Lo que hacen los demás (referencia)

- **Loyverse** es gratis e incluye pantalla para el cliente y pantalla de cocina como apps de tablet, Tap to Pay en el teléfono y venta sin red.
- **Square** trae en la app inventario, lealtad, pantalla para el cliente, pantalla de cocina y varias tiendas; Tap to Pay funciona en iPhone XS o posterior y en Android compatible.
- **En México**, Mercado Pago Point Tap y Clip compiten en cobrar con el teléfono. La prensa cita que alrededor del 80 % de los pagos todavía son en efectivo: el cobro en efectivo con cambio y corte sigue siendo lo principal.

Lo que **ninguno** combina, y Wybix sí puede: la tablet como caja de la misma base que el escritorio (inventario, promociones y corte únicos) y como caja de evento sin red, más la memoria de compras, la venta suelta y los paquetes.

Fuentes: [Loyverse](https://loyverse.com/en-us) · [Loyverse, pagos](https://loyverse.com/en-us/payments) · [Square, funciones](https://square.com/gb/en/point-of-sale/features) · [Mercado Pago Point Tap](https://www.mercadopago.com.mx/herramientas-para-vender/point-tap) · [Mercado Pago: qué es Point Tap](https://www.mercadopago.com.mx/blog/que-es-tap-to-pay-cobrar-celular) · [El Cronista: Mercado Pago, Clip y BBVA](https://www.cronista.com/mexico/finanzas-economia/mercado-pago-va-por-el-tap-to-pay-la-nueva-funcion-que-sacude-la-competencia-con-clip-y-bbva)

## 4. Arquitectura para que quepa todo esto

- **Módulos según el negocio.** El snapshot (o Local Host) manda la lista de módulos encendidos y los permisos del rol, y la tablet muestra solo eso: la misma regla que `CapabilityService` en el escritorio. Hoy la tablet no sabe qué módulos tiene el negocio.
- **Superficies compartidas con Local Host.** Mesero, Técnico, Inventario y Jornada ya existen como superficies del escritorio. La app nativa debería consumir **el mismo contrato** de Local Host en lugar de rehacer la lógica.
- **Navegación que crece.** Cuatro pestañas fijas no alcanzan. Propuesta: Vender, Ventas, Turno, y un «Más» con lo que el negocio tenga encendido (Inventario, Mesas, Agenda, Asistencia, Estado). Lo mismo que el dock «Más» del escritorio.
- **Teléfono y tablet.** Vender en tablet es catálogo y cuenta lado a lado; en teléfono, vertical con la cuenta como hoja inferior. Mesero y checador se piensan primero para teléfono.
- **Proveedor de cobro conectable.** `ProveedorCobro` ya es una interfaz: Mercado Pago Point, Point Tap y Clip serían implementaciones, y las llaves siempre en la nube.

## 5. Prioridad sugerida (después de la sincronización)

1. **Caja diaria:** escáner, paquetes y suelta, cliente con crédito y puntos, pago dividido, devoluciones, ticket por WhatsApp.
2. **Modo caja de sucursal por Local Host**, con módulos según el negocio y el menú «Más».
3. **Cobro con el teléfono (Point Tap)** sobre `cobros.ts`.
4. **Inventario en la mano:** conteo, recepción con foto del ticket y etiquetas.
5. **Por giro:** mesero en el teléfono, pedidos en línea con aviso, agenda, checador.
6. **Pantalla al cliente, modo kiosco y actualizaciones por canal.**

---

# Estado de la implementación (2026-11-24)

**Hecho y probado**
- Sincronización: snapshot condicional (`20261124120000_pos_mobile_rapido.sql`), vía rápida después de vender, ciclo completo cada 5 minutos, métricas por fase en Estado y en Owner (tablets).
- Catálogo con código de barras, clave, presentaciones de venta y venta suelta (POS 0093, `sp_catalog_publication`).
- Motor comercial de la tablet igual al del escritorio (paquetes, mayoreo por cliente, granel): la prueba de paridad vuelve a pasar.
- Vender: búsqueda sin acentos por nombre, clave o código; paquetes como tarjetas, de menor a mayor; escáner continuo con la cámara; lector USB o Bluetooth que da Enter.
- Cobro dividido (varias formas de pago en una venta).
- Ventas del turno: historial, reimprimir, mandar el ticket por WhatsApp y devolver (parcial o total, con autorización).
- Conteo con escáner: todas las diferencias en una transacción.

Pruebas: `npm run test:quick` (210), `scripts/probar-fase3.mjs` (183 SQL, incluye `RAPIDO01–05`), `scripts/probar-pos-completo-web.cjs` (recorrido en Chromium) y la paridad de recetas del escritorio.

- **Modo caja de sucursal por Local Host (POS 0094):** emparejar con el QR de «Caja móvil», snapshot con catálogo, personal y existencias de la base, caja propia en `dbo.registers`, y cada evento registrado con los SP del escritorio (idempotente). Prueba: `npm run e2e:caja-movil` en el POS de escritorio. Detalle: `filtros_lubs_rios/docs/local-host-caja-movil.md`.

**Pendiente** (diseñado en Claude Design, sin código todavía)
- Cliente con crédito y abonos, recibir mercancía con foto del ticket y el menú «Más» por módulos (ya tienen dónde apoyarse: el modo sucursal).
- Pantalla al cliente con propina, mesero en el teléfono, cobro con NFC (Point Tap) y checador.
