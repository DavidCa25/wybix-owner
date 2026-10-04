// ============================================================
// Edge Function: notificar-alerta
// Alerta en vivo (public.alertas) -> push a los dueños. El código está en
// _shared/alerta-push.ts; este slug y send-alert-push sirven lo mismo.
//
// Desplegar SIN verificación de JWT (la autenticación es el secreto del
// webhook, obligatorio):
//   supabase functions deploy notificar-alerta --no-verify-jwt
// Secretos: WEBHOOK_SECRET (>= 32 caracteres). Sin él, responde 503 a todo.
// ============================================================
import { servirAlertaPush } from '../_shared/alerta-push-servir.ts';

servirAlertaPush();
