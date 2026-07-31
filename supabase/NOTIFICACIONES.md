# Alertas en tiempo real (push)

Cómo queda el flujo cuando ocurre un evento de robo hormiga en el POS:

1. El POS registra el evento y, si es crítico (devolución, anulación, cajón sin
   venta, producto eliminado), **inserta la alerta en la nube al instante**
   (no espera los 5 min de sincronización).
2. Un **Database Webhook** de Supabase detecta el INSERT en `alertas` y llama a
   la Edge Function `notificar-alerta`.
3. La función busca al/los dueño(s) de ese negocio y **envía la notificación
   push** (Expo) a sus teléfonos. Suena en segundos.

## 1. Desplegar la función

Con el CLI de Supabase (una vez):

```bash
supabase functions deploy notificar-alerta --project-ref TU_PROJECT_REF
```

(o pégala desde el panel: Edge Functions → New function → `notificar-alerta`).

## 2. Poner el secreto

```bash
supabase secrets set WEBHOOK_SECRET=un-texto-secreto-largo --project-ref TU_PROJECT_REF
```

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` ya están disponibles para las
funciones automáticamente.

## 3. Crear el Database Webhook

En el panel de Supabase → **Database → Webhooks → Create a new hook**:

- Name: `alerta-push`
- Table: `public.alertas`
- Events: **Insert**
- Type: **Supabase Edge Functions** → `notificar-alerta`
- HTTP Headers: agrega `x-webhook-secret` con el **mismo** valor de `WEBHOOK_SECRET`.

Guarda. Listo: cada alerta nueva dispara el push.

## Nota importante

El push llega al teléfono solo cuando la app tiene un **projectId de EAS**, es
decir, **después del primer `eas build`** (ahí se guarda el token en
`push_tokens`). Mientras tanto, las alertas **igual aparecen al instante** en la
app al abrir/refrescar; lo que falta hasta el build es que el celular suene solo.

## Qué eventos disparan alerta en vivo

REFUND / DEVOLUCION, VOID / ANULADA, DRAWER_NO_SALE (cajón sin venta),
DELETE / ELIMINADO. Los resúmenes (ventas del día, cortes, índice de riesgo)
siguen sincronizando en bloque cada 5 min, porque no son urgentes.
