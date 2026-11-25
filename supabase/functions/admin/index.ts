// ============================================================
// Edge Function: admin — consola de la plataforma (wybixpos.com.mx/admin)
// Toda la lógica en _shared/admin/ (se prueba en Node). Aquí solo se
// conectan los puertos: sesión (JWT verificado localmente con las llaves del
// proyecto; getUser solo como respaldo para tokens HS256) y PostgREST (rpc).
//
//   supabase functions deploy admin --no-verify-jwt
// (la función valida el JWT por su cuenta, igual que owner-mfa).
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (las pone Supabase)
//   ADMIN_ALLOWED_ORIGINS   coma-separado; por omisión el dominio de producción
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { manejarAdmin, registroAdmin } from '../_shared/admin/manejador.ts';
import { crearVerificador } from '../_shared/admin/jwt.ts';

const URL_SB = Deno.env.get('SUPABASE_URL')!;
const db = createClient(URL_SB, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const origenes = (Deno.env.get('ADMIN_ALLOWED_ORIGINS') ?? 'https://wybixpos.com.mx,https://www.wybixpos.com.mx,https://wybix-landing.vercel.app')
  .split(',').map((s) => s.trim()).filter(Boolean);
const registro = registroAdmin();
const verificar = crearVerificador({ supabaseUrl: URL_SB });

/** Segmento del JWT SIN verificar: solo para el respaldo, que valida con getUser. */
function segmento(jwt: string, n: 0 | 1): Record<string, unknown> {
  try {
    const b64 = jwt.split('.')[n].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')));
  } catch { return {}; }
}

Deno.serve((req) => manejarAdmin(req, {
  registro,
  origenes,
  log: (m) => console.error(m),
  sesion: async (jwt) => {
    const v = await verificar(jwt);
    if (v) return { id: v.sub, email: v.email, aal: v.aal, sesionId: v.session_id };
    // Respaldo: token con firma HS256 (llave legada) -> que Auth lo valide.
    if (segmento(jwt, 0).alg !== 'HS256') return null;
    const { data, error } = await db.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const c = segmento(jwt, 1);
    return {
      id: data.user.id, email: data.user.email ?? null,
      aal: typeof c.aal === 'string' ? c.aal : null,
      sesionId: typeof c.session_id === 'string' ? c.session_id : null,
    };
  },
  rpc: async (fn, args) => {
    const { data, error } = await db.rpc(fn, args);
    return { data, error: error ? { message: error.message } : null };
  },
}));
