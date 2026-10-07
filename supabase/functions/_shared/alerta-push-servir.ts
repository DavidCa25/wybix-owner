// Cableado Deno de alerta-push (lo comparten notificar-alerta y send-alert-push).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { manejarAlertaPush, type AdminAlertas } from './alerta-push.ts';

function admin(): AdminAlertas {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  return {
    async negocioDeSucursal(id) {
      const { data } = await db.from('sucursales').select('negocio_id').eq('id', id).maybeSingle();
      return (data?.negocio_id as string | undefined) ?? null;
    },
    async duenos(negocioId) {
      const s = new Set<string>();
      const { data: neg } = await db.from('negocios').select('owner_id').eq('id', negocioId).maybeSingle();
      if (neg?.owner_id) s.add(neg.owner_id as string);
      const { data: apps } = await db.from('owner_apps').select('user_id').eq('negocio_id', negocioId);
      for (const a of apps ?? []) if (a?.user_id) s.add(a.user_id as string);
      return [...s];
    },
    async tokens(duenos) {
      const { data } = await db.from('push_tokens').select('token').in('owner_id', duenos);
      return (data ?? []).map((t) => t.token as string).filter(Boolean);
    },
  };
}

export function servirAlertaPush() {
  Deno.serve((req) => manejarAlertaPush(req, {
    secreto: Deno.env.get('WEBHOOK_SECRET'),
    admin,
    enviar: async (mensajes) => {
      const r = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(mensajes),
      });
      return r.json().catch(() => ({ status: r.status }));
    },
  }));
}
