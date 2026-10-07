> Fuente: historial local de Claude, 4 de octubre de 2026. Documento de referencia; el repositorio y las pruebas actuales tienen prioridad.

# Wybix Fase 3: auditoría de estado real (4 de octubre de 2026)

## 1. Veredicto de Fase 3

**NO LISTA PARA CIERRE.**

Desde el cierre de la Fase 2A solo cambiaron dos cosas: Astra rediseñó POS Mobile y creaste el proyecto EAS con su llave de firma. De los bloques de Fase 3, ninguno está completo:

- **No existen todavía:** MFA, aprobaciones remotas, motor de notificaciones, correo, sincronización en segundo plano, reimpresión, Bluetooth, Mercado Pago real, una fuente de verdad para la fecha de negocio, y un arnés de pruebas rápido.
- **Existen en parte:** las autorizaciones locales y la conciliación del evento.
- **Sin build ni hardware:** no hay ningún build en EAS ni pruebas en una tablet física.

El rediseño no introdujo regresiones funcionales que yo haya podido encontrar. Sí duplicó el sistema de diseño.

Tampoco hay en el repositorio un documento que defina la Fase 3. Usé como alcance los bloques de tu encargo más la deuda que dejó la Fase 2A.

## 2. Matriz de estado

| Área | Estado | Riesgo | Evidencia | Trabajo restante |
|---|---|---|---|---|
| Seguridad (roles y autoridad) | PARCIAL | MEDIUM | `permisos.ts` (CASHIER / SUPERVISOR / ADMIN); `pos.ts:107` `exigir()` impide autorizarse a uno mismo; `audit_local`; `authorized_by` viaja en los eventos; RLS por membresías desde la Fase 1 | `CONFIGURAR_IMPRESORA` y `DEVOLUCION` están definidos pero nada los exige: cualquier cajero cambia la impresora. Owner no muestra las autorizaciones (solo quedan en el payload) |
| Aprobaciones remotas | PENDIENTE | HIGH | No hay modelo, tabla, función ni pantalla; 0 coincidencias en ambos repos | Todo: modelo, expiración, idempotencia, vínculo empresa/ubicación/dispositivo, comportamiento sin red |
| MFA de Owner | PENDIENTE | BLOCKER | 0 usos de `mfa`/`aal`; el `config.toml` heredado trae TOTP con `enroll_enabled = false` | Enrolamiento, verificación, recuperación, exigir AAL2 en RLS y en funciones sensibles |
| Correo | PENDIENTE | HIGH | Sin proveedor; «Resend» solo aparece en un comentario de la migración de Fase 1 | Proveedor, dominio, remitente, plantillas, estado de entrega |
| Push | PARCIAL (heredado) | HIGH | `push_tokens` (por usuario) y `notificar-alerta` envían a Expo. El webhook se configura a mano, sin reintentos, sin recibos y sin limpiar tokens inválidos. Sin `WEBHOOK_SECRET` el endpoint queda abierto, y el secreto de producción sigue escrito en el trigger (pendiente de rotar) | Alcance por empresa, recibos, limpieza de tokens, rotar el secreto, revisar la privacidad del texto |
| Motor de notificaciones | PARCIAL (solo la cola) | HIGH | `notification_outbox` con `unique(kind, ref_uuid)`, estado e intentos. **Solo `SHIFT_CLOSED` escribe ahí y nada la consume** | Worker, reintentos con backoff, reglas, preferencias, eventos (diferencia de corte, rechazo, revocación, stock) |
| Sincronización en segundo plano | PENDIENTE (limitación) | HIGH | `lib/fondo.ts` sin cambios desde el 2 de octubre; sin módulo nativo nuevo, WorkManager propio ni headless | Implementación nativa y prueba de extremo a extremo con los 6 pasos que pediste |
| Reimpresión | PENDIENTE | MEDIUM | `print_jobs` guarda los FAILED y Estado los cuenta; no hay acción de reimprimir | Reimprimir desde `print_jobs` sin tocar la venta |
| Bluetooth | PENDIENTE | MEDIUM | Solo un comentario en `impresion.ts` | Todo |
| Fecha de negocio | LIMITACIÓN | MEDIUM | `fechaNegocio(reloj de la tablet, zona del evento)`, ver `pos.ts:39` y `pos.ts:191`. La venta toma la fecha del reloj, no del turno. La nube mide el desfase y solo Owner lo ve (si pasa de 5 min) | Fuente de verdad para la fecha (ligada al turno), aviso en la tablet y regla para el cambio de día |
| Inventario y conciliación | PARCIAL | MEDIUM | `evento_cambiar_estado` exige: sin turnos, sin tránsito y existencias en cero, o forzar con motivo y auditoría. Owner muestra el faltante por UUID de 8 caracteres | Desglose de causas, nombres de producto, motivo validado en el servidor, ajuste contra la sucursal base |
| Hardware | PENDIENTE | BLOCKER | Toda la evidencia (2A y Astra) es de emulador | Validación física completa |
| EAS / release | PARCIAL | HIGH | Proyecto `6bbce3fd…`, OTA configurado, llave descargada. `build:list`: **0 builds**; `channel:list`: **0 canales** | Primer `production-apk`, comprobar la firma, mover la llave a la bóveda |
| Mercado Pago | PENDIENTE (solo el modelo) | MEDIUM | `cobros.ts` + 4 pruebas; **nada lo usa**; sin función en la nube ni terminal. La tarjeta es un método que se confirma a mano | API, terminal, webhook, cancelación, conciliación |
| Arnés de QA | DEUDA | MEDIUM | Sin `test:quick`, `affected`, `integration` ni `full`. Cada consulta SQL tarda unos 0,6 s (0,37 s solo en arrancar PowerShell). `db:test-demo` y `db:test-giros` siguen usando los nombres de bases `Wybix_Demo_*` | Conexión persistente, scripts por nivel, nombres temporales propios |
| Rediseño de POS Mobile | PARCIAL | MEDIUM | Ver la sección 7 | Unificar el sistema de diseño |

## 3. Implementado desde Fase 2A

**EAS:**
- `eas init` hecho: `projectId`, `owner: davidcasillas` y `updates.url` en `apps/pos-mobile/app.json`.
- `eas credentials` hecho: la llave `@davidcasillas__wybix-pos-mobile.jks` está en `apps/pos-mobile/`. Git la ignora por `*.jks`, pero sigue en el árbol de trabajo.

**Rediseño de Astra**, el 4 de octubre:
- **Componentes:** `components/ui.tsx` es un sistema local nuevo (tokens, `Pulse`, `Aparece`, `Boton`, `Teclado`, `Sheet`, `Pantalla`, `MotionProvider`). Además hay un `Acceso.tsx` nuevo y se rehicieron `Encabezado`, `Autorizar` y `Escaner`.
- **Pantallas:** las 8 (`_layout`, `index`, `entrar`, `enrolar` y las cuatro de `caja/*`).
- **Código y pruebas nuevos:** `lib/entrada.ts` y `test/entrada.test.ts`.
- **Documentación:** `docs/diseno-pos-mobile/` con 17 capturas, todas de emulador.

Nada más cambió. Astra no tocó `packages/`, `supabase/`, Owner ni el POS de Windows: ningún archivo de esos lugares es posterior al cierre de la 2A.

## 4. Pendientes reales

1. MFA de Owner, completo.
2. Aprobaciones remotas, completas.
3. Entrega de notificaciones: el worker sobre `notification_outbox`, los eventos conectados, el correo y endurecer el push.
4. Sincronización en segundo plano demostrada en la nube.
5. Fecha de negocio con una fuente de verdad.
6. Reimpresión y Bluetooth.
7. Conciliación con causas y nombres de producto.
8. Mercado Pago real.
9. Primer build firmado y validación en hardware físico.
10. Arnés rápido y aislamiento de las bases de demo.
11. Exigir `CONFIGURAR_IMPRESORA` en la tablet.
12. Unificar el sistema de diseño.

## 5. Blockers

Son los que impiden declarar la Fase 3 terminada:

1. **MFA de Owner.** Protege licencias, empresas, funciones fiscales y, más adelante, las aprobaciones remotas. Sin él, esas aprobaciones no deberían existir.
2. **Aprobaciones remotas**, que dependen de MFA y de las notificaciones.
3. **Entrega de notificaciones (push y correo).** La cola existe, pero nada la consume.
4. **Sincronización en segundo plano**, sin evidencia en la nube.
5. **Build firmado y hardware físico.** No hay ningún build.

Mercado Pago y Bluetooth solo son bloqueantes si el producto los mantiene dentro del alcance; necesitan credenciales y hardware tuyos.

## 6. Deuda no bloqueante

**Higiene antes de cualquier commit:**
- `apps/pos-mobile/modules/wybix-scrypt/android/build/` no está ignorado: son 167 archivos generados por mis builds de la 2A.
- Hay un `app.json` suelto en la raíz con `{"expo":{}}`, creado a las 22:52 del 3 de octubre, probablemente por un comando de EAS corrido en la raíz.
- Los permisos y los permisos bloqueados aparecen duplicados en `apps/pos-mobile/app.json`.
- El `.jks` debe ir a la bóveda y salir del árbol de trabajo.

**Seguridad heredada:**
- Rotar el secreto del webhook de alertas y moverlo a Vault.
- Hacer obligatorio `WEBHOOK_SECRET`.

**Arnés:**
- Una conexión SQL persistente.
- `npm test` de la raíz no incluye las pruebas de `apps/pos-mobile`.

**Owner:**
- Mostrar las autorizaciones (quién autorizó qué).

## 7. Regresiones del rediseño

**No encontré regresiones funcionales.** Verifiqué en el código:

- **Corte a ciegas:** `ventas` y `por_metodo` siguen ocultos (`pos.ts:292-293`), y la UI respeta `ventas != null`.
- **Píldora de sincronización:** sigue recibiendo `enRevision` en el encabezado y en la entrada.
- **Venta:**
  - el `lock` contra doble toque sigue;
  - la cuenta solo se limpia después de guardar y se conserva si falla;
  - la impresión sigue siendo posterior a la venta, con el mismo aviso de falla.
- **Autorizaciones:** `Autorizar` lista solo a quien tiene el permiso, y la capa de datos lo vuelve a exigir.
- **Estados:** los de carga, error con «Reintentar» y sin enrolar siguen.
- **Otros:** `/spike` sigue bloqueado en producción, y el catálogo es una `FlatList` virtualizada que maneja bien el cambio de columnas.
- **Accesibilidad:** objetivos táctiles de 48 dp o más, roles y estados accesibles, región viva en los avisos y movimiento reducido respetado.

**Hallazgos:**

| Hallazgo | Clase |
|---|---|
| **Sistema de diseño duplicado.** `components/ui.tsx` reimplementa `pos`, `tipo`, `Boton`, `Teclado`, `Tarjeta`, `Aviso`, `Puntos` y `BarraSync`, que ya existían en `@wybix/ui`. Ese paquete queda casi muerto: solo lo usan `dinero` y `spike.tsx`. Las paletas divergen (navy `#0F2A3F` vs `#102B40`, acento `#1F7A8C` vs `#167F92`) | Importante |
| **No es coherente con los otros productos.** Windows usa cian `#45B3C3` con tinta oscura y **Geist**. Owner usa navy `#0F1C26` con Poppins. Mobile usa un tercer teal `#167F92` con texto blanco y Poppins. La documentación dice que la tipografía es «compatible con el POS de escritorio», y no lo es | Importante |
| Unas 20 literales de color fuera de los tokens (6 valores distintos) en `Encabezado`, `caja/_layout` y `Escaner` | Mejora |
| Los íconos de la navegación dependen de la posición (`icons[index]`), y el ícono de Estado siempre es `cloud-done` aunque no haya red | Mejora |
| Validación solo en emulador. Astra lo dice explícitamente: no hubo cámara, impresora ni rendimiento en dispositivo físico, ni un recorrido manual de todas las operaciones | Deuda futura |

## 8. Pruebas ejecutadas

| Comando | Resultado | Qué valida |
|---|---|---|
| `npm run typecheck` (monorepo) | OK, 25 s | Tipos de Owner, POS Mobile y los paquetes, después del rediseño |
| `npm test` (raíz) | 53/53, 7 s | Dominio, base local, PIN, permisos, cobros, QR y sincronización |
| `npm test` en `apps/pos-mobile` | 3/3, 2 s | ESC/POS y la entrada de efectivo/PIN (`entrada.ts` es nuevo) |
| `eas-cli build:list` (solo lectura) | 0 builds | No existe ningún APK firmado de producción |
| `eas-cli channel:list` (solo lectura) | 0 canales | OTA nunca publicado |
| Medición de `consultar()` del arnés SQL | ~0,6 s por consulta, 0,37 s de PowerShell | Dónde está el cuello de botella |
| Inspección de Git y fechas de modificación en ambos repos | — | Qué cambió desde la 2A |

## 9. Pruebas que no ejecuté

| Prueba | Por qué no | Evidencia alternativa |
|---|---|---|
| `test:fase1`, `test:fase2`, `test:licenciamiento` | Ningún archivo de `supabase/` ni de `packages/` cambió desde la 2A | 127/127, 91/91 y 122/122 el 3 de octubre |
| Suites `test:*` y `db:*` del POS de Windows | El repositorio no tiene cambios desde la 2A, y la campaña dura más de 1 hora | 33/33 en BD y 33/36 en `test:*` (las 3 fallas son preexistentes) el 3 de octubre |
| `db:test-demo` y `db:test-giros` | Son destructivas: borran `Wybix_Demo_*`, incluida Hospitality | Revisión del código: siguen usando esos nombres |
| UI en el emulador | No me pediste modificar nada, y Astra ya documentó su recorrido; lo revisé por código | `docs/diseno-pos-mobile/evidencia/` |
| Hardware físico | No hay build ni dispositivo | Ninguna |

## 10. Orden recommended

1. **Higiene antes del commit:**
   - ignorar `modules/*/android/build/`;
   - quitar el `app.json` de la raíz y los permisos duplicados;
   - mover el `.jks` a la bóveda;
   - renombrar las bases de `db:test-demo` y `db:test-giros`.

   Luego decides tú el commit de la Fase 2, la 2A y el rediseño en la rama.
2. **Primer `production-apk` y validación en hardware físico.** Esto le quita riesgo a todo lo demás.
3. **Unificar el sistema de diseño** (`@wybix/ui` o `components/ui`, uno solo, alineado con Windows y Owner) antes de agregar pantallas nuevas.
4. **MFA de Owner.**
5. **Motor de notificaciones** sobre `notification_outbox`, endurecer el push y luego el correo.
6. **Aprobaciones remotas.** Se reutilizan:
   - `exigir()`, `authorized_by` en los eventos y `wx_audit`;
   - `wx_actor_admin`, la credencial del dispositivo y `notification_outbox`.
7. **Fecha de negocio**, ligada al turno y con aviso de desfase en la tablet.
8. **Reimpresión** desde `print_jobs` y exigir `CONFIGURAR_IMPRESORA`.
9. **Conciliación** con causas y nombres de producto.
10. **Sincronización en segundo plano** nativa, con prueba de extremo a extremo.
11. **Arnés rápido:** conexión persistente y scripts `quick` / `full`.
12. **Mercado Pago y Bluetooth.** Requieren credenciales, una terminal y una decisión sobre el hardware.

No modifiqué nada en esta sesión: no hice commits, cambios de código, deploys ni builds.