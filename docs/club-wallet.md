# Tarjeta del Club en Apple Wallet y Google Wallet

Piloto: el primer negocio con addon de marca (`tarjetaWallet`). El núcleo no nombra clientes.

## Qué hace

- **En caja**, con un cliente elegido, «Tarjeta en Wallet» pide a la nube el pase de ese cliente (uno por
  empresa y teléfono) y enseña su enlace como QR: en el diálogo del cajero y en la **pantalla del
  cliente**, que es donde el cliente lo escanea. También se puede copiar el enlace.
- **El enlace** (`/club-wallet/p/<serial>?k=<llave>`) da el `.pkpass` a un iPhone y manda a «Guardar en
  Google Wallet» a un Android. En otro equipo responde las dos opciones en JSON.
- **El pase** enseña el nombre del negocio, el socio, sus puntos, sus tarjetas de sellos (hasta 4 en el
  frente) y su membresía con vigencia, con los colores y el logo del addon. Sin addon, colores de Wybix.
- **Se actualiza solo**: cada movimiento de puntos o sellos, cambio de membresía, de configuración o de
  marca marca el pase como pendiente; el ciclo `notificar` (pg_cron, cada minuto) recalcula lo que
  enseña y, si cambió, avisa a cada iPhone (APNs) y actualiza el objeto de Google.
- **La caja lo escanea**: el QR dice `WXC-<serial>` (sin teléfono). Venta (escáner de teclado o buscador
  de clientes) y Touch (escáner físico) lo resuelven a su cliente: primero en la base local (sin
  internet; los pases bajan con `club_pull`), y si no está, preguntando a la nube.

## Piezas

| Dónde | Qué |
|---|---|
| `supabase/migrations/20261028120000_club_wallet.sql` | tablas `club_wallet_marcas`, `club_wallet_pases`, `club_wallet_dispositivos`; triggers de cambio; RPC `club_wallet_*`; `club_pull` + `wallet_passes`; job `wybix-club-wallet` (inactivo) |
| `supabase/functions/_shared/wallet-firma.ts` | DER/CMS (firma PKCS#7 separada), ZIP, PNG, JWT RS256 — sin dependencias |
| `supabase/functions/_shared/club-wallet.ts` | pass.json, `.pkpass`, clase/objeto y JWT de Google, web service de PassKit, ciclo de avisos |
| `supabase/functions/club-wallet/index.ts` | la Edge Function (APNs con el certificado del pase) |
| POS `0066_club-wallet.sql` | `club_wallet_passes` + `sp_club_wallet_apply / _resolve / _customer` |
| POS `electron/ipc/club.js` | `club:wallet-emitir`, `club:wallet-resolver` |
| POS `src/app/club-cliente/club-wallet.component.ts` | el diálogo y el logo del addon a PNG |

## Pruebas

```bash
node --test supabase/functions/_shared/test/club-wallet.test.ts
```
15 pruebas: certificados de PRUEBA hechos en memoria (CA que hace de WWDR + «Pass Type ID»), `.pkpass`
(ZIP, manifest SHA-1, firma CMS verificada con la llave y con `openssl cms -verify`), JWT de Google
verificado con la llave pública, rutas de PassKit (registro, `passesUpdatedSince`, `If-Modified-Since`,
baja), ciclo de avisos (APNs 410 da de baja el token, PATCH a Google) y falla cerrada.

```bash
WYBIX_PRUEBA_CONTENEDOR=wybix-club-wallet-prueba node scripts/probar-fase3.mjs
```
Cadena completa en Postgres desechable con los grants por omisión de Supabase; la migración se aplica dos
veces; `club.test.sql` + `club-wallet.test.sql` (WAL01–WAL17). F3-APR02 ya fallaba antes de este cambio.

En el POS: `npm run test:club-wallet` y `npm run e2e:club-wallet`.

## Lo que falta del lado del dueño de la cuenta (en orden)

### 1. Apple (necesita Apple Developer Program, 99 USD/año)

1. developer.apple.com → Certificates, IDs & Profiles → Identifiers → **Pass Type IDs** → `+`.
   Ejemplo: `pass.mx.com.wybixpos.club`. Anota también el **Team ID** (arriba a la derecha).
2. En ese Pass Type ID → **Create Certificate**. Genera la CSR en una Mac (Acceso a Llaveros) o con OpenSSL:
   ```bash
   openssl req -new -newkey rsa:2048 -nodes -keyout pass.key -out pass.csr -subj "/CN=Wybix Club"
   ```
   Sube `pass.csr`, descarga `pass.cer` y conviértelo:
   ```bash
   openssl x509 -inform DER -in pass.cer -out pass.pem
   ```
   (Si lo exportaste de Llaveros como `.p12`: `openssl pkcs12 -in pass.p12 -clcerts -nokeys -out pass.pem` y
   `openssl pkcs12 -in pass.p12 -nocerts -nodes -out pass.key`. La función acepta PKCS#8 y PKCS#1.)
3. Descarga el intermedio **Apple WWDR G4** (apple.com/certificateauthority, «Worldwide Developer
   Relations - G4») y conviértelo: `openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem`.
4. Guarda `pass.key` fuera del repositorio. Nadie más la necesita.

El mismo certificado firma los pases **y** autentica los avisos a APNs (Wallet no acepta llaves `.p8`).
Vence cada año: renovarlo antes y volver a cargar `APPLE_PASS_CERT_PEM` / `APPLE_PASS_KEY_PEM`.

### 2. Google Wallet

1. pay.google.com/business/console → **Google Wallet API** → crear la cuenta emisora. Anota el
   **Issuer ID**.
2. Google Cloud Console → proyecto → habilitar **Google Wallet API** → IAM → **Cuentas de servicio** →
   crear una → Claves → **Agregar clave JSON**.
3. En la consola de Wallet → Usuarios → invita el correo de la cuenta de servicio como **Desarrollador**.
4. Mientras la cuenta está en modo demostración, solo las cuentas de Google agregadas como usuarios de
   prueba pueden guardar el pase. Para clientes reales: **Solicitar acceso de publicación** (Google
   revisa la clase; las clases se crean `UNDER_REVIEW`).

### 3. Secretos de la función (Supabase)

```bash
supabase secrets set WALLET_SECRET="$(openssl rand -base64 48)"
supabase secrets set APPLE_PASS_TYPE_ID=pass.mx.com.wybixpos.club APPLE_TEAM_ID=XXXXXXXXXX
supabase secrets set APPLE_PASS_CERT_PEM="$(cat pass.pem)" APPLE_PASS_KEY_PEM="$(cat pass.key)" APPLE_WWDR_PEM="$(cat wwdr.pem)"
supabase secrets set GOOGLE_WALLET_ISSUER_ID=3388000000000000000 GOOGLE_WALLET_SA_JSON="$(cat cuenta-servicio.json)"
```
- `WALLET_SECRET` deriva el token de Apple y la llave del enlace de cada pase. **Cambiarlo invalida
  todos los pases y enlaces emitidos**: generarlo una vez y no rotarlo sin plan.
- `WEBHOOK_SECRET` ya existe (lo usan las notificaciones); el ciclo de la tarjeta usa el mismo.
- Opcional `WALLET_PUBLIC_URL` (ver paso 6). Sin él, `SUPABASE_URL/functions/v1/club-wallet`.
- Falla cerrado: sin `WALLET_SECRET` todo responde 503; Apple o Google a medias se quedan apagados y el
  registro dice qué falta (nunca los valores). Un certificado que no es del Pass Type ID apaga Apple.

### 4. Desplegar

```bash
supabase db push        # aplica 20261028120000_club_wallet.sql
supabase functions deploy club-wallet --no-verify-jwt
```
`--no-verify-jwt` es obligatorio: llaman Apple, el teléfono del cliente y pg_cron. Cada ruta trae su
propia prueba (credencial del equipo, `ApplePass <token>`, llave del enlace o `WEBHOOK_SECRET`).

### 5. Ciclo de avisos

En Vault: `wybix_wallet_url` = `https://<proyecto>.supabase.co/functions/v1/club-wallet` (el
`wybix_webhook_secret` ya existe). Después de probar un pase de verdad, activar el job:
```sql
select cron.alter_job((select jobid from cron.job where jobname = 'wybix-club-wallet'), active := true);
```
El job no llama a nadie si no hay pases pendientes.

### 6. Proxy de la web (wybix-landing)

La caja llama funciones por `https://www.wybixpos.com.mx/backend/functions/v1/<función>`; el rewrite de
`vercel.json` tiene lista cerrada. Agregar `club-wallet` a esa lista (solo POST de la caja). Si además
se quiere que el enlace del cliente y el web service de Apple usen el dominio de Wybix, agregar
`/backend/functions/v1/club-wallet/:ruta*` → `.../functions/v1/club-wallet/:ruta*` y poner
`WALLET_PUBLIC_URL=https://www.wybixpos.com.mx/backend/functions/v1/club-wallet`. Supabase sirve
`text/html` como texto, así que una página bonita del enlace tendría que vivir en la web.

### 7. Caja

Publicar la versión del POS con la migración 0066 (y el addon con `tarjetaWallet`). La caja necesita la
nube activa para emitir; reconocer un pase ya bajado funciona sin internet.

## Límites conocidos

- Un pase por **teléfono**: un cliente sin teléfono de 10 dígitos no puede tener tarjeta (igual que el
  Club en varias sucursales).
- Si un aviso a APNs falla (no 410), el pase queda al día en la nube y el iPhone lo toma en su siguiente
  consulta; no se reintenta el aviso.
- Apple no muestra más de 4 tarjetas de sellos en el frente; el resto va al reverso.
- `club_wallet_estado` suma el libro por teléfono con un índice por expresión; con miles de movimientos
  por cliente convendría un saldo materializado.
- La función nunca se ha ejecutado en el runtime de Deno de Supabase (no hay Deno en este equipo): las
  pruebas corren la lógica en Node. `Deno.createHttpClient` (APNs) se valida en el primer despliegue.
