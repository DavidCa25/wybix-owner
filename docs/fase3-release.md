# Fase 3 · Release real de POS Mobile

> Complementa `fase2-release.md`. Estado al 2026-10-04.

## Estado verificado

| Pieza | Estado | Cómo se verificó |
|---|---|---|
| Proyecto EAS | `6bbce3fd-963f-468c-a973-245a1f9995e1`, owner `davidcasillas` | `app.json` (`eas init` ya corrido) |
| OTA | `updates.url` = `https://u.expo.dev/6bbce3fd-…`; `runtimeVersion` por fingerprint | `npx expo config --type public` con `WYBIX_PERFIL=produccion` |
| Paquete y versión | `com.wybix.posmobile`, `0.1.0`, `versionCode 1` | ídem |
| Perfil de producción | `production-apk`: canal `pos-production`, `credentialsSource: remote`, sin tráfico en claro | `eas.json` y la config resuelta |
| Permisos | `CAMERA`, `INTERNET`, `ACCESS_NETWORK_STATE`; 6 bloqueados (estaban **duplicados**, ya no) | `app.json` |
| Llave de firma | Generada en EAS; el respaldo `@davidcasillas__wybix-pos-mobile.jks` está en `apps/pos-mobile/` (ignorado por `*.jks`) | Nombre del archivo de descarga de EAS; **no se abrió** |
| Builds en EAS | **0** | `eas build:list` (solo lectura) |
| Canales OTA | **0** (nacen con el primer build o update) | `eas channel:list` |
| Backend de producción | `https://www.wybixpos.com.mx/backend` → rewrite de `wybix-landing/vercel.json` a `…supabase.co/functions/v1/pos-sync` | `vercel.json` |
| **Nube de producción** | **Sin la Fase 1 ni la Fase 2** (`fase1-nube.md`: «No desplegado»). `pos-sync` v1 de producción no conoce eventos, tablets ni enrolamiento | `supabase functions list` (solo lectura) |

## Custodia de la llave (Etapa 0.4)

- **La llave de verdad vive en EAS** (`credentialsSource: remote`). Cada build
  de `production-apk` la usa desde ahí; el archivo local **no se necesita
  para compilar**.
- El `.jks` local es el **respaldo de recuperación**. Si EAS lo perdiera o se
  cambiara de cuenta, solo con él se pueden firmar actualizaciones para las
  tablets ya instaladas.
- Lo que falta hacer (**tú**, no se puede automatizar sin exponer la llave):
  1. Guarda el `.jks` y sus contraseñas en el gestor de secretos de la
     empresa. EAS muestra las contraseñas en `eas credentials -p android` →
     Keystore → *Show*; el archivo no las trae dentro.
  2. Anota ahí mismo: alias, fecha y la huella SHA-256 del certificado
     (`keytool -list -v -keystore <archivo>`, la misma que mostrará el APK
     firmado: `apksigner verify --print-certs`).
  3. Confirma que el respaldo abre (con `keytool`) **antes** de borrar la
     copia local.
  4. Borra `apps/pos-mobile/@davidcasillas__wybix-pos-mobile.jks` del árbol de
     trabajo. El `.gitignore` ya cubre `*.jks` y `*.keystore`, pero un archivo
     de llave no debe vivir junto al código.
- **No se regenera.** Es la candidata definitiva: ninguna tablet tiene todavía
  un APK firmado, así que sigue siendo la primera y única.

## Gate de la Etapa 1: dos caminos

Validar en hardware necesita un APK firmado **y** una nube que hable Fase 2.
Hoy la nube de producción no la habla, así que un `production-apk` instalado
en una tablet no podría enrolarse. Hay dos caminos:

| | A · Desplegar Fase 1 + 2 en producción | B · Proyecto de staging |
|---|---|---|
| Qué es | `supabase db push` de las migraciones de la Fase 1 y 2 (más la 3) y deploy de `pos-sync`, `link-owner`, `fiscal-*` según `fase1-nube.md` | Un proyecto de Supabase nuevo para pruebas, con toda la cadena de migraciones |
| APK | `production-apk` (canal `pos-production`) | `preview-apk` con `WYBIX_BACKEND` apuntando a staging |
| Riesgo | Toca producción: los POS de Windows actualizados dependen de la Fase 1 | Ninguno sobre clientes; cuesta un proyecto más |
| Valida | La cadena completa real | Todo menos la nube real |

**Recomendación técnica: B primero.** La validación física y la de la nube se
separan, y el despliegue a producción se hace después con evidencia. En los
dos casos el build es el mismo comando:

```bash
cd apps/pos-mobile
npx eas-cli@latest build -p android --profile preview-apk
```

`preview-apk` usa la misma llave remota, así que la huella del certificado se
valida igual que en producción.

Cuando exista el APK, la lista de validación física es la de la sección 7.2
del encargo de la Fase 3: seguridad, venta, offline, hardware e impresión.
