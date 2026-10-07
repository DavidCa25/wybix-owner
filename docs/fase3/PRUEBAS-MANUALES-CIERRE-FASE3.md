# Paso 0 — Preparación

Guía del piloto QA desde instalación limpia. Todos los casos manuales empiezan **PENDIENTES**; la evidencia automática no equivale a una ejecución física. Leer [PLAN-DEPLOY.md](PLAN-DEPLOY.md), [COMPATIBILIDAD-MOBILE.md](COMPATIBILIDAD-MOBILE.md) y [RELEASE-EAS.md](RELEASE-EAS.md). Al 5 de octubre el backend está aplicado y pasó el smoke Mobile positivo. Usar únicamente el nuevo APK después de verificar su firma y metadatos; correo/push físicos y Owner AAL2 siguen pendientes.

## Licencia y escenarios — Opción D

Crear `Wybix QA Fase 3` y `Wybix QA Scope B`, con una licencia QA independiente cada una, edición multi, giro COMMERCE, screen_tier BASE y addon MOBILE_POS; vigencia de prueba elegida: 14 días. No es un precio ni una oferta comercial. MonoCaja limita registers_max a 1; MultiCaja no tiene ese límite, pero cada licencia sigue habilitando una sola BRANCH y el addon una tablet Mobile; EVENT es temporal. Mantener una Base y un Evento por empresa, timezone America/Mexico_City.

Entitlements de edición: sales, customers, reports, invoicing, loyalty, inventory, purchases, suppliers, cloud_sync, backup. COMMERCE: commerce, operational_surfaces, operational.inventory_floor (BASE: tres pantallas). Addon: mobile_pos, temporary_locations, mobile_pos_max=1. Ventas/turnos usan sales; inventario/transferencia usan inventory; sincronización usa cloud_sync; enrolamiento exige mobile_pos; feria exige temporary_locations. Las demás capabilities no sustituyen esas condiciones. Confirmar `company_entitlements` real antes de enrolar. El script QA es soporte manual, nunca migración ni permiso implícito de escritura remota. Demo Manager cubre Windows y aislamiento; el Trial remoto carece de Mobile/eventos. No reutilizar datos productivos de I Do Nut.

PIN y credenciales son placeholders: cada responsable crea sus valores en la bóveda; no existe aquí un PIN universal de cajera. Guardar evidencias sin QR MFA, recovery codes, tokens, licencias ni datos reales. Usar nombre de caso, versión, hora y entorno; capturas sensibles se depuran antes de compartir.

## INST-01 — Preparación

### Objetivo

Validar preparación en el flujo real del piloto.

### Precondiciones

Disponer de tablet Android compatible con el APK verificado, Wi-Fi, PC Windows con POS, Owner, autenticador TOTP, impresora LAN ESC/POS y credenciales QA.

### Pasos

Confirmar backend completo siguiendo PLAN-DEPLOY.md y COMPATIBILIDAD-MOBILE.md. Guardar hash, firma, versión, versionCode y modelo/Android. Reservar tablet y cuentas exclusivamente QA. Usar buzón de prueba real y acceso a su correo. El backend ya pasó smoke; proveedor de correo, recepción push, Owner AAL2 y hardware siguen pendientes.

### Resultado esperado

Material identificado; ninguna base o cuenta productiva se usa.

### Evidencia a guardar

Registro INST-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 1 — Instalación limpia

## INST-02 — Instalación limpia

### Objetivo

Validar instalación limpia en el flujo real del piloto.

### Precondiciones

APK production-apk firmado y backend compatible; ninguna venta QA pendiente de conservar.

### Pasos

En la tablet QA exportar evidencia necesaria; desinstalar la app anterior o borrar sus datos desde Ajustes únicamente en esa tablet. Instalar APK, abrir y conceder cámara al escanear; denegar micrófono si aparece. Registrar permisos y estado inicial.

### Resultado esperado

Pantalla de enrolamiento, sin sesión/turno/ventas anteriores; no pide permisos ajenos a su función.

### Evidencia a guardar

Registro INST-02: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 2 — Crear escenarios y actores

## LIC-01 — Crear escenarios y actores

### Objetivo

Validar crear escenarios y actores en el flujo real del piloto.

### Precondiciones

Soporte autorizado dispone de supabase/scripts/fase3-qa-licencias.sql; Fase 2 aplicada.

### Pasos

Soporte ejecuta el script en el entorno QA autorizado y entrega <LICENCIA_QA_A> y <LICENCIA_QA_B> por canal seguro. Activar POS Windows con A, elegir COMMERCE y registrar Wybix QA Fase 3, Base QA, timezone America/Mexico_City. Vincular Owner mediante invitación de un uso. Crear Feria QA (EVENT), caja F1, operador QA y supervisor QA; asignarlos al evento, capturar <PIN_OPERADOR_QA>/<PIN_SUPERVISOR_QA> en bóveda, publicar catálogo/personal y transferir stock real de Base a Feria. Crear producto Dona QA, precio 25, stock inicial del evento 2. Repetir con B para empresa Wybix QA Scope B, Base Scope B, Feria Scope B y cuentas independientes. Revisar permisos asignados: operador vende/abre y cierra su turno; supervisor autoriza operaciones locales e impresión; Owner administra dispositivos/eventos y aprobación remota con AAL2.

### Resultado esperado

Dos empresas aisladas, cada una multi + COMMERCE/BASE + MOBILE_POS, vigencia QA 14 días; entitlements efectivos revisados antes del enrolamiento.

### Evidencia a guardar

Registro LIC-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.

## LIC-02 — Enrolamiento y límites

### Objetivo

Validar enrolamiento y límites en el flujo real del piloto.

### Precondiciones

Empresa A activa; catálogo y personal publicados.

### Pasos

Owner registra dispositivo MOBILE_POS para Feria QA/caja F1 y genera código/QR de enrolamiento. Usar <CODIGO_ENROLAMIENTO_QA> vigente (24 h); escanear o capturar. Revisar empresa/evento/caja/personal/productos. Intentar reutilizar código y enrolar segunda tablet sin otro cupo.

### Resultado esperado

Una tablet operativa; código no reutilizable; cupo adicional rechazado. MultiCaja no equivale a tablets ilimitadas.

### Evidencia a guardar

Registro LIC-02: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.

## LIC-03 — Scope, Demo y Trial

### Objetivo

Validar scope, demo y trial en el flujo real del piloto.

### Precondiciones

Escenario B independiente; Demo Manager Windows disponible.

### Pasos

Probar acceso con B a recursos A mediante interfaces permitidas. Crear demo Windows únicamente con el harness aislado. Consultar grants de Trial y catálogo, sin comprar ni inventar precios.

### Resultado esperado

B no ve/modifica A. Demo prueba Windows, no Mobile. Trial sin mobile_pos/temporary_locations no permite piloto integral.

### Evidencia a guardar

Registro LIC-03: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 3 — Acceso

## PIN-01 — Acceso

### Objetivo

Validar acceso en el flujo real del piloto.

### Precondiciones

Snapshot vigente y PIN QA guardado fuera del documento.

### Pasos

Ingresar PIN correcto de operador; cerrar sesión. Introducir PIN incorrecto una vez y después correcto. Repetir con supervisor; comprobar rol mostrado.

### Resultado esperado

Acceso solo con PIN correcto; roles conservados; error no revela PIN.

### Evidencia a guardar

Registro PIN-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.

## PIN-02 — Bloqueo

### Objetivo

Validar bloqueo en el flujo real del piloto.

### Precondiciones

Usuario QA desbloqueado.

### Pasos

Fallar cinco PIN consecutivos. Cerrar/reabrir app e intentar PIN correcto durante el bloqueo. Esperar cinco minutos y repetir correcto.

### Resultado esperado

Bloqueo persistente durante cinco minutos y recuperación según política; reinicio de app no evade el límite.

### Evidencia a guardar

Registro PIN-02: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

Hay cobertura automática local de integridad/persistencia correspondiente; la prueba manual añade interacción entre interfaces y entorno real.


# Paso 4 — Turno y fecha

## SHIFT-01 — Turno y fecha

### Objetivo

Validar turno y fecha en el flujo real del piloto.

### Precondiciones

Operador enrolado y sin turno abierto.

### Pasos

Abrir turno con fondo QA conocido; registrar fecha de negocio y hora. Reintentar apertura. Cerrar tras contabilizar efectivo; revisar hecho cloud al sincronizar.

### Resultado esperado

Un solo turno; fecha anclada al turno; apertura/cierre idempotentes; cajero captura contado sin esperado.

### Evidencia a guardar

Registro SHIFT-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 5 — Venta normal

## SALE-01 — Venta normal

### Objetivo

Validar venta normal en el flujo real del piloto.

### Precondiciones

Turno abierto; Dona QA precio 25 y stock 2; impresora conectada.

### Pasos

Agregar una Dona QA, cobrar efectivo 50; verificar cambio 25. Pulsar cobro repetidamente durante proceso. Guardar folio y confirmar persistencia, impresión y sync. Revisar saldo de evento y pago cloud.

### Resultado esperado

Una venta, un pago, un descuento de stock; cambio 25; folio estable y saldo 1.

### Evidencia a guardar

Registro SALE-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

Hay cobertura automática local de integridad/persistencia correspondiente; la prueba manual añade interacción entre interfaces y entorno real.


# Paso 6 — Venta offline persistente

## OFF-01 — Venta offline persistente

### Objetivo

Validar venta offline persistente en el flujo real del piloto.

### Precondiciones

Turno y snapshot cargados; conteos cloud registrados.

### Pasos

Desactivar Internet, vender y comprobar pendientes. Ir a Inicio y cerrar proceso normalmente; reabrir y verificar ticket/outbox. Recuperar red, sincronizar y repetir sync.

### Resultado esperado

Datos cifrados persistentes; una aplicación cloud por event_uuid, sin doble venta/pago/inventario.

### Evidencia a guardar

Registro OFF-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

Hay cobertura automática local de integridad/persistencia correspondiente; la prueba manual añade interacción entre interfaces y entorno real.

## OFF-02 — Force-stop

### Objetivo

Validar force-stop en el flujo real del piloto.

### Precondiciones

Solo tablet QA, venta pendiente.

### Pasos

Usar Ajustes → Forzar detención. Recuperar red y observar. Abrir manualmente Mobile y comprobar envío.

### Resultado esperado

Android suspende trabajo tras force-stop hasta reapertura; apertura recupera pendientes. No confundir con background o proceso cerrado normal.

### Evidencia a guardar

Registro OFF-02: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 7 — Proceso cerrado con herramienta QA

## BG-01 — Proceso cerrado con herramienta QA

### Objetivo

Validar proceso cerrado con herramienta qa en el flujo real del piloto.

### Precondiciones

ADB disponible; pendiente offline; identificar usuario Android QA y job de WorkManager.

### Pasos

Ir a HOME del usuario QA: adb shell am start --user <USER_QA> -a android.intent.action.MAIN -c android.intent.category.HOME. Ejecutar am kill para com.wybix.posmobile y comprobar proceso ausente con ps. Recuperar red; consultar dumpsys jobscheduler. QA puede ejecutar cmd jobscheduler run -f -u <USER_QA> com.wybix.posmobile <JOB_ID_VERIFICADO>. Guardar diagnóstico worker y conteos cloud; repetir trabajo.

### Resultado esperado

Worker headless usa misma base/outbox sin Activity; cloud aumenta exactamente una venta y no aumenta al repetir.

### Evidencia a guardar

Registro BG-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.

## BG-02 — Scheduler real

### Objetivo

Validar scheduler real en el flujo real del piloto.

### Precondiciones

Pendiente offline; app en background/proceso cerrado normalmente, no force-stop.

### Pasos

Recuperar red sin aceleración ADB. Observar a 15/30/60/120 minutos; registrar batería/red/Doze y ejecución real. Abrir app al final para revisar diagnóstico.

### Resultado esperado

Registrar tiempo real y eventual sync único; no prometer ejecución inmediata o SLA que Android no garantiza.

### Evidencia a guardar

Registro BG-02: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 8 — LAN, error y reimpresión

## PRINT-01 — LAN, error y reimpresión

### Objetivo

Validar lan, error y reimpresión en el flujo real del piloto.

### Precondiciones

Impresora ESC/POS LAN con IP fija/puerto 9100 alcanzable, misma red; supervisor.

### Pasos

Configurar IP/puerto; imprimir venta QA. Apagar impresora, realizar otra venta y esperar error/timeout. Revisar print_job pendiente/fallido; encender y reimprimir desde Estado. Comparar folio, ventas, pagos e inventario antes/después.

### Resultado esperado

Venta conservada pese al error; reimpresión del ticket existente, sin checkout ni segundo hecho comercial.

### Evidencia a guardar

Registro PRINT-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.

## PRINT-02 — Permisos y diálogo Android

### Objetivo

Validar permisos y diálogo android en el flujo real del piloto.

### Precondiciones

Operador y supervisor; ticket fallido existente.

### Pasos

Operador intenta configurar impresora: autorizar con PIN supervisor o rechazar. Reimprimir ticket permitido y abrir/cancelar diálogo Android. Si servicio recibe ticket ya impreso, comprobar etiqueta COPY en prueba técnica; no asumir selector de todo el histórico en UI.

### Resultado esperado

Permiso supervisor requerido para configuración; cancelación Android no prueba impresión física; COPY no produce otra venta.

### Evidencia a guardar

Registro PRINT-02: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 9 — Operaciones sensibles

## SHIFT-02 — Operaciones sensibles

### Objetivo

Validar operaciones sensibles en el flujo real del piloto.

### Precondiciones

Operador, supervisor y Owner independientes.

### Pasos

Operador intenta operación sensible, rechaza autorización y comprueba ausencia de efecto. Supervisor autoriza con PIN; Owner realiza acción administrativa tras MFA. Registrar matriz real de permisos que expone cada pantalla.

### Resultado esperado

Cada acción respeta permiso/alcance; PIN supervisor local no sustituye AAL2 Owner; cancelación no ejecuta operación.

### Evidencia a guardar

Registro SHIFT-02: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 10 — Enrolamiento y challenge

## MFA-01 — Enrolamiento y challenge

### Objetivo

Validar enrolamiento y challenge en el flujo real del piloto.

### Precondiciones

Owner QA sin factor; autenticador y recuperación privada.

### Pasos

Enrolar TOTP por QR/secret, sin capturarlos en evidencia. Probar código incorrecto y correcto; verificar AAL2 y acción sensible. Logout/login: repetir challenge y comprobar bloqueo de acciones hasta AAL2.

### Resultado esperado

Factor verificado y challenge posterior; errores no conceden AAL2. Evidencia muestra estado, nunca secret/QR/código.

### Evidencia a guardar

Registro MFA-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.

## MFA-02 — Recuperación y rate limit

### Objetivo

Validar recuperación y rate limit en el flujo real del piloto.

### Precondiciones

Códigos de recuperación almacenados en bóveda.

### Pasos

En sesión QA probar cinco códigos inválidos en 15 minutos; registrar rate limit. Tras ventana de recuperación usar un código válido; intentar reutilizarlo, reenrolar TOTP según flujo.

### Resultado esperado

Rate limit real; código de un solo uso, recuperación auditada; no guardar códigos en Git.

### Evidencia a guardar

Registro MFA-02: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 11 — Aprobar y rechazar

## APR-01 — Aprobar y rechazar

### Objetivo

Validar aprobar y rechazar en el flujo real del piloto.

### Precondiciones

Tablet A, Owner A AAL2, acción sensible habilitada.

### Pasos

Tablet solicita autorización; Owner recibe solicitud, realiza MFA, aprueba; tablet consume. Repetir con rechazo y cancelación; comparar movimientos y auditoría.

### Resultado esperado

Aprobada ejecuta una operación; rechazada/cancelada ninguna; se observa circuito tablet → Owner → tablet.

### Evidencia a guardar

Registro APR-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.

## APR-02 — Expiración y pérdida de red

### Objetivo

Validar expiración y pérdida de red en el flujo real del piloto.

### Precondiciones

Solicitud QA pendiente.

### Pasos

Esperar TTL de diez minutos y probar consumo. En otra solicitud cortar red antes/después de decisión, recuperar y revisar estado sin reenviar operación ciegamente.

### Resultado esperado

Expirada no ejecuta; recuperación converge a estado real, sin doble operación.

### Evidencia a guardar

Registro APR-02: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.

## APR-03 — Integridad y scope

### Objetivo

Validar integridad y scope en el flujo real del piloto.

### Precondiciones

Pruebas automáticas de payload/device/idempotencia disponibles.

### Pasos

Revisar resultado automatizado de payload modificado, otra acción/dispositivo, doble consumo y reutilización. Añadir smoke visual con Owner B sin acceso a solicitudes A. No extraer credenciales tablet para ataques manuales remotos.

### Resultado esperado

Automático rechaza alteración/reuso; prueba manual agrega aislamiento visible y flujo real, sin repetir ataques que no aportan evidencia.

### Evidencia a guardar

Registro APR-03: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

Hay cobertura automática local de integridad/persistencia correspondiente; la prueba manual añade interacción entre interfaces y entorno real.


# Paso 12 — Eventos conectados

## NOTIF-01 — Eventos conectados

### Objetivo

Validar eventos conectados en el flujo real del piloto.

### Precondiciones

Worker, Vault/cron y preferencias habilitados en QA.

### Pasos

Cerrar turno con diferencia; revocar dispositivo QA secundario; provocar rechazo/cuarentena con fixture controlado; crear aprobación remota. Revisar outbox/delivery/dedup por evento y canal.

### Resultado esperado

SHIFT_CLOSED incluye diferencia, DEVICE_REVOKED, SYNC_REJECTED, SYNC_QUARANTINED y aprobación conectada; sin notificaciones duplicadas al reintentar.

### Evidencia a guardar

Registro NOTIF-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 13 — Push físico

## NOTIF-02 — Push físico

### Objetivo

Validar push físico en el flujo real del piloto.

### Precondiciones

Owner nativo instalado en teléfono físico, credenciales FCM/Expo y permiso notificaciones.

### Pasos

Registrar token sin exponerlo; enviar evento QA, observar notificación y navegación. Logout: comprobar eliminación/inutilización. Token inválido se prueba con adapter controlado, sin romper credenciales reales. Examinar contenido en pantalla bloqueada.

### Resultado esperado

Recepción física, scope correcto, token inválido desactivado, datos sensibles ausentes. Web/emulador no certifican push físico.

### Evidencia a guardar

Registro NOTIF-02: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 14 — Email

## NOTIF-03 — Email

### Objetivo

Validar email en el flujo real del piloto.

### Precondiciones

Resend, dominio/remitente verificado y buzón QA; secretos fuera de Git.

### Pasos

Enviar cierre/revocación; verificar destinatario/remitente, cuerpo y mensaje recibido. Revisar delivery y proveedor. Probar retry con adapter controlado, sin invalidar key productiva.

### Resultado esperado

Entrega comprobada en buzón; SENT del worker por sí solo no demuestra recepción; retry sin duplicado.

### Evidencia a guardar

Registro NOTIF-03: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 15 — Medianoche y desfase

## DATE-01 — Medianoche y desfase

### Objetivo

Validar medianoche y desfase en el flujo real del piloto.

### Precondiciones

Timezone America/Mexico_City; tablet QA y turno conocido.

### Pasos

Abrir antes de medianoche y vender después. Probar reloj adelantado y atrasado más de cinco minutos, offline y posterior sync; restaurar fecha automática Android al terminar.

### Resultado esperado

Turno conserva business date; desfase detectado según contrato, sin reescribir historial; recuperar red no cambia fecha original.

### Evidencia a guardar

Registro DATE-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 16 — Negativo y reconciliación

## REC-01 — Negativo y reconciliación

### Objetivo

Validar negativo y reconciliación en el flujo real del piloto.

### Precondiciones

Evento QA stock 2, transferencia real; no usar stock productivo.

### Pasos

Offline vender 3 unidades y sincronizar para saldo -1. Owner revisa producto/causa; cerrar turnos y resolver transferencias pendientes. Cerrar evento, reconciliar con AAL2 y motivo de 5–200 caracteres; repetir solicitud y revisar ledger/auditoría.

### Resultado esperado

Ajuste +1 del EVENT, reconciliación trazable, sin retorno ficticio a Base ni ajuste duplicado. Hechos tardíos obligan revisar estado.

### Evidencia a guardar

Registro REC-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

Hay cobertura automática local de integridad/persistencia correspondiente; la prueba manual añade interacción entre interfaces y entorno real.


# Paso 17 — Corte ciego sin inferencia

## SHIFT-03 — Corte ciego sin inferencia

### Objetivo

Validar corte ciego sin inferencia en el flujo real del piloto.

### Precondiciones

Turno con ventas conocidas; operador y supervisor.

### Pasos

Cajero abre cierre y explora Estado, tickets, historial y resúmenes accesibles. Comprobar si puede reconstruir esperado a través de importes/listados. Supervisor consulta detalle permitido.

### Resultado esperado

PASS solo si cajero no puede inferir esperado desde ninguna ruta accesible; registrar FAIL si tickets/otra pantalla permiten deducirlo, aunque cierre oculte resumen.

### Evidencia a guardar

Registro SHIFT-03: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 18 — Revocación

## HW-01 — Revocación

### Objetivo

Validar revocación en el flujo real del piloto.

### Precondiciones

Dispositivo y usuario QA prescindibles; otra tablet no requerida por licencia principal.

### Pasos

Vender offline antes de revocar; Owner revoca dispositivo. Intentar nueva venta después de revocación y sincronizar. Probar usuario inactivo tras publicar snapshot actualizado.

### Resultado esperado

Política distingue eventos anteriores/posteriores a revoked_at; posteriores en cuarentena/rechazo. Usuario desactivado se bloquea tras actualización, no se promete revocación instantánea sin red.

### Evidencia a guardar

Registro HW-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 19 — Suspensión y reinicio

## HW-02 — Suspensión y reinicio

### Objetivo

Validar suspensión y reinicio en el flujo real del piloto.

### Precondiciones

Tablet QA, pendientes y registro de batería/red.

### Pasos

Apagar pantalla, suspender, cambiar Wi-Fi, perder/recuperar red y reiniciar Android. Desbloquear tras reinicio y observar recuperación. Probar batería baja/Doze cuando reproducible; restaurar ajustes.

### Resultado esperado

Pendientes persistentes y sync sin duplicados; documentar demoras del scheduler y primer desbloqueo, sin prometer trabajo durante force-stop.

### Evidencia a guardar

Registro HW-02: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 20 — Actualización compatible

## UPDATE-01 — Actualización compatible

### Objetivo

Validar actualización compatible en el flujo real del piloto.

### Precondiciones

Segundo APK QA autorizado, mismo applicationId/llave y versionCode mayor; canal separado para OTA si se utiliza.

### Pasos

Instalar actualización sobre app QA con datos existentes; revisar PIN/turno/outbox. Comparar firma/runtimeVersion/channel. OTA solo compatible y en entorno autorizado; no publicar a producción para probar.

### Resultado esperado

Datos conservados; runtime incompatible no recibe OTA. Si no existe segundo artefacto, PENDIENTE, no PASS.

### Evidencia a guardar

Registro UPDATE-01: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Paso 21 — Cierre del piloto

## HW-03 — Cierre del piloto

### Objetivo

Validar cierre del piloto en el flujo real del piloto.

### Precondiciones

Todos los casos ejecutados con evidencia depurada.

### Pasos

Revisar matriz y defectos. Exigir ausencia de duplicados/pérdida, permisos/scope/MFA correctos, impresión física y push/email real, scheduler observado, APK firmado y backend compatible. Registrar responsables y gates pendientes.

### Resultado esperado

Cerrar solo con criterios críticos PASS; hardware ausente queda IMPLEMENTADO / VALIDACIÓN FÍSICA PENDIENTE y fase parcialmente lista.

### Evidencia a guardar

Registro HW-03: fecha, entorno, versión, conteos/estados relevantes y captura o comprobante depurado; nunca secretos.

### PASS / FAIL

**PENDIENTE**. PASS cuando se observa todo el resultado esperado; FAIL si se incumple. Registrar defecto y responsable. Un caso bloqueado conserva PENDIENTE y motivo.

### Observaciones

La implementación y evidencia local son antecedentes; este caso agrega instalación, comportamiento visible, proveedor o hardware real.


# Fuera de alcance

Bluetooth: **FUERA DE ALCANCE ACTUAL**. Mercado Pago: **MANUAL / FUERA DE INTEGRACIÓN DIRECTA**; registrar cobro manual no demuestra integración terminal-POS.

# Matriz final

| ID | Área | Caso | Resultado esperado | Estado | Evidencia |
|---|---|---|---|---|---|
| INST-01 | Paso 0 | Preparación | Material identificado; ninguna base o cuenta productiva se usa. | PENDIENTE | Por registrar |
| INST-02 | Paso 1 | Instalación limpia | Pantalla de enrolamiento, sin sesión/turno/ventas anteriores; no pide permisos ajenos a su función. | PENDIENTE | Por registrar |
| LIC-01 | Paso 2 | Crear escenarios y actores | Dos empresas aisladas, cada una multi + COMMERCE/BASE + MOBILE_POS, vigencia QA 14 días; entitlements efectivos revisados antes del enrolamiento. | PENDIENTE | Por registrar |
| LIC-02 | Paso 2 | Enrolamiento y límites | Una tablet operativa; código no reutilizable; cupo adicional rechazado. MultiCaja no equivale a tablets ilimitadas. | PENDIENTE | Por registrar |
| LIC-03 | Paso 2 | Scope, Demo y Trial | B no ve/modifica A. Demo prueba Windows, no Mobile. Trial sin mobile_pos/temporary_locations no permite piloto integral. | PENDIENTE | Por registrar |
| PIN-01 | Paso 3 | Acceso | Acceso solo con PIN correcto; roles conservados; error no revela PIN. | PENDIENTE | Por registrar |
| PIN-02 | Paso 3 | Bloqueo | Bloqueo persistente durante cinco minutos y recuperación según política; reinicio de app no evade el límite. | PENDIENTE | Por registrar |
| SHIFT-01 | Paso 4 | Turno y fecha | Un solo turno; fecha anclada al turno; apertura/cierre idempotentes; cajero captura contado sin esperado. | PENDIENTE | Por registrar |
| SALE-01 | Paso 5 | Venta normal | Una venta, un pago, un descuento de stock; cambio 25; folio estable y saldo 1. | PENDIENTE | Por registrar |
| OFF-01 | Paso 6 | Venta offline persistente | Datos cifrados persistentes; una aplicación cloud por event_uuid, sin doble venta/pago/inventario. | PENDIENTE | Por registrar |
| OFF-02 | Paso 6 | Force-stop | Android suspende trabajo tras force-stop hasta reapertura; apertura recupera pendientes. No confundir con background o proceso cerrado normal. | PENDIENTE | Por registrar |
| BG-01 | Paso 7 | Proceso cerrado con herramienta QA | Worker headless usa misma base/outbox sin Activity; cloud aumenta exactamente una venta y no aumenta al repetir. | PENDIENTE | Por registrar |
| BG-02 | Paso 7 | Scheduler real | Registrar tiempo real y eventual sync único; no prometer ejecución inmediata o SLA que Android no garantiza. | PENDIENTE | Por registrar |
| PRINT-01 | Paso 8 | LAN, error y reimpresión | Venta conservada pese al error; reimpresión del ticket existente, sin checkout ni segundo hecho comercial. | PENDIENTE | Por registrar |
| PRINT-02 | Paso 8 | Permisos y diálogo Android | Permiso supervisor requerido para configuración; cancelación Android no prueba impresión física; COPY no produce otra venta. | PENDIENTE | Por registrar |
| SHIFT-02 | Paso 9 | Operaciones sensibles | Cada acción respeta permiso/alcance; PIN supervisor local no sustituye AAL2 Owner; cancelación no ejecuta operación. | PENDIENTE | Por registrar |
| MFA-01 | Paso 10 | Enrolamiento y challenge | Factor verificado y challenge posterior; errores no conceden AAL2. Evidencia muestra estado, nunca secret/QR/código. | PENDIENTE | Por registrar |
| MFA-02 | Paso 10 | Recuperación y rate limit | Rate limit real; código de un solo uso, recuperación auditada; no guardar códigos en Git. | PENDIENTE | Por registrar |
| APR-01 | Paso 11 | Aprobar y rechazar | Aprobada ejecuta una operación; rechazada/cancelada ninguna; se observa circuito tablet → Owner → tablet. | PENDIENTE | Por registrar |
| APR-02 | Paso 11 | Expiración y pérdida de red | Expirada no ejecuta; recuperación converge a estado real, sin doble operación. | PENDIENTE | Por registrar |
| APR-03 | Paso 11 | Integridad y scope | Automático rechaza alteración/reuso; prueba manual agrega aislamiento visible y flujo real, sin repetir ataques que no aportan evidencia. | PENDIENTE | Por registrar |
| NOTIF-01 | Paso 12 | Eventos conectados | SHIFT_CLOSED incluye diferencia, DEVICE_REVOKED, SYNC_REJECTED, SYNC_QUARANTINED y aprobación conectada; sin notificaciones duplicadas al reintentar. | PENDIENTE | Por registrar |
| NOTIF-02 | Paso 13 | Push físico | Recepción física, scope correcto, token inválido desactivado, datos sensibles ausentes. Web/emulador no certifican push físico. | PENDIENTE | Por registrar |
| NOTIF-03 | Paso 14 | Email | Entrega comprobada en buzón; SENT del worker por sí solo no demuestra recepción; retry sin duplicado. | PENDIENTE | Por registrar |
| DATE-01 | Paso 15 | Medianoche y desfase | Turno conserva business date; desfase detectado según contrato, sin reescribir historial; recuperar red no cambia fecha original. | PENDIENTE | Por registrar |
| REC-01 | Paso 16 | Negativo y reconciliación | Ajuste +1 del EVENT, reconciliación trazable, sin retorno ficticio a Base ni ajuste duplicado. Hechos tardíos obligan revisar estado. | PENDIENTE | Por registrar |
| SHIFT-03 | Paso 17 | Corte ciego sin inferencia | PASS solo si cajero no puede inferir esperado desde ninguna ruta accesible; registrar FAIL si tickets/otra pantalla permiten deducirlo, aunque cierre oculte resumen. | PENDIENTE | Por registrar |
| HW-01 | Paso 18 | Revocación | Política distingue eventos anteriores/posteriores a revoked_at; posteriores en cuarentena/rechazo. Usuario desactivado se bloquea tras actualización, no se promete revocación instantánea sin red. | PENDIENTE | Por registrar |
| HW-02 | Paso 19 | Suspensión y reinicio | Pendientes persistentes y sync sin duplicados; documentar demoras del scheduler y primer desbloqueo, sin prometer trabajo durante force-stop. | PENDIENTE | Por registrar |
| UPDATE-01 | Paso 20 | Actualización compatible | Datos conservados; runtime incompatible no recibe OTA. Si no existe segundo artefacto, PENDIENTE, no PASS. | PENDIENTE | Por registrar |
| HW-03 | Paso 21 | Cierre del piloto | Cerrar solo con criterios críticos PASS; hardware ausente queda IMPLEMENTADO / VALIDACIÓN FÍSICA PENDIENTE y fase parcialmente lista. | PENDIENTE | Por registrar |
