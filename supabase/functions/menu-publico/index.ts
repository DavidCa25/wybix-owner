// ============================================================================
// Edge Function: menu-publico (POS 0067)
// La página del menú (wybix-landing /m/<slug>) por el proxy /backend: mismo
// origen, sin credencial. La lógica está en _shared/menu-publico.ts y las
// reglas en Postgres (20261028130000_menu_en_linea.sql).
//
// Se despliega SIN verificación de JWT (es pública):
//   supabase functions deploy menu-publico --no-verify-jwt
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MENU_IP_SALT.
// ============================================================================
import { rpcPostgrest } from '../_shared/nube.ts';
import { manejarMenuPublico } from '../_shared/menu-publico.ts';

const URL_SB = Deno.env.get('SUPABASE_URL') ?? '';
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SAL = Deno.env.get('MENU_IP_SALT') ?? '';

async function hash(texto: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (!URL_SB || !KEY || !SAL) return new Response(JSON.stringify({ success: false, error: 'Servicio mal configurado.' }), { status: 500 });
  try {
    return await manejarMenuPublico(req, { rpc: rpcPostgrest(URL_SB, KEY), hash, sal: SAL });
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'No se pudo completar. Intenta de nuevo.' }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
});
