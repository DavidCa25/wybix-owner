# Fase 3 · Etapa 0.5 · Push heredado: estado y rotación del secreto

> Nada de esto se ha aplicado en producción. Los pasos marcados **(producción)**
> los ejecuta o autoriza el dueño del proyecto.

## Lo que se encontró (2026-10-04, consulta de solo lectura)

| Slug en producción | Qué tenía | Riesgo |
|---|---|---|
| `send-alert-push` v8 | La **plantilla "Hello"** de Supabase (desplegada desde `wybix-supabase/`) | El trigger `alerta-push` de producción apunta aquí: **las alertas en vivo no mandaban push** |
| `notificar-alerta` v4 | El emisor real, con `if (secret) { comparar }` | Falla **abierto**: sin `WEBHOOK_SECRET` cualquiera podía disparar push a los dueños |
| Copia del repo `supabase/functions/send-alert-push` | El `link-owner` **anterior a la Fase 1** | Un `supabase functions deploy` de toda la carpeta publicaba un endpoint para **reclamar negocios sin dueño** |
| Trigger `alerta-push` sobre `public.alertas` | Creado desde el panel con `x-webhook-secret` **escrito en su definición** | El secreto se lee en el catálogo |

`WEBHOOK_SECRET` existe como secreto de funciones (actualizado 2026-07-31). Solo
se consultaron los nombres y huellas, nunca los valores.

## Lo que cambió en el repositorio

- `supabase/functions/_shared/webhook.ts`: autenticación **fail-closed**
  (sin secreto, o con menos de 32 caracteres → 503 a todo), comparación de
  tiempo constante y ningún secreto en los registros.
- `supabase/functions/_shared/alerta-push.ts`: un único manejador.
  `notificar-alerta` y `send-alert-push` sirven **el mismo código**.
- `supabase/migrations/20261011100000_fase3_alerta_push_vault.sql`: reemplaza el
  trigger del panel por `wx_alerta_push`, que lee la URL y el secreto de
  **Vault** y llama con `pg_net`. Si falta algo, no envía y la alerta se guarda
  igual.
- Pruebas: `supabase/functions/_shared/test/alerta-push.test.ts` (6, en
  `npm test`) y `npm run test:fase3` (F3-PUSH01–07, sobre Postgres real con
  la cadena completa de migraciones).

> **No vuelvas a desplegar nada desde `wybix-supabase/`.** Es una copia vieja
> con la plantilla "Hello".

## Rotación (producción)

Hazlo en una ventana tranquila. Las alertas siguen guardándose aunque el push
falle a la mitad.

1. Genera un secreto nuevo de 48 caracteres o más en tu equipo, sin pegarlo en ningún chat:
   ```bash
   node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"
   ```
2. Configúralo en las funciones:
   ```bash
   npx supabase@2.119.0 secrets set WEBHOOK_SECRET=<nuevo> --project-ref swlpspgmkwzlrowllvvj
   ```
3. Guarda el mismo valor y la URL en Vault (SQL Editor del panel):
   ```sql
   select vault.create_secret('<nuevo>', 'wybix_webhook_secret');
   select vault.create_secret('https://swlpspgmkwzlrowllvvj.supabase.co/functions/v1/send-alert-push', 'wybix_alerta_push_url');
   ```
   Si ya existen, usa `vault.update_secret(id, ...)`.
4. Despliega las dos funciones con el código nuevo:
   ```bash
   npx supabase@2.119.0 functions deploy send-alert-push notificar-alerta --no-verify-jwt --project-ref swlpspgmkwzlrowllvvj
   ```
5. Aplica **solo** la migración `20261011100000_fase3_alerta_push_vault.sql`,
   pegándola en el SQL Editor. Borra el trigger con el secreto viejo y crea
   `wx_alerta_push`.

   **No uses `supabase db push`.** Aplicaría también las migraciones de la
   Fase 1 y la Fase 2, que siguen sin desplegar. Esta migración no depende de
   ellas.
6. Comprueba:
   - **Sin secreto se rechaza:** `curl -X POST .../send-alert-push` responde **401**.
   - **El push llega:** inserta una alerta de prueba en una sucursal tuya y confirma
     que el push llega al teléfono del dueño.
   - **Ningún trigger guarda el secreto:**
     ```sql
     select tgname from pg_trigger
      where tgrelid = 'public.alertas'::regclass
        and encode(tgargs, 'escape') like '%x-webhook-secret%';
     ```
     Debe regresar **0 filas**.
7. El secreto viejo queda invalidado en el paso 2. No hace falta borrarlo de
   ningún otro lado: el trigger que lo tenía escrito desaparece en el paso 5.
