# Release EAS — build interno y firma existente

Actualizado: 2026-10-05. El propietario confirmó que EAS, el keystore definitivo y un APK productivo previo ya existían. Una consulta vacía no prueba su inexistencia. Se verificaron las credenciales remotas existentes y se solicitó un nuevo production-apk interno después del smoke positivo del backend. No se ejecutó submit ni publicación OTA.

La huella SHA-256 remota coincide con el certificado del JKS definitivo local: `62:0A:EF:3E:79:3E:31:E0:FD:C5:78:BB:A2:74:3E:77:18:91:2A:9C:5A:4B:61:B3:60:86:16:E3:0D:53:13:51`. No se generó ni reemplazó una llave. La lectura local del certificado se hizo sin contraseña; prueba coincidencia de certificado, no integridad del almacén ni firma del APK final.

El primer build `eb4b9500-e364-4246-a7d4-e7f3adc402b3` falló en CONFIGURE_EXPO_UPDATES antes de Gradle por huellas distintas. El diff mostró 200 módulos de configuración presentes solo en Windows y plataformas implícitas diferentes. `scripts/fingerprint-windows.cjs`, ejecutado en postinstall, normaliza las rutas del loader de @expo/fingerprint 0.15.5 antes de aplicar sus exclusiones previstas. app.json declara android/ios explícitamente. Se conserva runtimeVersion policy fingerprint y sus fuentes nativas; no se desactivó el control de compatibilidad. Documentación consultada: [SDK 54 Fingerprint](https://docs.expo.dev/versions/v54.0.0/sdk/fingerprint/) y [corrección upstream de estabilidad Windows](https://github.com/expo/expo/pull/46196). Segundo build solicitado; verificar su resultado antes de declarar APK listo.

El archivo de EAS se inspeccionó localmente: cero archivos de backup bajo .secrets y cero JKS/PEM/KEY/P12. EAS creó el canal/branch pos-production durante la solicitud; no se publicó una actualización.

## Artefacto terminado y verificado

[Build 20b1a630-2a35-475f-ab52-2e78ab7b97ce](https://expo.dev/accounts/davidcasillas/projects/wybix-pos-mobile/builds/20b1a630-2a35-475f-ab52-2e78ab7b97ce): FINISHED, 2026-10-05 07:36:14 UTC. APK descargado localmente bajo .secrets/backup-fase3-20261004-232515/wybix-pos-mobile-fase3-production.apk, 120465293 bytes. SHA-256: `21CBF079C797198D1457E6CB11B8B78DA400443D0371197CDFBBF860627DC164`.

apksigner PASS, firma v2 y certificado SHA-256 coincidente con la llave definitiva. aapt: com.wybix.posmobile, versionName 0.1.0, versionCode 1, minSdk 24 (Android 7), targetSdk 36; arm64-v8a, armeabi-v7a, x86, x86_64. El recurso expo_runtime_version usa file:fingerprint y el asset assets/fingerprint contiene `6895f7b5917621db7e90e2fb8f79c7a45ee1e915`, idéntico al runtime de EAS. AndroidManifest y assets/app.config confirman pos-production, perfil produccion y backend https://www.wybixpos.com.mx/backend.

El build declara HEAD 774c8151ca76153df3dfc34ed2b752e85fcad008 y se envió con cambios de trabajo incluidos; no equivale a una reproducción de ese commit limpio. La corrección de Fingerprint y la configuración revisada permanecen en el working tree. No se hizo un cuarto commit ni push.

MFA/Auth remotos: cuenta sintética QA, TOTP real, AAL1/AAL2, decisión/consumo único de aprobación y recuperación Edge de un uso PASS (20 comprobaciones en la última ejecución). Las pruebas visuales de Owner/autenticador, impresión, recepción push/email, Doze y actualización permanecen manuales.

El piloto físico está preparado: se revocó la tablet virtual ya sincronizada mediante Owner AAL2, se liberó su cupo Mobile y se generó un código nuevo de un uso/24 horas para la tablet real. La cajera QA, su PIN y el acceso Owner están en DATOS-PILOTO-PRIVADO.txt bajo la misma carpeta protegida. El factor temporal del smoke se retiró; el responsable enrola su autenticador en la UI de Owner. Ese correo sintético no recibe email; para la recepción se requiere un buzón QA real autorizado.

## Configuración comprobada

| Campo | Valor |
|---|---|
| Proyecto / owner | wybix-pos-mobile / davidcasillas |
| projectId | 6bbce3fd-963f-468c-a973-245a1f9995e1 |
| applicationId | com.wybix.posmobile |
| Expo SDK | 54.0.0 |
| version / versionCode | 0.1.0 / 1 |
| runtimeVersion | policy fingerprint; valor concreto se obtiene del build |
| updates URL | https://u.expo.dev/6bbce3fd-963f-468c-a973-245a1f9995e1 |
| profile / channel | production-apk / pos-production |
| Formato / distribución | APK / internal |
| Credentials | remote |
| Node del perfil | 24.19.0 |
| Backend | https://www.wybixpos.com.mx/backend |

Evidencia: cierre-operativo/expo-production.json, eas-builds.json y eas-channels.json. Producción deshabilita cleartext y backup; usa SQLCipher. La versión Android mínima se verifica en el APK mediante aapt, no se deduce solo de SDK Expo.

## Gates anteriores al build

1. Backend aplicado y smoke real PASS a través de /backend/functions/v1/pos-sync, incluido enrolamiento, snapshot, PIN, venta y cierre sin duplicados. Auth TOTP, recepción push/email y hardware requieren piloto físico; no se certifican con el smoke Node.
2. Credencial remota existente inspeccionada y certificado comparado: PASS. El JKS permanece ignorado. La firma del nuevo APK solo se certifica después de descargarlo y ejecutar apksigner.
3. Segundo build interno terminado y descargado; firma, hash, package, minSdk, canal, perfil y runtime incorporados verificados. No se publicó en tiendas ni se certifica el piloto físico con estas verificaciones.

## Comandos preparados

Desde apps/pos-mobile, después de resolver los gates:

```powershell
eas project:info
eas credentials --platform android
eas build --platform android --profile production-apk --non-interactive
eas build:list --platform android --limit 5 --json --non-interactive
```

Si el build pide crear llave, detenerse: usar la existente. No ejecutar submit ni publicar OTA. `production` genera AAB y no es el primer artefacto de QA solicitado.

## Verificación del artefacto

Descargar solamente el APK propio emitido por EAS a directorio local ignorado. Registrar buildId, commit, perfil y URL del build sin tokens. Con herramientas Android instaladas:

```powershell
apksigner verify --verbose --print-certs <APK_QA>
aapt dump badging <APK_QA>
Get-FileHash -Algorithm SHA256 -LiteralPath <APK_QA>
```

Exigir firma válida y huella definitiva, applicationId correcto, versión 0.1.0/versionCode 1 para el primer build (o actualización explícita documentada), minSdk compatible con tablet. Confirmar channel y runtimeVersion concreto en metadatos EAS y configuración incorporada; no confundir la política fingerprint con una cadena runtime ya resuelta. Conservar JSON depurado con hash/huella pública/metadatos, no APK en Git.

Instalar desde limpio y ejecutar PRUEBAS-MANUALES-CIERRE-FASE3.md. La prueba de actualización requiere otro artefacto con versionCode mayor y misma llave, o canal QA OTA compatible autorizado. Ninguna publicación productiva se necesita para ese caso.
