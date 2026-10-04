// ============================================================
// Edge Function: owner-mfa (Fase 3)
// Recuperar el acceso con un código de recuperación cuando se perdió el
// segundo factor. Lógica en _shared/owner-mfa.ts.
//
//   supabase functions deploy owner-mfa --no-verify-jwt
// (la función valida el JWT por su cuenta, igual que link-owner).
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { manejarOwnerMfa } from '../_shared/owner-mfa.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const res = await manejarOwnerMfa(req, {
    usuarioDeJwt: async (jwt) => {
      const { data, error } = await admin.auth.getUser(jwt);
      return error || !data?.user ? null : { id: data.user.id };
    },
    rpc: async (nombre, args) => {
      const { data, error } = await admin.rpc(nombre, args);
      return { data, error: error ? { message: error.message } : null };
    },
    factores: async (userId) => {
      const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
      if (error) throw new Error(error.message);
      return (data?.factors ?? []).map((f: { id: string }) => ({ id: f.id }));
    },
    borrarFactor: async (userId, factorId) => {
      const { error } = await admin.auth.admin.mfa.deleteFactor({ userId, id: factorId });
      if (error) throw new Error(error.message);
    },
    cerrarOtrasSesiones: async (jwt) => {
      const { error } = await admin.auth.admin.signOut(jwt, 'others');
      if (error) throw new Error(error.message);
    },
  });
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
});
