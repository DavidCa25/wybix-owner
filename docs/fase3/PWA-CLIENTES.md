# Wybix en iPhone, iPad y navegador

Las dos aplicaciones tienen una versión web instalable, sin App Store ni Expo Go:

- Owner: https://wybix-owner.expo.app
- POS Mobile: https://wybix-pos-mobile.expo.app

En Safari abre el enlace, toca Compartir → Agregar a pantalla de inicio y abre Wybix desde el icono. Instala antes de vincular: Safari y la app instalada pueden usar almacenamientos distintos. Usa Safari actualizado y un perfil normal, no navegación privada.

## Descargar y vincular

En el POS Windows 1.3.2: Inicio → Apps → Owner o POS Mobile → Android / iPhone / iPad · Web. El primer QR abre el instalador o la web. El segundo paso vincula el negocio y mantiene las autorizaciones existentes.

Los enlaces estables de app-download admiten platform=web o platform=android. Sin plataforma, reconocen iPhone/iPad por User-Agent y mantienen el APK para los demás clientes. En iPad con navegación de escritorio, selecciona explícitamente la opción Web. Un QR público de descarga nunca contiene la invitación privada del negocio.

Owner: vincula con la invitación generada por un administrador del POS. En web puedes usar cámara, captura del QR o pegar el contenido. La invitación sigue siendo de un solo uso; leer el QR no concede acceso por sí solo. Puedes iniciar sesión con una cuenta existente.

POS Mobile: Owner → Eventos → evento → Tablets → Agregar tablet, con MFA y cupo disponible. Ingresa el código de 24 horas en la app instalada; necesitas Internet para enrolar y obtener el catálogo inicial. Cada instalación/perfil es un dispositivo distinto y consume su propio cupo. Los PIN y roles son los mismos del personal asignado.

## Funcionamiento y límites

POS Mobile conserva la lógica de ventas, cobros, inventario, turnos y sincronización. SQLite se ejecuta mediante WASM; las transacciones guardan un snapshot AES-GCM cifrado en IndexedDB antes de confirmar éxito. La llave es un CryptoKey no exportable del navegador. No es SQLCipher ni una llave del hardware del teléfono. Un bloqueo Web Locks permite un solo escritor por origen/perfil. Ante falta de almacenamiento la escritura se revierte y se informa el error.

Abre la app con Internet al menos una vez y espera a que termine la instalación de sus recursos. Después POS Mobile puede abrir y operar con el catálogo ya descargado sin conexión. Owner conserva la apertura de su interfaz; sus consultas y operaciones de nube necesitan Internet. No afirmar que Owner permite administrar datos sin conexión.

Mantén POS Mobile abierta para sincronizar. El navegador no garantiza tareas en segundo plano. Antes de borrar datos de Safari, quitar el icono o cambiar de perfil, verifica en Estado que no haya ventas pendientes; el sistema puede desalojar almacenamiento y la petición de persistencia no garantiza conservarlo. No compartas un perfil de navegador entre personas que no deban acceder a ese dispositivo.

En web la impresión usa el diálogo del navegador y una impresora compatible con el sistema. No hay conexión TCP directa a una impresora térmica ni confirmación de impresión física. El ticket conserva su estado pendiente para reimprimir; un fallo o una cancelación de impresión no vuelve a registrar la venta. Android mantiene la impresión nativa.

Owner web no registra tokens Expo Push. Las autorizaciones y avisos se consultan dentro de la aplicación; esta entrega no añade Web Push. Las verificaciones físicas de iPhone/iPad, impresora y notificaciones siguen pendientes. No se publicó ninguna app en App Store.

## Construcción y publicación

Desde la raíz de wybix-owner:

    npm run build:pwa:owner
    npm run build:pwa:pos

Cada exportación genera manifest, iconos, instalación y service worker. Solo se precargan archivos estáticos de la aplicación; ninguna respuesta de Auth, API ni datos de clientes se agrega al Cache Storage. Las actualizaciones esperan a que se cierren todas las ventanas de la versión anterior; no se recarga durante una venta.

Desde apps/owner o apps/pos-mobile:

    eas deploy --prod --non-interactive

El script incorpora únicamente EXPO_PUBLIC_SUPABASE_* de .env. No incorporar service_role ni secretos a variables EXPO_PUBLIC. La distribución web se publica con EAS Hosting y las URLs estables se resuelven con app-download. Este cambio no modifica contratos SQL y no requiere migración remota.

## Validación

TypeScript de los workspaces y 94 pruebas Node correctas. Electron: dos pruebas reales del menú Apps, Android/Web para ambas apps, acceso de cajera y autorización administrativa, foco, navegación y tamaños de ventana.

Chromium: manifest, service worker, apertura inicial y recarga sin conexión de ambas apps. WebKit: acceso real de Owner, validación manual del QR y lectura desde imagen; POS: snapshot cifrado recuperado al detener el servidor HTTP y recargar, tres registros decimales exactos, claves foráneas, transacciones serializadas, reversión de escritura fallida y bloqueo de segunda pestaña. Chromium también confirmó acceso por PIN, apertura de turno y una venta completa de $25.00 sin conexión, conservada al recargar, en un perfil con fixture aislado y sin enviar datos a la nube. Son pruebas de motores de navegador, no una instalación física desde Safari en un iPhone.

La suite SQL de Fase 3 no se pudo repetir porque Docker Desktop estaba apagado. No se cambiaron migraciones ni funciones operativas de Fase 3; los resultados SQL anteriores no se presentan como una ejecución nueva.

Para repetir la prueba de almacenamiento: después de exportar POS Mobile, ejecuta node scripts/probar-pwa-almacenamiento.cjs con Playwright/WebKit disponible (o PLAYWRIGHT_MODULE apuntando a su módulo). Usa localhost:6177, un perfil nuevo y detiene el origen HTTP para comprobar la recarga sin conexión. No usa cuentas ni datos de clientes.
