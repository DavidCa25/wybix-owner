# Descargas de clientes — 7 de octubre de 2026

Ambos APK están publicados en el repositorio público [wybix-apps](https://github.com/DavidCa25/wybix-apps/releases/tag/android-20261007). Se verificó la descarga anónima desde los mismos enlaces que codifica el POS, el formato APK y los hashes de los assets públicos de GitHub.

- [Wybix Owner](https://swlpspgmkwzlrowllvvj.supabase.co/functions/v1/app-download?app=owner): 97 687 294 bytes, Android package com.wybix.pos, versionName 1.0.0, versionCode 5. Build EAS 536f884d-dab7-4329-b254-23650a455e97. SHA-256 c4ca8b874105e61b9133866a00233760a740281b132e71118142cac91f5a056d.
- [Wybix POS Mobile](https://swlpspgmkwzlrowllvvj.supabase.co/functions/v1/app-download?app=mobile): 120 465 293 bytes. Conserva el APK productivo de Fase 3 previamente verificado. SHA-256 21cbf079c797198d1457e6cb11b8b78da400443d0371197cdfbbf860627dc164.

Owner recupera la identidad com.wybix.pos comprobada en el release de julio (commit d6779d6abec0bead786b13ebd22a9e3a08fde814). La configuración reciente com.wybix.owner no tenía credenciales. Se confirmó y reutilizó la configuración EAS original Build Credentials 226vL9NIHA, certificado SHA-256 845d2aa982e8916d9c885f7414f87c36ac95a41bf1f5ce361e855795ba117d92; apksigner verificó el APK nuevo. Esto conserva la firma de distribución directa anterior; no prueba coincidencia con una firma distinta administrada por Google Play.

Se configuraron únicamente las variables públicas de Supabase en el proyecto EAS Owner para producción. Ambas se encontraron dentro del bundle compilado. El runtime b74b4cb79eeddef63b0f0608de962e651f2d6014 coincide con el asset de fingerprint. No se distribuyó un development client y no se requiere Expo Go.

La función app-download es pública por diseño, admite GET/HEAD y una lista cerrada owner/mobile; responde 400 ante un destino arbitrario y 405 ante POST. Redirige a un release inmutable de instaladores. No consulta la base de datos, no recibe códigos de emparejamiento y no modifica autorizaciones. No requiere migración SQL. Se desplegó únicamente esta función adicional, sin modificar las funciones operativas o el cron.

La firma y la presencia de configuración se probaron sobre el binario. Las pruebas físicas de MFA, notificaciones, impresora y segundo plano conservan su estado pendiente anterior; esta publicación de descargas no las convierte en aprobadas. No se ejecutó submit a Google Play/App Store ni una actualización OTA.

Fuente: HEAD 199c83f y cambios de configuración incluidos desde el working tree. No afirmar reproducción de un commit limpio. Los secretos, respaldos, llaves privadas y datos del piloto permanecen locales y excluidos de los releases.

Para instalar: cámara → QR de descarga → APK → permitir instalación desde el navegador cuando Android lo solicite → abrir la app. Después Owner se vincula con la invitación del negocio. POS Mobile recibe un código de 24 h desde Owner → Eventos → evento → Tablets → Agregar tablet, con MFA y cupo disponible.
