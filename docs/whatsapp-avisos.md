# Avisos por WhatsApp al cliente final

Dos avisos, uno por cada cosa que el cliente quiere saber sin preguntar:

| Aviso | Cuándo sale | Quién lo dispara |
|---|---|---|
| **Pedido listo** | Las comandas de un pedido de mostrador quedan LISTAS y el cliente dejó teléfono | La caja principal (POS 0068) → función `whatsapp-avisos` |
| **Membresía por vencer** | X días antes de `paid_until` (1–15, lo elige el negocio), entre 9:00 y 21:00 de la sucursal | El ciclo `notificaciones` (pg_cron, cada minuto; el planeador trabaja una vez por hora) |
| **Membresía vence hoy** | El día de `paid_until`, entre 9:00 y 21:00 | Igual |

El negocio enciende o apaga cada aviso en **Configuración → Nube y cuenta →
Avisos por WhatsApp** (POS). Sin ajustes guardados, **todo está apagado**.

**Los avisos salen desde el número de WhatsApp de cada negocio** (opción B):
el cliente ve el nombre y la foto del negocio, sus respuestas le llegan al
negocio y Meta le cobra al negocio. Cada negocio conecta su número una vez,
desde esa misma pantalla, con el *Embedded Signup* de Meta; Wybix es **Tech
Provider**.

## Cómo funciona

```
CONECTAR (una vez por negocio)
caja principal ─► whatsapp-avisos {conexion: iniciar} ─► wa_conexiones (sha256, 30 min)
   │  abre en el navegador  <web>/whatsapp/conectar#t=<secreto>
   ▼
página ─► FB.login (Embedded Signup) ─► code + waba_id + phone_number_id
   ▼
whatsapp-conectar ─► canjea el code (token del negocio) ─► suscribe la app a su WABA
                 ─► registra el número ─► da de alta las 4 plantillas
                 ─► wa_conexion_guardar (token y PIN cifrados con AES-GCM)

AVISAR
KDS / tablet / otra caja marca LISTA
        │  (barrido cada 15 s + aviso inmediato al cambiar una comanda)
        ▼
POS: sp_whatsapp_pedido_candidatos ─► sp_whatsapp_pedido_job RESERVAR
        │  id del aviso = llave de idempotencia
        ▼
whatsapp-avisos (credencial del equipo) ─► wa_pedido_listo ─► wa_messages
        │  manda en el acto, por el número           unique(company, kind, ref_key)
        │  y con el token de ESE negocio
        ▼
Meta Cloud API ─► webhook whatsapp-webhook ─► wa_estado (entregado/leído/falló)
                                          ├─► wa_baja (botón, BAJA, ALTA; por el número que recibió)
                                          ├─► wa_cuenta_plantillas (aprobada/rechazada/pausada)
                                          └─► wa_cuenta_estado (el negocio quitó a Wybix)

pg_cron ─► notificaciones ─► wa_planear_membresias ─► wa_tomar ─► proveedor ─► wa_resultado
```

- **Sin duplicados.** Un pedido tiene una bandera en la caja
  (`dbo.whatsapp_pedido_avisos`) y un `id` que la nube usa como `ref_key`
  único. Una membresía usa `<membresía>:<paid_until>`: renovar cambia
  `paid_until` y abre un ciclo nuevo de avisos.
- **Opt-out.** `wa_optouts` por negocio y teléfono. Se revisa al encolar y otra
  vez justo antes de enviar. El cliente se da de baja con el botón del mensaje,
  respondiendo BAJA/ALTO/STOP o pidiéndolo en caja; ALTA lo reactiva. Como
  cada negocio tiene su número, la baja es **del negocio cuyo número recibió
  la respuesta** (`metadata.phone_number_id`), sin adivinar.
- **Sin número no sale nada.** Un negocio sin cuenta `ACTIVA` recibe
  `SIN_NUMERO` y nada se encola; una plantilla que Meta no ha aprobado en SU
  WABA da `PLANTILLA_PENDIENTE` (el «pedido listo» con enlace cae a la
  plantilla sin enlace si esa sí está aprobada). Si Meta rechaza el token
  (#190) la cuenta pasa a `ERROR` y la caja pide volver a conectar.
- **Token del negocio.** Se guarda cifrado (AES-256-GCM) en
  `wa_cuentas.token_cifrado`; la llave `WHATSAPP_CLAVE_TOKENS` solo existe en
  los secretos de las funciones. La caja nunca lo ve. Desconectar (o que el
  negocio quite a Wybix en Meta) lo borra.
- **Registro.** Cada aviso queda en `wa_messages` con su estado: `PENDING`,
  `SENDING`, `SENT`, `DELIVERED`, `READ`, `FAILED` o `SKIPPED` (motivo:
  `OPT_OUT`, `VENCIDA`, `DESACTIVADO`, `SIN_NUMERO`). La caja lo ve con el teléfono
  enmascarado (`•••5678`).
- **Vigencia.** Un «pedido listo» vale 30 minutos en la nube (y la caja no lo
  intenta si quedó listo hace más de 20). Un aviso de membresía vale 24 h.
- **Falla cerrado.** Sin `WHATSAPP_PROVEEDOR`, sin `WHATSAPP_CLAVE_TOKENS` o
  (con Meta) sin `WHATSAPP_APP_ID`/`WHATSAPP_APP_SECRET`/`WHATSAPP_CONFIG_ID`
  no hay proveedor ni conexión: la caja no ofrece «Conectar», nada sale y el
  planeador de membresías ni corre. El webhook sin sus secretos responde 503.

### Proveedor simulado

`WHATSAPP_PROVEEDOR=simulado` (con `WHATSAPP_CLAVE_TOKENS`) marca los avisos
como enviados (`provider = 'simulado'`) sin salir a internet, y la página de
conexión muestra «Simular conexión» en lugar de Facebook: conecta un número
falso con las cuatro plantillas aprobadas. La pantalla del POS lo dice («Modo
de prueba»). Sirve para probar todo el flujo antes de tener cuenta de Meta. **No
dejarlo en producción con clientes reales**: el negocio vería «Enviado» sin que
nadie reciba nada.

## Número: el de cada negocio (opción B, implementada)

Se decidió el 2026-10-28. La opción A (un número de Wybix compartido) quedó
descartada y su código se quitó.

**Costo.** Meta cobra **por mensaje de plantilla entregado** y se lo cobra **al
negocio** (la forma de pago está en su WABA; Wybix no paga ni revende). Para
México, categoría **Utilidad** (la de estos avisos), alrededor de **US$0.0085
por mensaje** (≈ MXN $0.16). **Marketing** cuesta alrededor de US$0.0397: si
Meta reclasifica una plantilla como marketing, sube casi 5×. Por eso los
textos no llevan nada promocional y, si Meta pasa una a Marketing, Wybix la
marca `MARKETING` y **no la usa**. Las tarifas cambian por trimestre:
confirmar en la página de precios de Meta.

Estimado para el piloto (I Do Nut): 100 pedidos al día con teléfono → ~3,000
mensajes/mes ≈ **US$25.5/mes**; 200 socios del Club → ~400/mes ≈ **US$3.4/mes**.

- A favor: el cliente ve el nombre y la foto del negocio; sus respuestas le
  llegan al negocio; Meta factura al negocio; la calidad de un número no
  afecta a los demás negocios.
- En contra: Wybix tiene que ser **Tech Provider** (revisión de la app por
  Meta, una vez). Cada negocio necesita una cuenta de Facebook que lo
  administre, un número que **no** esté en la app de WhatsApp y una forma de
  pago en Meta. Las plantillas se aprueban por cada WABA (las da de alta Wybix
  al conectar; Meta tarda de minutos a horas).

## Plantillas (las da de alta Wybix en la WABA de cada negocio)

Nadie las escribe a mano: al conectar, `whatsapp-conectar` crea las que falten
en la WABA del negocio (`POST /{waba}/message_templates`) y la caja, al tocar
«Revisar», vuelve a preguntar por las que siguen en revisión y crea las que no
se pudieron crear. El texto vive en `PLANTILLAS` de `_shared/whatsapp.ts`;
**si cambia aquí, cambia allá**.

Las cuatro van en **categoría Utilidad**, **idioma Español (MEX) `es_MX`**, con:

- **Pie de página:** `Responde BAJA si ya no quieres recibir estos avisos.`
- **Botón de respuesta rápida (uno):** `Ya no recibir avisos`
  (la función le pone el payload `BAJA:<id del aviso>`; no lleva texto variable).

Los nombres son **exactamente** estos: la base los usa tal cual.

**1. `wybix_pedido_listo`** — 2 variables (número del día, negocio)

```
¡Hola! Tu pedido *#{{1}}* en *{{2}}* ya está listo. Pasa a recogerlo al mostrador.
```
Ejemplo para Meta: `{{1}}` = `27`, `{{2}}` = `I Do Nut`

**2. `wybix_pedido_listo_seguimiento`** — 3 variables (número, negocio, enlace)

```
¡Hola! Tu pedido *#{{1}}* en *{{2}}* ya está listo. Si estás conectado al Wi-Fi del local, puedes verlo aquí: {{3}} Pasa a recogerlo al mostrador.
```
Ejemplo: `{{3}}` = `http://192.168.1.20:8787/p/0123456789ABCDEF0123456789ABCDEF`

**3. `wybix_membresia_por_vencer`** — 4 variables (plan, negocio, fecha, cómo renovar)

```
Hola. Tu membresía *{{1}}* en *{{2}}* vence el {{3}}. Para renovarla: {{4}}. Si ya la renovaste, ignora este mensaje.
```
Ejemplo: `Club Donut`, `I Do Nut`, `31/10/2026`, `paga tu mensualidad en caja`

**4. `wybix_membresia_vence_hoy`** — 3 variables (plan, negocio, cómo renovar)

```
Hola. Tu membresía *{{1}}* en *{{2}}* vence hoy. Para renovarla: {{3}}. Si ya la renovaste, ignora este mensaje.
```

Si Meta rechaza alguna, el motivo más común es la categoría: no agregar
«promociones», «descuento» ni emojis de venta.

## Pasos del usuario (en orden)

**Una vez, a nombre de Wybix** (nada de esto está hecho ni desplegado):

1. **Meta Business de Wybix**: en business.facebook.com, usar o crear el
   portafolio de Wybix y **verificar la empresa** (RFC, comprobante de
   domicilio).
2. **App de Meta**: en developers.facebook.com, crear una app tipo *Business*
   con los productos **WhatsApp** y **Facebook Login for Business**. Anotar el
   **App ID** y el **App secret** (*App settings → Basic*).
3. **Tech Provider**: en el panel de la app, completar los pasos para ser Tech
   Provider y pedir **acceso avanzado** (App Review) a
   `whatsapp_business_management` y `whatsapp_business_messaging`. Meta pide
   un video del flujo: grabar la caja → «Conectar WhatsApp» → la página → la
   ventana de Facebook → el aviso que llega. Mientras no se apruebe, solo
   funciona con cuentas que administra la propia app (sirve para el piloto).
4. **Configuración de Embedded Signup**: *Facebook Login for Business →
   Configurations → Create*, variante **WhatsApp Embedded Signup**, con esos
   dos permisos. Anotar el **Configuration ID**.
5. **Dominio de la página**: en *Facebook Login for Business → Settings*,
   agregar el dominio de la web a *Allowed domains for the JavaScript SDK* y
   activar *Login with the JavaScript SDK*. Hoy:
   `https://wybix-landing.vercel.app` (y el dominio definitivo cuando exista).
6. **Webhook de la app** (uno para todos los negocios): *WhatsApp →
   Configuration → Webhook*: URL
   `https://<proyecto>.supabase.co/functions/v1/whatsapp-webhook`, token de
   verificación = `WHATSAPP_VERIFY_TOKEN`. Suscribir los campos **messages**,
   **message_template_status_update** y **account_update**.
7. **Secretos en Supabase** (*Project Settings → Edge Functions → Secrets*):

   | Secreto | Valor |
   |---|---|
   | `WHATSAPP_PROVEEDOR` | `meta` (o `simulado` para probar) |
   | `WHATSAPP_CLAVE_TOKENS` | `openssl rand -base64 32`. **Cambiarla invalida los tokens guardados**: cada negocio tendría que volver a conectar |
   | `WHATSAPP_APP_ID` | paso 2 |
   | `WHATSAPP_APP_SECRET` | paso 2 (también firma el webhook) |
   | `WHATSAPP_CONFIG_ID` | paso 4 |
   | `WHATSAPP_VERIFY_TOKEN` | una cadena aleatoria de 32+ caracteres que inventes |
   | `WHATSAPP_CONECTAR_URL` | opcional; por defecto `https://wybix-landing.vercel.app/whatsapp/conectar` |
   | `WHATSAPP_GRAPH_VERSION` | opcional, por defecto `v23.0` |

8. **Desplegar** (cuando se autorice):

   ```
   supabase db push                      # aplica 20261028140000_whatsapp_avisos.sql
   supabase functions deploy whatsapp-avisos --no-verify-jwt
   supabase functions deploy whatsapp-conectar --no-verify-jwt
   supabase functions deploy whatsapp-webhook --no-verify-jwt
   supabase functions deploy notificaciones --no-verify-jwt
   ```
   Publicar la web (`wybix-landing`, rama `feature/whatsapp-conectar`: página
   `/whatsapp/conectar` y el rewrite de `whatsapp-conectar` en `vercel.json`)
   y el POS con la migración 0068.
9. **Ciclo de notificaciones**: el job `wybix-notificaciones` de pg_cron se
   creó INACTIVO en Fase 3. Las membresías y los reintentos dependen de él:
   confirmar que esté activo (`select active from cron.job where jobname =
   'wybix-notificaciones'`) y con `wybix_notif_url` y `wybix_webhook_secret`
   en Vault.

**Por cada negocio** (el piloto: I Do Nut):

10. En la caja principal: **Configuración → Avisos por WhatsApp → Conectar
    WhatsApp**. Se abre el navegador; el dueño entra con su Facebook, elige o
    crea su cuenta de WhatsApp Business, agrega el número (lo verifica por SMS
    o llamada) y termina. El enlace dura 30 minutos y sirve una vez.
11. En **WhatsApp Manager** (business.facebook.com), el negocio agrega su
    **forma de pago**. Sin ella Meta no entrega las plantillas.
12. De vuelta en la caja: «Ya terminé, revisar». Esperar las cuatro
    plantillas en «Aprobada», encender los avisos y probar con un teléfono del
    equipo: un pedido listo y una membresía que venza en 3 días.

## Consentimiento (responsabilidad del negocio)

WhatsApp exige que el cliente haya aceptado recibir mensajes. Pedir el teléfono
«para avisarte por WhatsApp cuando tu pedido esté listo» y al afiliar al Club
cubre esto. El opt-out ya está resuelto en los tres caminos (botón, BAJA, caja).
El negocio es el remitente y el responsable de ese consentimiento ante Meta.

## Advertencias

- **El enlace de seguimiento solo abre dentro del Wi-Fi del local.** Es el del
  Local Host (`http://<ip-local>:<puerto>/p/<código>`), sin túnel ni nube, y
  `qr-pantalla-cliente.js` lo tiene apagado en pantalla
  (`SEGUIMIENTO_INDIVIDUAL = false`). Por eso hay dos plantillas: sin Local
  Host se manda la que no lleva enlace, y la que lo lleva lo dice. Un
  seguimiento público en la nube sería otro trabajo.
- **Solo pedidos de mostrador** (con número del día). Una mesa no se avisa.
- **Cliente del pedido = `hosp_cuentas.customer_id`.** Si en caja no se asigna
  cliente, no hay teléfono y no hay aviso.
- **El número no puede estar en la app de WhatsApp.** Al conectar, Wybix lo
  registra en la Cloud API con un PIN de dos pasos propio (guardado cifrado).
  Meta tiene un modo «coexistencia» (app de WhatsApp Business + API en el
  mismo número) que **no** está implementado ni probado aquí.
- **Un número, un negocio.** Si ese número ya está conectado a otro negocio de
  Wybix, la conexión se rechaza (`NUMERO_OCUPADO`).
- **Membresías: `paid_until` es el último día pagado.** «Vence hoy» se manda
  ese día. Los días de gracia del plan no cambian el aviso.

## Punto de extensión: pedidos en línea (menú QR, 0067)

El aviso se engancha al **estado de la comanda**, no a una tabla de pedidos:

- Si el pedido en línea termina en `hosp_cuentas` con `numero_dia` y
  `customer_id`, el aviso sale **sin cambios**.
- Si vive en otra tabla, se agrega su fuente en
  `sp_whatsapp_pedido_candidatos` con `UNION ALL`, devolviendo las mismas
  columnas (`cuenta_id`, `numero_dia`, `telefono`, `aviso_id`, `status`,
  `attempts`, `lista_en`), y su propia bandera.
- En la nube nada cambia: `wa_pedido_listo` recibe `{ id, numero, telefono,
  url }`. Un `url` público (https) del menú QR cabe en la plantilla con enlace.

## Pruebas

- `node --test supabase/functions/_shared/test/whatsapp.test.ts` (26): entorno
  que falla cerrado, cifrado, envío por el número y token de cada negocio,
  Graph (canje, suscripción, registro, plantillas, reclasificación a
  Marketing), ciclo, función de la caja (enlace de un solo uso, estado,
  desconectar), página de conexión (enlace vencido, fallo a medio camino) y
  webhook (firma, estados, bajas por número, plantillas, cuenta quitada).
- `npm run test:whatsapp` (22): Postgres real (copia de Supabase local) con el
  proveedor y el Graph simulados. Cubre permisos con los defaults de Supabase,
  migración dos veces, conectar (solo el hash del enlace en la base, enlace
  gastado, token cifrado, número ocupado), plantilla pendiente, idempotencia,
  opt-out por número, leído, membresías, vigencia, plantilla pausada por
  webhook y negocio que quita a Wybix.
- POS: `npm run test:whatsapp` en `filtros_lubs_rios` (21), con SQL Server real
  y el módulo de la caja. Cubre KDS → aviso, sin duplicados entre procesos,
  quién no se avisa, sin internet con el mismo id, la baja, y sin número
  conectado (no barre; `SIN_NUMERO` queda OMITIDO).
