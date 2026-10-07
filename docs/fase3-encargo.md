> Fuente: historial local de Claude, 4 de octubre de 2026. Documento de referencia; el repositorio y las pruebas actuales tienen prioridad.



<pasted_content id="3f89">
# WYBIX — EJECUCIÓN DE FASE 3 HASTA CIERRE TÉCNICO

Usa como fuentes de contexto, en este orden:

1. El **WYBIX MASTER CONTEXT**.
2. La **auditoría real de Fase 3 del 4 de octubre de 2026**.
3. El estado actual del repositorio.
4. Las pruebas y evidencia técnica más recientes.

Si existe contradicción entre documentación histórica y código actual:

1. inspecciona el repositorio;
2. revisa pruebas y evidencia reciente;
3. identifica explícitamente la contradicción;
4. toma el estado técnico actual como autoridad;
5. actualiza tu entendimiento de Fase 3.

No conviertas información histórica en obligación actual.

---

# 1. OBJETIVO DE ESTA SESIÓN Y LAS SIGUIENTES

La auditoría ya terminó.

NO vuelvas a hacer una auditoría general de Fase 3 desde cero.

A partir de ahora tu responsabilidad es:

**IMPLEMENTAR, INTEGRAR, PROBAR Y CERRAR TÉCNICAMENTE LA FASE 3 DE WYBIX.**

Trabaja progresivamente sobre los pendientes reales detectados.

No te limites a proponer soluciones.

Cuando un bloque pueda implementarse con la información y acceso disponibles:

**impleméntalo.**

Cuando requiera cambios arquitectónicos:

1. inspecciona primero el sistema existente;
2. explica brevemente la arquitectura elegida;
3. implementa;
4. prueba;
5. documenta evidencia;
6. actualiza el estado del bloque.

No declares un bloque terminado solamente porque exista código relacionado.

---

# 2. DIVISIÓN DE RESPONSABILIDADES: CLAUDE VS ASTRA

Esta regla es obligatoria.

## ASTRA ES RESPONSABLE DE DISEÑO

Astra seguirá siendo responsable de:

- lenguaje visual;
- UX;
- jerarquía visual;
- composición;
- dirección visual;
- decisiones de tipografía;
- tokens visuales cuando requieran decisión estética;
- apariencia de componentes;
- comportamiento visual;
- motion visual;
- consistencia visual entre superficies.

El rediseño actual de POS Mobile realizado por Astra:

**NO debe rehacerse.**

No diseñes una nueva aplicación.

No reemplaces el diseño de Astra.

No inventes una tercera dirección visual.

No conviertas esta fase en otro rediseño.

---

## CLAUDE ES RESPONSABLE DE ARQUITECTURA E IMPLEMENTACIÓN

Tu responsabilidad incluye:

- arquitectura;
- dominio;
- backend;
- Supabase;
- seguridad;
- autenticación;
- autorización;
- MFA;
- remote approvals;
- infraestructura de notificaciones;
- push;
- email;
- sincronización;
- código nativo;
- SQLite/SQLCipher;
- impresión;
- permisos;
- auditoría;
- business date;
- reconciliación;
- release;
- EAS;
- QA;
- test harness;
- integración;
- mantenibilidad;
- migraciones;
- observabilidad;
- pruebas;
- documentación técnica.

También eres responsable de implementar técnicamente las decisiones de diseño que Astra defina.

---

# 3. REGLA ESPECIAL PARA EL DESIGN SYSTEM

La auditoría encontró actualmente dos fuentes de verdad:

- `apps/pos-mobile/components/ui.tsx`
- `@wybix/ui`

Existen componentes equivalentes, tokens divergentes y diferencias entre Mobile, Owner y POS Windows.

Esto debe corregirse.

PERO:

**NO decidas unilateralmente la dirección visual final.**

Primero prepara para Astra un informe técnico de consolidación.

Debe incluir como mínimo:

### Inventario

Para cada componente duplicado o relacionado:

- nombre;
- ubicación;
- consumidores actuales;
- props;
- variantes;
- estados;
- accesibilidad;
- dependencias;
- comportamiento;
- diferencias funcionales;
- diferencias visuales.

Revisa especialmente:

- `Boton`
- `Teclado`
- `Tarjeta`
- `Aviso`
- `Puntos`
- `BarraSync`
- tokens `pos`
- tokens `tipo`
- `Pantalla`
- `Sheet`
- `Pulse`
- `Aparece`
- `MotionProvider`
- `Encabezado`
- `Autorizar`
- `Escaner`
- `Acceso`

### Tokens actuales

Documenta:

- colores;
- tipografías;
- spacing;
- radios;
- sombras;
- estados;
- tamaños;
- touch targets;
- iconografía;
- motion.

Compara técnicamente:

- POS Windows;
- Owner;
- POS Mobile;
- `@wybix/ui`;
- `components/ui.tsx`.

No asumas que una tipografía histórica sigue siendo la oficial.

La evidencia actual del repositorio manda.

### Resultado que debes entregar a Astra

Prepara una propuesta técnica, no estética, con:

- qué debe existir como componente compartido;
- qué debe permanecer específico de Mobile;
- qué duplicaciones existen;
- qué componentes tienen diferencias funcionales legítimas;
- qué API pública debería conservarse;
- qué consumidores deberán migrarse;
- riesgos de la migración;
- pruebas necesarias;
- qué decisiones requieren definición visual de Astra.

Luego espera la definición visual cuando realmente sea necesaria.

Cuando Astra haya definido esa parte:

**tú implementas la consolidación técnica.**

Regla:

> Un diseño de Astra no se considera técnicamente cerrado mientras existan dos fuentes de verdad para componentes equivalentes.

---

# 4. ESTADO INICIAL DE FASE 3

Parte de este estado, pero comprueba el repositorio antes de cambiarlo.

## CERRADO / NO REIMPLEMENTAR

Fase 2A está técnicamente aprobada.

No vuelvas a implementar desde cero:

- PIN Android nativo;
- compatibilidad scrypt;
- operación offline existente;
- outbox;
- idempotencia existente;
- sincronización con aplicación abierta;
- persistencia tras force-stop;
- migración 0052;
- template SQLite;
- corte a ciegas;
- rechazo cloud;
- RLS ya validado;
- licenciamiento ya validado;
- lógica central ya comprobada.

Si necesitas modificar alguna de estas áreas por una dependencia real de Fase 3:

- conserva compatibilidad;
- prueba regresión;
- explica por qué fue necesario.

---

# 5. ESTADO ACTUAL DE LOS GRANDES BLOQUES

Estado esperado al iniciar:

| Área | Estado |
|---|---|
| Design system Mobile | PARCIAL / duplicado |
| EAS | CONFIGURADO / release no validado |
| Hardware físico | PENDIENTE |
| MFA Owner | PENDIENTE |
| Remote approvals | PENDIENTE |
| Push | PARCIAL / heredado |
| Notification engine | PARCIAL |
| Email | PENDIENTE |
| Background sync cerrado | PENDIENTE |
| Reimpresión | PENDIENTE |
| Bluetooth | PENDIENTE |
| Business date | LIMITACIÓN |
| Reconciliación | PARCIAL |
| Mercado Pago | MODELO PARCIAL / integración real pendiente |
| QA harness | DEUDA |

No conviertas esta tabla en verdad permanente.

Actualízala conforme avances.

---

# 6. ORDEN DE EJECUCIÓN

No implementes Fase 3 como features aisladas.

Sigue este orden salvo que una dependencia técnica real justifique alterarlo.

---

## ETAPA 0 — HIGIENE Y BASE SEGURA

Antes de introducir grandes cambios:

### 0.1 Git / build artifacts

Resolver:

- `modules/*/android/build/` generado y no ignorado;
- otros artefactos nativos accidentales;
- revisar `.gitignore`.

No borres nada importante sin confirmar su origen.

---

### 0.2 `app.json` accidental

Revisar el `app.json` de raíz con:

```json
{"expo":{}}
```

Determinar si es accidental.

Si no tiene uso real:

preparar su eliminación.

No hacerlo si existe alguna dependencia no detectada.

---

### 0.3 Configuración Mobile

Revisar:

- permisos duplicados;
- permisos bloqueados duplicados;
- configuración Android;
- EAS;
- runtimeVersion;
- channels;
- updates;
- applicationId.

---

### 0.4 Keystore

El `.jks` no debe permanecer como archivo de trabajo ordinario.

No abras ni expongas su contenido.

Determina:

- ubicación segura;
- estrategia de backup;
- relación con EAS Credentials;
- recuperación futura.

No reemplaces la llave.

La llave actual debe considerarse la candidata definitiva salvo evidencia contraria.

---

### 0.5 Seguridad heredada de push

ANTES de construir el nuevo notification engine:

audita específicamente si el webhook actual está expuesto.

Resolver como mínimo:

- `WEBHOOK_SECRET` obligatorio;
- rotación del secreto actual;
- almacenamiento en Vault/secrets;
- comportamiento fail-closed;
- autenticación del endpoint;
- logs sin secretos.

Si el endpoint actualmente puede quedar público por configuración ausente:

clasifica y corrige antes de ampliar notificaciones.

---

### 0.6 Bases de test peligrosas

Corregir aislamiento de:

- `db:test-demo`
- `db:test-giros`

No deben utilizar nombres reales de Demo Manager.

Usar nombres temporales/aislados inequívocos.

No tocar bases Demo válidas.

---

# 7. ETAPA 1 — RELEASE REAL DE POS MOBILE

EAS ya está configurado.

NO vuelvas a tratar EAS como inexistente.

Verifica:

- `projectId`;
- owner;
- `updates.url`;
- runtimeVersion;
- perfiles;
- version;
- versionCode;
- credentials;
- firma.

El objetivo técnico es recorrer:

**repositorio → EAS → firma → APK production → tablet física**

Actualmente la cadena no está validada.

---

## 7.1 Gate de acciones externas

Puedes preparar código, configuración y verificación local libremente.

No hagas sin autorización explícita:

- commit;
- push;
- deploy;
- publicación;
- acción destructiva;
- rotación irreversible de credenciales;
- cambio irreversible de infraestructura productiva.

Si para continuar necesitas una de estas acciones:

1. deja todo preparado;
2. explica exactamente la acción;
3. indica qué valida;
4. detente solamente en ese gate.

No detengas trabajo que sí pueda continuar independientemente.

---

## 7.2 Validación física requerida

Cuando exista APK válido, la validación en tablet debe cubrir como mínimo:

### Seguridad

- PIN correcto;
- PIN incorrecto;
- bloqueo;
- persistencia del bloqueo;
- rendimiento de scrypt nativo;
- auditoría.

### Venta

- venta normal;
- doble toque;
- error;
- persistencia;
- impresión posterior;
- venta sin impresora.

### Offline

- venta offline;
- cierre de aplicación;
- reapertura;
- pendientes;
- recuperación de red;
- sincronización;
- rechazo cloud;
- exactamente una vez.

### Hardware

- cámara;
- Wi-Fi;
- suspensión;
- reanudación;
- batería;
- almacenamiento;
- force-stop;
- actualización;
- rendimiento.

### Impresión

- LAN;
- falla;
- timeout;
- ticket pendiente.

No consideres emulador equivalente a hardware físico.

---

# 8. ETAPA 2 — CONSOLIDACIÓN TÉCNICA DEL DISEÑO DE ASTRA

Primero prepara el informe indicado en la sección 3.

Astra decide la dirección visual cuando haya decisiones abiertas.

Después implementa técnicamente una única fuente de verdad.

Objetivos:

- eliminar duplicación innecesaria;
- conservar comportamiento actual;
- evitar regresiones;
- conservar accesibilidad;
- conservar touch targets;
- conservar estados offline;
- conservar estados sync;
- conservar estados de error;
- conservar reduced motion.

No hagas una migración masiva sin pruebas.

Migrar por grupos de componentes.

Después de cada grupo:

- typecheck;
- unit;
- pantallas afectadas;
- pruebas funcionales específicas.

---

# 9. ETAPA 3 — MFA OWNER

MFA es requisito para cerrar Fase 3 y dependencia directa de Remote Approvals.

No es requisito para implementar todos los demás bloques.

Implementa un flujo real.

No basta con una pantalla.

Debe cubrir:

- enrolamiento;
- TOTP u opción soportada por la infraestructura actual;
- challenge;
- sesión;
- AAL;
- recuperación;
- revocación;
- rate limiting;
- auditoría;
- errores;
- pérdida del segundo factor;
- cambio de dispositivo.

Revisar protección de:

- licencias;
- compañías;
- claves;
- configuración sensible;
- funciones fiscales;
- remote approvals;
- operaciones administrativas de alto riesgo.

Cuando corresponda, exigir AAL2 tanto:

- en UI;
- como en backend/RLS/function.

Nunca confiar solo en ocultar botones.

---

# 10. ETAPA 4 — NOTIFICATION ENGINE

Primero asegurar push heredado.

Después construir el motor.

Ya existe:

`notification_outbox`

No la reemplaces sin motivo.

Evalúa si debe evolucionar.

El motor debe resolver:

- eventos;
- reglas;
- canales;
- destinatarios;
- company scope;
- location scope;
- user/device scope;
- preferencias;
- idempotencia;
- deduplicación;
- estado;
- intentos;
- retries;
- backoff;
- error permanente;
- auditoría;
- observabilidad.

Diseña el motor para soportar múltiples canales.

No acoples reglas de negocio directamente a Expo Push o al proveedor de email.

Modelo conceptual:

**evento de dominio  
→ regla de notificación  
→ outbox  
→ delivery  
→ provider  
→ receipt/status**

---

# 11. ETAPA 5 — PUSH

Endurecer la infraestructura actual.

Debe cubrir:

- múltiples dispositivos;
- tokens por dispositivo;
- company/location scopes;
- revocación;
- limpieza de tokens inválidos;
- receipts;
- retries;
- backoff;
- deduplicación;
- privacidad;
- errores del proveedor.

No enviar información sensible innecesaria en el texto push.

Los tokens no deben convertirse en autoridad de permisos.

La autorización siempre debe verificarse en backend.

---

# 12. ETAPA 6 — EMAIL

Implementar email como canal del mismo notification engine.

Debe existir:

- proveedor;
- dominio;
- sender;
- templates;
- retries;
- logs;
- delivery status;
- errores permanentes;
- idempotencia;
- auditoría.

No acoples lógica de negocio a un proveedor específico.

Crear una abstracción de entrega razonable, sin sobrearquitectura.

Conectar únicamente eventos realmente definidos.

No inventes nuevas campañas o features.

---

# 13. ETAPA 7 — REMOTE APPROVALS

NO implementar remote approvals productivos antes de tener:

- MFA adecuado;
- authority model;
- notification infrastructure suficientemente estable.

Reutiliza cuando sea correcto:

- `exigir()`;
- permisos existentes;
- `authorized_by`;
- auditoría;
- credencial del dispositivo;
- `notification_outbox`;
- actores administrativos existentes.

El modelo debe cubrir:

- request id;
- operación;
- actor solicitante;
- dispositivo;
- ubicación;
- compañía;
- payload mínimo;
- política requerida;
- estado;
- expiración;
- autorización;
- rechazo;
- cancelación;
- idempotencia;
- auditoría.

Debe prevenir:

- autoautorización cuando la política lo prohíba;
- doble aprobación;
- replay;
- aprobación expirada;
- aprobación para otro dispositivo;
- aprobación para otra ubicación;
- aprobación después de cambiar materialmente la operación.

Diseña explícitamente comportamiento:

### Sin Internet

Una operación que históricamente debe funcionar offline:

NO debe volverse dependiente obligatoriamente de remote approval.

Define políticas separadas:

- autorización local;
- autorización remota;
- operación no permitida offline;
- operación permitida con auditoría posterior.

No destruyas el modelo offline-first.

---

# 14. ETAPA 8 — BUSINESS DATE

Actualmente la fecha depende demasiado del reloj de la tablet.

Debes definir una verdadera autoridad de fecha comercial.

No confundas:

- timestamp;
- timezone;
- device clock;
- business date;
- shift date.

Analiza cómo relacionarla con:

- ubicación;
- timezone;
- turno;
- apertura;
- cierre;
- operación offline;
- sincronización posterior;
- reportes;
- eventos cloud.

Objetivo:

una venta debe conservar una fecha comercial consistente aunque:

- el dispositivo tenga desfase;
- la red desaparezca;
- la sincronización ocurra después;
- la venta cruce medianoche;
- exista un turno abierto.

No cambies retrospectivamente ventas legítimas sin una política explícita.

La tablet debe advertir desfase relevante.

El cloud debe poder detectar inconsistencias.

---

# 15. ETAPA 9 — REIMPRESIÓN Y PERMISOS

Actualmente existen `print_jobs` y tickets fallidos.

Construye reimpresión sin duplicar ventas.

Separar estrictamente:

**transacción**

de

**impresión**

Una reimpresión:

- no registra otra venta;
- no mueve inventario;
- no registra otro pago;
- no modifica el checkout.

Debe usar el ticket/print job existente.

Registrar:

- quién reimprimió;
- cuándo;
- dispositivo;
- resultado;
- error.

También aplicar realmente:

`CONFIGURAR_IMPRESORA`

No basta con que el permiso exista en la matriz.

La capa de datos/servicio debe imponerlo.

No confiar únicamente en UI.

---

# 16. ETAPA 10 — RECONCILIACIÓN DE INVENTARIO

NO construir reconciliación desde cero.

La base ya existe.

Actualmente hay evidencia de:

- eventos;
- validaciones;
- turnos;
- transferencias;
- existencias;
- force close;
- motivo;
- auditoría.

Extiende ese sistema.

Objetivo conceptual:

**detección  
→ causa  
→ producto  
→ diferencia  
→ autorización  
→ ajuste  
→ auditoría**

Mejorar:

- nombres reales de producto;
- desglose de causas;
- diferencias;
- trazabilidad;
- validación server-side del motivo;
- ajuste;
- autorización cuando corresponda;
- relación con sucursal/base correspondiente.

Mantén la decisión:

una venta offline puede producir stock negativo temporal.

No conviertas Mobile en un sistema online obligatorio.

---

# 17. ETAPA 11 — BACKGROUND SYNC REAL

La app abierta ya sincroniza.

No reimplementes ese flujo.

El problema es:

**aplicación completamente cerrada.**

No aceptes como evidencia:

- tarea registrada;
- callback configurado;
- `expo-background-task` existente.

Para declarar terminado este bloque debe demostrarse:

1. existe evento pendiente;
2. app completamente cerrada;
3. existe conectividad;
4. ejecución real en background;
5. evento llega al cloud;
6. se aplica correctamente;
7. exactamente una vez;
8. el estado local converge.

Evalúa:

- WorkManager;
- módulo Android nativo;
- headless execution;
- restricciones Android;
- batería;
- Doze;
- reintentos;
- persistencia.

No fuerces Expo a resolver algo que requiera código nativo.

Mantén compatibilidad con la outbox actual.

---

# 18. ETAPA 12 — QA HARNESS

Implementa la política ya definida:

### QUICK

- typecheck;
- unit tests;
- compilación puntual.

### AFFECTED

Pruebas relacionadas con:

- diff;
- módulos;
- dependencias.

### INTEGRATION

Solo cuando corresponda:

- SQL;
- migraciones;
- sync;
- instalación;
- actualización;
- cloud.

### FULL

Solo:

- release;
- cambios transversales;
- cierre de fase;
- riesgo alto.

Crear scripts claros si aún no existen.

Por ejemplo:

- `test:quick`
- `test:affected`
- `test:integration`
- `test:full`

No confundas `test:quickstart` con `test:quick`.

---

## SQL harness

El problema conocido es la creación repetida de procesos PowerShell.

Optimizar mediante conexión/proceso persistente cuando sea seguro.

No reduzcas cobertura solamente para hacer el test rápido.

Aísla bases de prueba.

Nunca apuntes pruebas destructivas a bases reales de Demo Manager.

---

# 19. ETAPA 13 — BLUETOOTH

Bluetooth no debe asumirse incluido porque LAN funciona.

Implementarlo únicamente si sigue dentro del alcance confirmado de Fase 3.

Debe cubrir:

- discovery;
- selección;
- pairing;
- permisos Android;
- reconexión;
- timeout;
- error;
- impresora desconectada;
- cambio de dispositivo;
- múltiples impresoras si el producto lo requiere;
- integración ESC/POS;
- fallback razonable.

Debe compartir tanto código de impresión como sea práctico con LAN sin forzar una abstracción incorrecta.

---

# 20. ETAPA 14 — MERCADO PAGO

Mercado Pago NO está integrado actualmente.

Existe modelo parcial y pruebas.

No confundas método de pago manual con integración POS-terminal.

Antes de implementar integración real:

determina si sigue siendo requisito de cierre.

Si no es requisito:

clasificar como trabajo posterior y documentarlo.

Si sí es requisito:

implementar:

- API;
- autenticación;
- terminal;
- creación de pago;
- idempotencia;
- estado;
- timeout;
- cancelación;
- callback/webhook;
- conciliación;
- error;
- retry;
- auditoría.

No permitas que un timeout produzca doble cobro.

El estado del pago debe poder reconciliarse con la venta.

---

# 21. TESTING POR CADA CAMBIO

No ejecutes regresión total después de cada modificación.

Para cada cambio:

1. prueba específica;
2. pruebas de dependencias;
3. integración necesaria;
4. ampliar según riesgo.

Si una prueba falla:

1. reproducir;
2. aislar;
3. identificar causa;
4. corregir;
5. repetir la prueba fallida;
6. repetir dependencias;
7. ampliar solo si el riesgo lo justifica.

No ocultes fallas preexistentes.

No atribuyas automáticamente una falla histórica a tu cambio.

---

# 22. REGLA DE COMPLETITUD

Un bloque NO puede pasar a COMPLETO solo porque compile.

Debe existir evidencia suficiente de:

- implementación;
- integración;
- errores;
- autorización;
- seguridad;
- auditoría cuando corresponda;
- pruebas;
- comportamiento real;
- regresión relevante.

Ejemplos:

`MFA UI` ≠ `MFA completo`

`push token` ≠ `push completo`

`background task registrado` ≠ `background sync completo`

`botón reimprimir` ≠ `reimpresión completa`

`EAS configurado` ≠ `release validado`

`modelo Mercado Pago` ≠ `integración Mercado Pago`

---

# 23. ESTADOS OFICIALES

Usa estos estados:

- IMPLEMENTADO Y VALIDADO
- IMPLEMENTADO PARCIALMENTE / VALIDACIÓN PENDIENTE
- DISEÑADO / DECIDIDO PERO NO IMPLEMENTADO
- LIMITACIÓN CONOCIDA
- DEUDA TÉCNICA / FUNCIONAL
- PROPUESTA FUTURA
- DESCARTADO
- HISTÓRICO / SUSTITUIDO

No reduzcas todo a done/todo.

---

# 24. INFORME DE CADA BLOQUE

Al terminar un bloque importante, reporta:

## Estado

Qué estado tenía y cuál tiene ahora.

## Qué cambió

Archivos y componentes relevantes.

## Por qué

Problema real que resuelve.

## Arquitectura

Decisiones tomadas.

## Seguridad

Permisos, scopes, secretos, validaciones.

## Compatibilidad

Qué comportamiento previo se preservó.

## Pruebas

Comandos y resultados.

## Evidencia

Resultado verificable.

## No validado

Qué no pudo comprobarse.

## Pendiente

Qué queda.

## Próximo bloque

Qué continúa y por qué.

---

# 25. NO HACER

No hacer sin autorización explícita:

- commit;
- push;
- deploy;
- publicación;
- acciones destructivas;
- tocar producción innecesariamente;
- eliminar datos;
- regenerar llaves;
- sustituir credenciales definitivas.

Tampoco:

- rehacer el diseño de Astra;
- crear un tercer design system;
- reimplementar Fase 2A;
- convertir cloud en autoridad transaccional del POS;
- eliminar SQLite/SQLCipher para depender de Internet;
- romper ventas offline;
- meter multiempresa dentro de la base local;
- mezclar MultiCaja con multisucursal;
- mezclar multisucursal con multiempresa;
- hardcodear clientes;
- duplicar lógica Retail/Hospitality;
- mover lógica de negocio a pantallas.

---

# 26. CUÁNDO DETENERTE

No te detengas solamente para preguntarme qué hacer después si existe un siguiente paso técnico claro.

Continúa con el siguiente bloque.

Detente únicamente si:

1. requieres autorización explícita para una acción reservada;
2. requieres hardware que no está disponible;
3. requieres credenciales externas;
4. requieres una decisión de producto real;
5. requieres una definición visual de Astra;
6. encuentras riesgo serio de pérdida de datos;
7. encuentras una contradicción arquitectónica que pueda causar una decisión irreversible.

Cuando ocurra:

explica el gate con precisión.

No uses preguntas genéricas.

Ejemplo correcto:

“Para validar el APK production necesito ejecutar el build EAS usando las credenciales configuradas. El código y configuración ya están preparados. Esta acción generará un artefacto remoto firmado pero no hará deploy. Necesito autorización para ejecutarla.”

---

# 27. CRITERIO DE CIERRE DE FASE 3

No declares Fase 3 cerrada hasta que los bloques obligatorios hayan alcanzado:

**IMPLEMENTADO Y VALIDADO**

o hayan sido explícitamente sacados del alcance por decisión de producto.

Como mínimo, para cierre técnico revisa:

- higiene del repositorio;
- release firmado;
- hardware físico;
- consolidación técnica del design system definida con Astra;
- MFA Owner;
- notification engine;
- push seguro;
- email;
- remote approvals;
- business date;
- reimpresión;
- permisos;
- reconciliación;
- background sync;
- QA harness.

Bluetooth y Mercado Pago dependen de alcance explícito.

---

# 28. AL FINAL DE FASE 3

Ejecuta la regresión apropiada de cierre.

Entrega exactamente:

# 1. VEREDICTO FINAL

Una de:

- NO LISTA PARA CIERRE
- PARCIALMENTE LISTA
- LISTA PARA CIERRE TÉCNICO
- LISTA PARA CIERRE DEL PILOTO
- FASE 3 CERRADA

# 2. MATRIZ FINAL

| Área | Estado | Riesgo | Evidencia | Pendiente |

# 3. IMPLEMENTADO EN FASE 3

Solo implementación real.

# 4. DECISIONES ARQUITECTÓNICAS

Qué quedó establecido como arquitectura oficial.

# 5. SEGURIDAD

MFA, secretos, permisos, scopes, push, remote approval.

# 6. POS MOBILE

Release, hardware, offline, background, impresión, business date.

# 7. DESIGN SYSTEM

Qué definió Astra y cómo quedó consolidado técnicamente.

# 8. QA

Suites, tiempos, harness y evidencia.

# 9. LIMITACIONES RESTANTES

Solo limitaciones reales.

# 10. TRABAJO FUERA DE ALCANCE

Por ejemplo Mercado Pago/Bluetooth si se decidió posponerlos.

# 11. EVIDENCIA DE CIERRE

Pruebas y resultados.

# 12. ACCIONES QUE REQUIEREN MI AUTORIZACIÓN

Commit, push, deploy, publicación u otras acciones reservadas.

---

# 29. REGLA FINAL

Tu objetivo ya no es responder:

“¿Qué falta para Fase 3?”

Eso ya fue auditado.

Ahora tu objetivo es:

**llevar Wybix desde el estado auditado actual hasta el cierre técnico real de Fase 3, respetando las decisiones existentes, el trabajo visual de Astra, la arquitectura offline/local-first y las políticas de seguridad y validación del proyecto.**

Empieza por inspeccionar únicamente lo necesario para la **ETAPA 0**, confirma que los hallazgos de higiene siguen vigentes y comienza a resolverlos.

No vuelvas a producir una auditoría completa antes de empezar.
</pasted_content id="3f89">
