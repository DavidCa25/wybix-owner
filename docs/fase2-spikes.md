# Fase 2 · spikes técnicos

Cada spike: **prueba → resultado → decisión → impacto**. Las mediciones de
dispositivo se hicieron en un **emulador** Android 16 x86_64 (tableta
2560×1600, GPU por software) en Windows; un dispositivo ARM real será
distinto. Evidencia en `docs/evidencia/fase2/`.

## 2.1 SQLCipher en Android (development build)

**Prueba.** `apps/pos-mobile/app/spike.tsx` (solo perfil de desarrollo):
base aparte con su llave en SecureStore, 1 000 ventas, lectura de catálogo de
300 productos, lote de outbox de 500, scrypt del PIN; luego matar la app y
repetir; copiar el archivo fuera del dispositivo.

**Resultado.**

| Medida | Debug | Release |
|---|---|---|
| SQLCipher | 4.7.0 community | 4.7.0 community |
| Abrir con llave | 12–19 ms | 10 ms |
| Migraciones v0→v2 | 93 ms | (ya aplicadas: 26 ms) |
| Venta completa (1 transacción) | 145–182 ms | 128–140 ms |
| Catálogo 300 productos | 3–12 ms | 12 ms |
| Lote de outbox (500) | 83–154 ms | 82 ms |
| scrypt del PIN (N=16384) | 16 s | **8–9 s** |
| Cabecera del archivo | no es “SQLite format 3” | igual |

- Tras matar la app: `ventas_previas` = 1 000, la migración no repite nada, la
  llave se reutiliza.
- La base real de la app copiada fuera de la tablet (`adb`): `sqlite3` responde
  *file is not a database*; 857 KB de WAL sin una sola cadena legible
  (“Dona”, “lupita”, “EFECTIVO”: 0 coincidencias). `ALLOW_BACKUP` no aparece en
  los flags del paquete.
- Encontrado y corregido: (a) `withExclusiveTransactionAsync` abre una segunda
  conexión **sin la llave** → toda transacción fallaba con *file is not a
  database*; ahora una conexión con cola en JS. (b) Dos aperturas simultáneas
  en el primer arranque generaban dos llaves y la base quedaba ilegible para
  siempre; ahora la llave, el UUID y la apertura se crean una sola vez.

**Decisión.** SQLCipher se queda. scrypt en JS (Hermes) no era aceptable para
el PIN. **Resuelto en la Fase 2A** con scrypt nativo (BouncyCastle, módulo local
`wybix-scrypt`): mismos parámetros y esquema, compatibilidad demostrada con RFC
7914 y hashes del POS de Windows; en el emulador pasó de 14–17 s a ~226 ms
(`identificar()` completo 336–451 ms). Ver `fase2a-cierre.md`.

**Impacto.** Ya no bloquea el piloto, salvo la medición en un dispositivo
físico, que sigue pendiente.

## 2.2 Impresora

**Prueba.** Abstracción `Impresora` con tres implementaciones: red ESC/POS
(TCP 9100), impresión de Android (expo-print) y sin impresora. Prueba en
emulador contra un receptor TCP en el equipo; venta con impresión cancelada.

**Resultado.** El receptor recibió 258 bytes: `ESC @` (inicializa), centrado,
negritas, texto ASCII seguro (sin acentos) y `GS V` (corte). La venta F1-000001
quedó guardada aunque se canceló el diálogo de impresión. Se corrigió la hora
de Android (espacio angosto U+202F impreso como “?”). Bluetooth: pendiente de
hardware.

**Decisión.** Red ESC/POS como opción recomendada para ferias; la impresión del
sistema queda como alternativa; **por omisión, sin impresora** hasta que el
encargado elija (el diálogo del sistema en cada venta estorba).

**Impacto.** Ninguno en datos: imprimir nunca bloquea ni deshace una venta.

## 2.3 Paridad de recetas con SQL Server

**Prueba.** `scripts/db/pruebas/paridad-recetas.mjs` (repo del POS): 11 casos
(DIRECT, NONE, decimal, receta base con merma, tamaño, SCALE, SUBSTITUTE con y
sin cantidad, REMOVE + ADD, todo junto) calculados con `@wybix/domain` y
registrados con `sp_register_sale` sobre el MISMO catálogo publicado.

**Resultado.** 13/13: precio, costo, receta, variante y cada movimiento de
inventario idénticos, sin tolerancia.

**Decisión.** El dominio móvil es la referencia para la tablet; la prueba se
corre en cada cambio de recetas de cualquiera de los dos lados.

**Impacto.** Ninguna diferencia silenciosa entre una venta de Centro y una de la
feria.

## 2.4 Transferencia por QR firmado

**Prueba.** Centro firma con su llave Ed25519 (node:crypto en el POS de
Windows); la tablet verifica con `@noble/curves` sin red. Casos: válido,
cantidad alterada (10 → 100), llave desconocida, otra empresa, otro evento.

**Resultado.** Válido se importa y se recibe una sola vez; los demás se
rechazan con su código (`FIRMA`, `LLAVE_DESCONOCIDA`, `AJENO`). En el E2E, el
envío por QR concilia en la nube aunque Centro sincronice después de la feria.

**Decisión.** QR firmado como respaldo oficial de la recepción sin red.

**Impacto.** La feria puede arrancar sin Internet; la nube sigue siendo la
fuente de la verdad para conciliar.

## 2.5 Mercado Pago

**Prueba.** Modelo de intento de cobro (`payment_intents`) con llave de
idempotencia `wx-<sale_uuid>-<n>` persistida antes de llamar al proveedor;
estados `CREATED/PENDING/APPROVED/REJECTED/CANCELLED/UNKNOWN`.

**Resultado.** Aprobado y red caída: `UNKNOWN`, se concilia y queda UN cargo.
Sin red al crear: se reenvía con LA MISMA llave. Rechazado: intento nuevo con
otra llave; aprobado: no se puede cobrar otra vez. La base impide dos intentos
activos por venta.

**Decisión.** El adaptador real (Point / QR de Mercado Pago) va por la nube
(nunca credenciales en la tablet) y requiere cuenta y terminal de prueba: no
se implementó sin ellas. Mientras tanto, tarjeta = terminal externa y la cajera
confirma con la referencia.

**Impacto.** Sin doble cobro por diseño; falta la integración real (Fase 3).

## 2.6 Sincronización en segundo plano

**Prueba.** `expo-background-task` (WorkManager), tarea `wybix-sincronizar`.
Crear una operación sin red, cerrar el proceso (`am kill`), restaurar la red y
forzar el job; además, esperar el disparo natural.

**Resultado.** El job está registrado (requiere red) y Android arranca la app sin
interfaz y ejecuta la tarea. En la ejecución forzada, expo-background-task
cancela y reencola su propio worker al registrarse y Android congela el proceso
antes de que termine el JS: no subió nada. `force-stop` cancela los jobs (así es
Android). El **disparo natural** (15 min, app cerrada, con red) se comportó
igual: `Executing task 'wybix-sincronizar'` y nada llegó a la nube. Al abrir la
app, lo pendiente subió en el primer segundo (`APPLIED`).

**Decisión.** Como pide la fase, es una mejora y no un requisito. La integridad
depende del outbox local + sincronización al abrir, al recuperar la red, cada
minuto al frente y manual — probado en emulador (6 eventos en orden, una vez).

**Impacto.** Si la tablet queda cerrada con pendientes, suben al abrirla.
Fase 3: servicio en primer plano mientras hay turno abierto, o investigar el
reencolado de expo-background-task.
