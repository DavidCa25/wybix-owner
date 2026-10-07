// ============================================================
// Edge Function: send-alert-push
// Es el slug al que apunta el trigger `alerta-push` de producción. Sirve
// EXACTAMENTE lo mismo que notificar-alerta (_shared/alerta-push.ts).
//
// Historia (2026-10-04): en producción este slug tenía la plantilla "Hello"
// de Supabase (las alertas no llegaban a nadie) y la copia del repo era el
// link-owner anterior a la Fase 1, que dejaba a cualquier usuario reclamar un
// negocio sin dueño. Ninguno de los dos debe volver a desplegarse.
//
//   supabase functions deploy send-alert-push --no-verify-jwt
// ============================================================
import { servirAlertaPush } from '../_shared/alerta-push-servir.ts';

servirAlertaPush();
