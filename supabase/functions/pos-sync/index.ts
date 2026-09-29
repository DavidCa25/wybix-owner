// ============================================================
// Edge Function: pos-sync
// El POS empuja a la nube el espejo de SU sucursal (ventas del día, cortes,
// tendencia, riesgo por cajero, alertas) para la app del dueño.
//
// POR QUÉ EXISTE
// --------------
// Antes el POS escribía directo en PostgREST con el SERVICE ROLE de Supabase,
// capturado en Configuración > Nube y guardado en cada caja. Con esa llave
// cualquiera con acceso a una caja podía leer y modificar TODO el proyecto:
// licencias (fechas, MonoCaja -> MultiCaja), clientes de otros negocios,
// cuentas de Auth. Esa llave ya no sale de Supabase.
//
// Ahora cada caja tiene un TOKEN PROPIO (aleatorio, 256 bits) que se entrega
// al aprovisionar su sucursal. En la base solo se guarda su hash. Con él, esta
// función solo escribe filas de ESA sucursal, y solo en las tablas espejo.
//
// Acciones:
//   provision      { deviceKey, nombre }        crea/reusa negocio + sucursal, entrega token
//   claim          { deviceKey, sucursalId }    instalaciones previas: token para su sucursal
//   upsert         { table, rows, onConflict }  espejo de la sucursal del token
//   alert_exists   { tipo, marca }              ¿ya se avisó? (evita repetir alertas)
//   stamp_license  { licenseMachineId }         liga la sucursal con su licencia (admin)
//   delete_account {}                           borra los datos del negocio en la nube
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (solo aquí, en el servidor).
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wybix-sync',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

/** Tablas espejo y su clave de conflicto. Nada fuera de esta lista. */
const TABLAS: Record<string, string | null> = {
  resumen_ventas: 'sucursal_id,fecha',
  top_productos: null,
  cortes_caja: 'sucursal_id,closure_id_local',
  tendencia_ventas: 'sucursal_id,fecha',
  seguridad_riesgo: 'sucursal_id,user_id',
  alertas: null,
};

async function sha256(t: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function nuevoToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, error: 'Método no permitido.' }, 405);
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) return json({ success: false, error: 'Backend mal configurado.' }, 500);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, key);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? '');

    // ---------- Aprovisionar (o reusar) la sucursal de ESTE equipo ----------
    if (action === 'provision' || action === 'claim') {
      const deviceKey = String(body.deviceKey ?? '').trim();
      if (deviceKey.length < 8 || deviceKey.length > 128) return json({ success: false, error: 'Equipo inválido.' }, 400);
      let q = db.from('sucursales').select('id, negocio_id').eq('device_key', deviceKey);
      if (action === 'claim') q = q.eq('id', String(body.sucursalId ?? ''));
      const { data: existente } = await q.limit(1).maybeSingle();

      let sucursalId = existente?.id ?? null;
      let negocioId = existente?.negocio_id ?? null;
      if (!sucursalId) {
        if (action === 'claim') return json({ success: false, code: 'NO_MATCH', error: 'Esta sucursal no es de este equipo.' }, 403);
        const nombre = String(body.nombre ?? '').trim().slice(0, 120) || 'Mi negocio';
        const { data: neg, error: e1 } = await db.from('negocios').insert({ nombre }).select('id').single();
        if (e1 || !neg) return json({ success: false, error: 'No se pudo crear el negocio.' }, 500);
        const { data: suc, error: e2 } = await db.from('sucursales')
          .insert({ negocio_id: neg.id, nombre: String(body.equipo ?? 'Matriz').slice(0, 120), device_key: deviceKey })
          .select('id').single();
        if (e2 || !suc) return json({ success: false, error: 'No se pudo crear la sucursal.' }, 500);
        sucursalId = suc.id; negocioId = neg.id;
      }
      // Un token nuevo cada vez: reinstalar invalida el anterior.
      const token = nuevoToken();
      await db.from('sucursales').update({ sync_token_hash: await sha256(token) }).eq('id', sucursalId);
      return json({ success: true, sucursalId, negocioId, token });
    }

    // ---------- Todo lo demás: con el token de la sucursal ----------
    const token = String(req.headers.get('x-wybix-sync') ?? body.token ?? '');
    if (token.length < 20) return json({ success: false, code: 'NO_TOKEN', error: 'Falta la credencial de sincronización.' }, 401);
    const { data: suc } = await db.from('sucursales').select('id, negocio_id').eq('sync_token_hash', await sha256(token)).maybeSingle();
    if (!suc) return json({ success: false, code: 'BAD_TOKEN', error: 'Credencial de sincronización inválida.' }, 401);

    if (action === 'upsert') {
      const table = String(body.table ?? '');
      if (!(table in TABLAS)) return json({ success: false, error: 'Tabla no permitida.' }, 400);
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 1000) : [];
      if (!rows.length) return json({ success: true, n: 0 });
      // La sucursal la pone el servidor: ninguna fila puede ser de otra.
      const propias = rows.map((r: Record<string, unknown>) => ({ ...r, sucursal_id: suc.id }));
      const conflicto = TABLAS[table];
      const { error } = conflicto
        ? await db.from(table).upsert(propias, { onConflict: conflicto })
        : await db.from(table).insert(propias);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true, n: propias.length });
    }

    if (action === 'alert_exists') {
      const tipo = String(body.tipo ?? '').slice(0, 40);
      const marca = String(body.marca ?? '').slice(0, 120);
      const { data } = await db.from('alertas').select('id').eq('sucursal_id', suc.id).eq('tipo', tipo)
        .like('mensaje', `%${marca.replace(/[%_]/g, '')}%`).limit(1);
      return json({ success: true, exists: Array.isArray(data) && data.length > 0 });
    }

    if (action === 'stamp_license') {
      const id = String(body.licenseMachineId ?? '').slice(0, 128);
      await db.from('sucursales').update({ license_machine_id: id || null }).eq('id', suc.id);
      return json({ success: true });
    }

    if (action === 'delete_account') {
      const { data: neg } = await db.from('negocios').select('owner_id').eq('id', suc.negocio_id).maybeSingle();
      for (const t of Object.keys(TABLAS)) await db.from(t).delete().eq('sucursal_id', suc.id);
      await db.from('owner_apps').delete().eq('negocio_id', suc.negocio_id);
      if (neg?.owner_id) await db.from('push_tokens').delete().eq('owner_id', neg.owner_id);
      await db.from('sucursales').delete().eq('id', suc.id);
      await db.from('negocios').delete().eq('id', suc.negocio_id);
      if (neg?.owner_id) await db.auth.admin.deleteUser(neg.owner_id).catch(() => null);
      return json({ success: true });
    }

    return json({ success: false, error: `Acción desconocida: ${action}` }, 400);
  } catch (_e) {
    return json({ success: false, error: 'Error del servicio de sincronización.' }, 500);
  }
});
