# Wybix POS Mobile · release, firma y versiones

> Nada de esto se ha publicado. Ni Google Play, ni App Store, ni OTA a
> producción. Esta guía es para cuando se autorice.

## Identidad de la app

| | POS Mobile | Owner |
|---|---|---|
| applicationId / bundle | `com.wybix.posmobile` | `com.wybix.owner` |
| Proyecto EAS | **pendiente** (`eas init` lo crea; requiere la cuenta de Expo de Wybix) | `09e1e7fb-…` (existente) |
| Canales OTA | `pos-preview`, `pos-production` | `preview`, `production` |
| Versión | SemVer en `app.json` (`version`) + `versionCode` entero | `appVersionSource: remote` |
| runtimeVersion | política `fingerprint` | política `fingerprint` |

Los canales de POS Mobile llevan el prefijo `pos-` para que **un OTA de Owner
nunca llegue a una tablet** (y al revés). `runtimeVersion: fingerprint` impide
que un OTA llegue a un binario con módulos nativos distintos.

## Perfiles (`apps/pos-mobile/eas.json`)

| Perfil | Salida | Canal | Uso |
|---|---|---|---|
| `preview-apk` | APK interno | `pos-preview` | piloto en tablets propias |
| `production-apk` | APK interno firmado con la llave definitiva | `pos-production` | instalación directa en ferias |
| `production` | AAB | `pos-production` | Google Play (cuando se autorice) |

Todos con `WYBIX_PERFIL=produccion`: solo HTTPS (`usesCleartextTraffic=false`),
backend de Wybix, sin la pantalla de medición (`/spike`), `allowBackup=false` y
permisos mínimos: se quitan `SYSTEM_ALERT_WINDOW`, `READ/WRITE_EXTERNAL_STORAGE`,
`USE_BIOMETRIC`, `USE_FINGERPRINT` y `RECORD_AUDIO`.

### Primera vez (requiere la cuenta de Expo)

```bash
cd apps/pos-mobile
npx eas-cli@latest init                 # crea el proyecto y escribe extra.eas.projectId
npx eas-cli@latest update:configure     # escribe updates.url (canales pos-*)
npx eas-cli@latest credentials -p android   # "Set up a new keystore" (EAS) y luego "Download" para el respaldo
npx eas-cli@latest build -p android --profile production-apk
```

## Llave de firma (keystore)

- **Una sola llave de por vida** para `com.wybix.posmobile`. Si se pierde, las
  tablets no pueden actualizarse: hay que desinstalar (y se pierde lo no
  sincronizado).
- Recomendado: **EAS administra la llave** (`credentialsSource: remote`), se
  genera en el primer build y vive cifrada en Expo.
- Custodia:
  1. Al crearla, descargar un respaldo (`eas credentials` → Android →
     *Download keystore*) y guardarlo en el gestor de secretos de la empresa
     (no en el repo, no en el correo, no en este reporte).
  2. Dos personas con acceso al gestor; nadie más.
  3. Anotar en el gestor: alias, fecha, huella SHA-256 del certificado
     (`keytool -list -v`), quién la generó.
  4. Para Google Play: activar *Play App Signing*; la llave de EAS queda como
     llave de subida.
- El repo NUNCA contiene `*.jks`, `*.keystore`, `credentials.json` ni
  contraseñas. `apps/*/android/` está en `.gitignore` (se regenera con prebuild).

Los APK de prueba de esta fase están firmados con la llave de **depuración** de
Android: sirven solo para el emulador.

## Versiones mínimas (`app_releases`)

```sql
-- publicar 0.2.0 y exigir al menos 0.1.3
update public.app_releases
   set latest_version = '0.2.0', min_supported_version = '0.1.3', published_at = now()
 where app = 'pos-mobile' and channel = 'production';
```

La tablet lo recibe en el snapshot. Con una versión menor a la mínima **no abre
turno nuevo** (sí puede cerrar el abierto y sincronizar lo pendiente: nada se
pierde por actualizar tarde).

## Build local en Windows (solo pruebas)

- Ruta larga: el C++ de React Native supera 260 caracteres en
  `RelWithDebInfo`. Para un build local se usa una carpeta corta para la
  compilación nativa (`externalNativeBuild.cmake.buildStagingDirectory`) en el
  `android/` generado. EAS compila en Linux y no tiene este límite.
- `subst` NO sirve: Metro no sigue los enlaces de los workspaces a otra unidad.
