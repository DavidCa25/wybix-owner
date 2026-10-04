# Release EAS preparado — ejecución pendiente

Fecha: 2026-10-04. No existe todavía un build Android EAS ni un canal creado en la cuenta consultada. El APK local de desarrollo validó integración nativa; no certifica firma productiva ni proveedores físicos.

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

1. Desplegar por etapas PLAN-DEPLOY.md con autorización explícita y pasar smokes de COMPATIBILIDAD-MOBILE.md. Verificar ruta pública /backend/functions/v1/pos-sync, enrolamiento real y contrato; revisar Auth TOTP y FCM para Owner.
2. Verificar en `eas credentials --platform android` la credencial existente. Solo inspeccionar: no generar ni reemplazar llave. Comparar huella SHA-256 con referencia del keystore definitivo mediante operación privada del responsable. El archivo .jks permanece ignorado; no copiar contraseñas ni contenido al informe. **Huella remota todavía no certificada.**
3. Confirmar cuota de build y autorización del entorno. No se genera APK final con backend incompatible.

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
