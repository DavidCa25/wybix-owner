# Fase 2A · cierre técnico y preparación del piloto de I Do Nut

> Sin commit, sin push, sin deploy, sin publicar en tiendas.
> Mediciones de dispositivo: **emulador** Android 16 x86_64 en Windows, con el
> equipo cargado por otras aplicaciones (Rocket League, Epic, Docker). **No hubo
> dispositivo físico**: ninguna cifra de aquí es una validación física.

## P0-A · PIN

**Causa.** El PIN se verifica con scrypt (N=16384, r=8, p=1, 32 bytes; la sal
como texto UTF-8), el mismo esquema que el POS de Windows. En la tablet se
calculaba en **JavaScript** (`@noble/hashes`) sobre **Hermes, que no tiene JIT**:
~100 veces más lento que en Node (76 ms con JIT, 39 ms con OpenSSL). Además se
calculaba **dentro** de la transacción exclusiva: congelaba la pantalla y la
cola de la base.

**Corrección** (sin tocar parámetros ni el esquema de hashes):

- `apps/pos-mobile/modules/wybix-scrypt`: módulo nativo local (Expo, Android)
  con el scrypt de **BouncyCastle** (`org.bouncycastle.crypto.generators.SCrypt`,
  la misma biblioteca que ya traía `react-native-tcp-socket`), en un hilo de
  fondo. Borra los arreglos con el PIN; nunca registra el PIN ni el hash.
- `@wybix/auth`: motor de scrypt intercambiable (`usarMotorScrypt`), política de
  intentos separada (`evaluarIntento`, `bloqueoVigente`) — la misma: 5 fallos,
  5 minutos, respuesta uniforme (sin persona también se gasta un scrypt).
- `@wybix/database/acceso.ts`: el scrypt va **fuera** de la transacción; dentro
  se **releen** los intentos (dos intentos a la vez no se saltan el límite).
  Bloqueado: no se calcula ningún scrypt. Mide cada etapa.
- iOS, web y pruebas: el mismo scrypt en JavaScript, con `asyncTick` (cede el
  hilo; no congela). Mismo resultado byte a byte.

**Compatibilidad demostrada** (no supuesta):

| Prueba | Dónde | Resultado |
|---|---|---|
| Vectores RFC 7914 §12 (N=16384 y N=1024,p=16) | Node: motor JS y OpenSSL | iguales |
| Hashes creados por el POS de Windows (`credenciales.hashPin`) | Node | verifican con ambos motores |
| 25 PIN y sales al azar | Node | JS = OpenSSL = síncrono |
| Vector RFC 7914 y 3 hashes del POS de Windows | **Emulador, motor nativo** | 3/3 y vector correcto |
| Entrada real con hashes del POS de Windows (lupita, marta) | **Emulador, app release** | entran |

**Tiempos** (mismo build release, mismo emulador, mismas condiciones de carga):

| Medida | Antes (JS en Hermes) | Después (nativo) |
|---|---|---|
| scrypt del PIN | 14 158 ms (build anterior) · 17 367 ms (motor JS en el build nuevo) | **226 ms** mediana (169–268) |
| `identificar()` completo (lectura + scrypt + escritura) | — (≥ scrypt) | **336–451 ms** (lectura ~20, scrypt 250–340, escritura 70–124) |
| PIN → pantalla de venta, en la app | 8–17 s | < 1,5 s (captura a 1,5 s ya en Vender) |

**Política y seguridad** (automatizadas, `packages/auth/test/pin-motor.test.ts`
y `packages/database/test/pin.test.ts`, más app real): correcto/incorrecto,
bloqueo tras 5 fallos (también en la app real), el bloqueo gana al PIN correcto,
sobrevive a reiniciar, 5 intentos simultáneos no lo saltan, bloqueado no
calcula scrypt, auditoría sin el PIN, rol del EVENTO y permisos locales, todo
sin red.

**Migración de hashes.** No hace falta: el esquema es idéntico.

## P0-B · APK distribuible

Listo en el repositorio: `com.wybix.posmobile`, perfil `production-apk`
(`apps/pos-mobile/eas.json`), `0.1.0` / `versionCode 1`, `runtimeVersion` por
fingerprint, canales `pos-preview` / `pos-production` (separados de Owner),
`allowBackup=false`, en producción **sin tráfico en claro** y backend HTTPS,
permisos mínimos (se quitan `SYSTEM_ALERT_WINDOW`, almacenamiento externo y
biometría que el template de Expo agrega). Revisión del APK: sin `service_role`,
sin llaves privadas, sin `.env`; el único JWT es la llave **anon** pública.

**Falta tu intervención** (cuenta de Expo `davidcasillas`, sesión activa en este
equipo): crear el proyecto EAS y la llave definitiva. Pasos en el reporte.

**Actualización conservando datos** (emulador, misma firma de depuración):
build anterior con 2 300 ventas en la base de medición y la base operativa con
turno → `adb install -r` del build nuevo → 2 300 ventas intactas, migración sin
reaplicar nada, entrada sin red, existencias intactas; segunda actualización con
**turno abierto y ventas**: el turno sigue abierto, nada se pierde.

> Las tablets del piloto deben instalar desde el principio el APK firmado con
> la llave de EAS: un APK firmado con otra llave no puede actualizarse encima
> (habría que desinstalar y se perdería lo no sincronizado).

## P0-C · Sincronización

Con la app abierta (emulador, app release, nube local con la Edge Function real
e inyección de fallas):

| Caso | Resultado |
|---|---|
| Venta con red | sube en **3 s** sin intervención (antes: hasta 60 s y la pantalla decía "Todo sincronizado") |
| Se corta la red | "Sin conexión · 2 operaciones pendientes" (el número real) |
| Vuelve la red, sin tocar nada | sube sola en **3 s**, cada evento una vez |
| 503 transitorios (×2) | reintenta; APPLIED al tercer intento, una vez |
| Rechazo de la nube | queda "1 en revisión" con el motivo; no desaparece tras otras sincronizaciones; lo siguiente sube normal; la píldora ya no se pone en verde |
| Duplicados | nube = 6 ventas para F1-000001…000006; reenvío idempotente ya probado (DUPLICATE) |

**Segundo plano** (expo-background-task): WorkManager ejecuta la tarea con la
app cerrada, pero expo-background-task cancela y reencola su propio worker al
registrarse y Android congela el proceso antes de terminar: **no llega nada a
la nube**. No se resuelve sin un servicio nativo (o un cambio en la librería):
queda como limitación documentada. Al reabrir la app con red, lo pendiente sube
en el primer segundo.

## P0-D · Migración 0052 y template

- La 0052 no había actualizado el esquema de referencia: el baseline se
  construye desde `sql/schema/tables` + `sql/manifest.json` y marca como
  aplicadas TODAS las migraciones. Un template regenerado así habría dicho
  "tengo la 0052" sin sus tablas.
- Corregido con los extractores, **sin tocar producción**: esquema extraído de
  la base temporal `Wybix_MigTest` (= esquema de Git + 0052; solo cambian las 7
  tablas esperadas), manifiesto actualizado de forma dirigida (las 7 tablas y
  los 7 procedures; huellas de archivo = huellas de lo desplegado).
- `npm run db:prepare-release`: PASS (baseline desde Git con 52 migraciones,
  verificación a fondo del template, instalación limpia). Solo escribe
  `installer/template.bak` (ignorado por Git); el anterior quedó respaldado.
- `npm run db:test-0052` (nuevo): sucursal con ventas, turno, outbox e identidad
  de nube sobre el template ANTERIOR → aplicar la 0052 → ninguna fila cambia,
  identidad intacta, uuid único por producto, reaplicar no falla ni cambia nada,
  enviar/recibir funciona. 12/12.

**Impacto de distribuir el instalador viejo:** funcionaba (el arranque aplica la
0052 pendiente), pero cada instalación nueva ejecutaba 20 lotes más al primer
arranque y el inventario del repositorio no describía el esquema real.

## Aceptación con el APK final (emulador, build release)

Instalado con `adb install -r` ENCIMA de la instalación con turno abierto, 6
ventas y un rechazo en revisión. Nube local con la Edge Function real.

| Prueba | Resultado | Evidencia |
|---|---|---|
| Actualizar | ventas, turno abierto y rechazo intactos; píldora ámbar «1 en revisión» | 48 |
| Falla de impresión (IP sin impresora) | venta guardada (existencia 34→33), aviso «no se pudo imprimir», sube sola a la nube | 49 |
| Venta sin red | «Sin conexión · 1 operación pendiente · 1 en revisión» | 50 |
| Cierre forzado (`am force-stop`) y reabrir sin red | pendiente y rechazo intactos; entrada con PIN sin red | 51 |
| Vuelve la red, sin tocar nada | la venta llega a la nube en **2 s**; nube: 8 ventas, cada una una vez | 52 |
| Regresar sobrante con autorización de marta | existencias positivas a 0, negativa conservada para conciliar; RETURN_SENT APPLIED | 53 |
| Corte a ciegas | la cajera ve solo tickets; cierra «Contado $400.00»; la nube recibe SHIFT_CLOSED con `blind_count=true`, esperado y diferencia | 54, 55 |

Permisos del APK final (aapt2): INTERNET, ACCESS_NETWORK_STATE, CAMERA,
VIBRATE, CHANGE_NETWORK_STATE, ACCESS_WIFI_STATE, WAKE_LOCK,
RECEIVE_BOOT_COMPLETED, FOREGROUND_SERVICE (los tres últimos, de WorkManager).

## Hallazgos de esta pasada

1. **El corte a ciegas no era ciego** (corregido). `resumenTurno` ocultaba el
   esperado pero entregaba al cajero las ventas totales y por método: con el
   EFECTIVO vendido y el fondo que él mismo abrió, el esperado sale con una
   suma. Ahora, a ciegas, `ventas = null` y `por_metodo = {}` (en el origen,
   no solo en pantalla); el encargado sigue viéndolo todo. La prueba
   `base-local.test.ts` exigía la fuga; ahora exige lo contrario.
2. **Pruebas SQL de la nube dependientes de la hora** (preexistente,
   corregido en los datos de prueba). `fase1.test.sql` y `fase2.test.sql`
   fechaban las ventas con `current_date` del contenedor (UTC), y el tablero
   cuenta «hoy» en la zona de la sucursal. De 18:00 a 24:00 en México fallaban
   IDN02, IDN03, IDN06 y F2-OWN01. Ahora la sesión de prueba usa
   `America/Mexico_City`, como el POS. Las aserciones no cambian.
3. **`test:licencia-integracion` siempre salía con 1** (preexistente,
   corregido). `falla` es un arreglo y `[]` es verdadero: 35/35 y aun así
   fallaba. Ahora `falla.length`, igual que las otras dos pruebas del arnés.
4. **Existencias negativas en el evento**: sin red no se bloquea una venta;
   se marca en rojo y se concilia al cerrar el evento (decisión de diseño,
   `fase2-diseno.md`). Visible para la cajera.

## Limpieza de bases de demostración

| Base | Procedencia (msdb.restorehistory) | Estado | Acción |
|---|---|---|---|
| `Wybix_Demo_Hospitality` | última restauración 26-sep | demo válida (marcador, 8 ventas) | **intacta** |
| `Wybix_Demo_Servicios` | creada 02-oct 15:07:12 por `db:test-giros` interrumpida | sin marcador, 0 ventas, 0 productos | respaldada y eliminada |
| `Wybix_Demo_Retail` | creada 02-oct 16:49:48 por `db:test-demo` interrumpida | sin marcador, 0 ventas, 0 productos | respaldada y eliminada |

Respaldos: `C:\POS_Backups\respaldo_antes_de_limpiar_<base>_20261004.bak`.

> `db:test-demo` y `db:test-giros` crean y borran bases con los MISMOS nombres
> que el gestor de demos de la app. Correrlas en un equipo con demos reales las
> sobrescribe. Se recomienda que usen nombres temporales propios.
