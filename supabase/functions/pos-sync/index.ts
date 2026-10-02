// ============================================================
// Edge Function: pos-sync
// El POS habla con la nube: alta del equipo, hechos (ventas, turnos, cortes,
// movimientos de caja) y el espejo que lee la app del dueño.
//
// FASE 1: credencial por EQUIPO (devices), no por sucursal; la empresa y la
// ubicación salen de la credencial. Las acciones y su autorización están en
// _shared/pos-sync.ts y en las funciones SQL de la migración
// 20261002120000_fase1_multiempresa.sql. Las acciones anteriores (provision,
// claim, upsert, alert_exists, stamp_license, delete_account) siguen
// respondiendo igual para los POS que aún no se actualizan.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (solo aquí, en el servidor).
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { json, rpcPostgrest } from '../_shared/nube.ts';
import { manejarPosSync } from '../_shared/pos-sync.ts';
import { servir } from '../_shared/fiscal.ts';

const URL = Deno.env.get('SUPABASE_URL') ?? '';
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const db = URL && KEY ? createClient(URL, KEY) : null;

Deno.serve(servir(async (req) => {
  if (!db) return json({ success: false, error: 'Backend mal configurado.' }, 500);
  return manejarPosSync(req, {
    rpc: rpcPostgrest(URL, KEY),
    espejo: {
      async escribir(table, rows, onConflict) {
        const { error } = onConflict ? await db.from(table).upsert(rows, { onConflict }) : await db.from(table).insert(rows);
        return error ? error.message : null;
      },
      async existeAlerta(sucursalId, tipo, marca) {
        const { data } = await db.from('alertas').select('id').eq('sucursal_id', sucursalId).eq('tipo', tipo)
          .like('mensaje', `%${marca.replace(/[%_]/g, '')}%`).limit(1);
        return Array.isArray(data) && data.length > 0;
      },
    },
    async borrarUsuario(id) { await db.auth.admin.deleteUser(id); },
  });
}));
