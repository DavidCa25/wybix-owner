// ============================================================================
//  pos-sync: el POS habla con la nube
// ----------------------------------------------------------------------------
//  FASE 1. Cada computadora es un EQUIPO con su propia credencial (devices).
//  La empresa y la ubicación salen de esa credencial, nunca del cuerpo.
//
//  Sin credencial (alta del equipo):
//    bootstrap   { instance_uuid, device_uuid, nombre_negocio, nombre_sucursal, ... }
//                la principal de una base nueva crea empresa + ubicación.
//                Con la cabecera del token ANTERIOR se actualiza un POS que ya
//                sincronizaba (conserva su empresa).
//    enroll      { install_secret | code, instance_uuid, device_uuid, kind }
//                secundarias, Local Host, o la principal de una sucursal nueva.
//    provision / claim   contrato de los POS ANTERIORES (no cambia).
//
//  Con credencial (cabecera x-wybix-device; x-wybix-sync en POS anteriores):
//    whoami, events, create_location, create_enrollment, install_secret,
//    invite_owner, link_license (= stamp_license), upsert, alert_exists,
//    delete_account.
//
//  FASE 2
//    sucursal (POS_PRIMARY): publish (catálogo + personal con PIN),
//      register_key (llave pública para firmar comprobantes QR),
//      transfer_inbox (retornos por recibir, envíos ya recibidos, eventos).
//    tablet (MOBILE_POS): mobile_snapshot, mobile_inbox, mobile_heartbeat,
//      events. Una tablet REVOCADA solo puede entregar `events` (la nube
//      acepta lo anterior a la baja y pone en cuarentena lo posterior).
//
//  Este módulo no importa nada de Deno: scripts/probar-fase1.mjs lo prueba.
// ============================================================================
import { credencialDe, equipoDe, json, negado, type Rpc } from './nube.ts';

/** Tablas espejo (POS anteriores y tablero actual) y su clave de conflicto. */
export const TABLAS: Record<string, string | null> = {
  resumen_ventas: 'sucursal_id,fecha',
  top_productos: null,
  cortes_caja: 'sucursal_id,closure_id_local',
  tendencia_ventas: 'sucursal_id,fecha',
  seguridad_riesgo: 'sucursal_id,user_id',
  alertas: null,
};

export interface DepsPosSync {
  rpc: Rpc;
  espejo: {
    escribir(table: string, rows: Record<string, unknown>[], onConflict: string | null): Promise<string | null>;
    existeAlerta(sucursalId: string, tipo: string, marca: string): Promise<boolean>;
  };
  borrarUsuario(id: string): Promise<void>;
}

const str = (v: unknown, max = 200) => (v == null ? null : String(v).slice(0, max));

/** Lo que el alta de un equipo acepta del cuerpo (nada de empresa ni ubicación). */
function alta(body: any) {
  return {
    instance_uuid: str(body.instance_uuid, 36), device_uuid: str(body.device_uuid, 36), kind: str(body.kind, 30),
    name: str(body.name, 120), machine_fingerprint: str(body.machine_fingerprint, 128), app_version: str(body.app_version, 40),
  };
}

export async function manejarPosSync(req: Request, deps: DepsPosSync): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? '');

  // ---------------------------------------------------------- sin credencial
  if (action === 'provision' || action === 'claim') {
    const r = await deps.rpc('pos_provision_legado', {
      action, device_key: str(body.deviceKey, 200), sucursal_id: str(body.sucursalId, 36), nombre: str(body.nombre, 120), equipo: str(body.equipo, 120),
    });
    if (!r?.ok) {
      return r?.code === 'NO_MATCH'
        ? json({ success: false, code: 'NO_MATCH', error: 'Esta sucursal no es de este equipo.' }, 403)
        : json({ success: false, error: 'Equipo inválido.' }, 400);
    }
    return json({ success: true, sucursalId: r.sucursalId, negocioId: r.negocioId, token: r.token });
  }
  if (action === 'bootstrap') {
    const anterior = credencialDe(req);
    const r = await deps.rpc('pos_bootstrap', {
      ...alta(body), nombre_negocio: str(body.nombre_negocio, 120), nombre_sucursal: str(body.nombre_sucursal, 120),
      legacy_token: anterior.length >= 20 ? anterior : null,
    });
    return r?.ok ? json({ success: true, ...r }) : json({ success: false, code: r?.code, company_id: r?.company_id, location_id: r?.location_id },
      r?.code === 'INSTANCE_KNOWN' ? 409 : r?.code === 'BAD_REQUEST' ? 400 : 403);
  }
  if (action === 'enroll') {
    const r = await deps.rpc('pos_enroll', { ...alta(body), install_secret: str(body.install_secret, 200), code: str(body.code, 40) });
    return r?.ok ? json({ success: true, ...r }) : negado(r?.code);
  }

  // ---------------------------------------------------------- con credencial
  const eq = await equipoDe(req, deps.rpc) as (Awaited<ReturnType<typeof equipoDe>> & { revoked?: boolean }) | null;
  if (!eq) return negado(credencialDe(req).length < 20 ? 'NO_TOKEN' : 'BAD_TOKEN');
  if (eq.revoked && action !== 'events') return json({ success: false, code: 'DEVICE_REVOKED', error: 'Esta tablet fue dada de baja.' }, 403);
  const conEquipo = (extra: Record<string, unknown> = {}) => ({ device_id: eq.device_id, ...extra });
  const responder = (r: any) => (r?.ok ? json({ success: true, ...r }) : negado(r?.code));

  switch (action) {
    case 'whoami':
      return responder(await deps.rpc('pos_whoami', conEquipo()));
    case 'events':
      return responder(await deps.rpc('sync_ingest', conEquipo({
        envelope: body.envelope ?? {}, events: Array.isArray(body.events) ? body.events.slice(0, 500) : [],
      })));
    case 'publish':
      return responder(await deps.rpc('pos_publicar', conEquipo({ catalog: body.catalog ?? null, staff: Array.isArray(body.staff) ? body.staff.slice(0, 500) : null })));
    case 'register_key':
      return responder(await deps.rpc('pos_registrar_llave', conEquipo({ public_key: str(body.public_key, 64) })));
    case 'transfer_inbox':
      return responder(await deps.rpc('pos_transfer_inbox', conEquipo()));
    case 'mobile_snapshot': {
      const r = await deps.rpc('mobile_snapshot', conEquipo({ channel: str(body.channel, 30),commercial_schema:Number(body.commercial_schema??0)===1?1:0 }));
      return r?.ok ? json({ success: true, ...r }) : json({ success: false, code: r?.code ?? 'DENIED', error: r?.code==='UPDATE_REQUIRED'?'Actualiza Wybix POS Mobile para usar los precios y ofertas.':'Sin acceso a los datos del evento.' }, r?.code==='UPDATE_REQUIRED'?409:403);
    }
    case 'mobile_inbox': {
      const r = await deps.rpc('mobile_inbox', conEquipo({ cursor: Number(body.cursor ?? 0) || 0 }));
      return r?.ok ? json({ success: true, ...r }) : json({ success: false, code: r?.code ?? 'DENIED', error: 'Sin acceso a los datos del evento.' }, 403);
    }
    // Fase 3 · autorización a distancia (el device_id sale de la credencial, nunca del cuerpo).
    case 'approval_request':
      return responder(await deps.rpc('aprobacion_solicitar', conEquipo({
        id: str(body.id, 36), action: str(body.approval_action, 40),
        requested_by: body.requested_by && typeof body.requested_by === 'object' ? body.requested_by : null,
        payload: body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : null,
      })));
    case 'approval_status':
      return responder(await deps.rpc('aprobacion_estado', conEquipo({ id: str(body.id, 36) })));
    case 'approval_consume':
      return responder(await deps.rpc('aprobacion_consumir', conEquipo({
        id: str(body.id, 36), payload: body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : null,
      })));
    case 'approval_cancel':
      return responder(await deps.rpc('aprobacion_cancelar', conEquipo({ id: str(body.id, 36) })));
    case 'mobile_heartbeat':
      return responder(await deps.rpc('mobile_latido', conEquipo({ pendientes: Number(body.pendientes ?? 0) || 0, app_version: str(body.app_version, 40), last_seq: Number(body.last_seq ?? 0) || 0 })));
    case 'create_location':
      return responder(await deps.rpc('pos_create_location', conEquipo({
        nombre: str(body.nombre, 120), tipo: str(body.tipo, 20), starts_at: str(body.starts_at, 40), ends_at: str(body.ends_at, 40),
        home_location_id: str(body.home_location_id, 36),
      })));
    case 'create_enrollment':
      return responder(await deps.rpc('pos_create_enrollment', conEquipo({ kinds: Array.isArray(body.kinds) ? body.kinds.slice(0, 5) : null })));
    case 'install_secret':
      return responder(await deps.rpc('pos_install_secret', conEquipo()));
    case 'invite_owner':
      return responder(await deps.rpc('membresia_crear_invitacion', conEquipo()));
    case 'link_license':
    case 'stamp_license': {
      const r = await deps.rpc('pos_vincular_licencia', conEquipo({ machine_id: str(body.licenseMachineId ?? body.machine_id, 128) }));
      // POS anteriores: stamp_license siempre respondía éxito.
      return action === 'stamp_license' ? json({ success: true, linked: !!r?.ok }) : responder(r);
    }
    case 'upsert': {
      if (eq.kind !== 'POS_PRIMARY') return negado('NOT_PRIMARY');
      const table = String(body.table ?? '');
      if (!(table in TABLAS)) return json({ success: false, error: 'Tabla no permitida.' }, 400);
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 1000) : [];
      if (!rows.length) return json({ success: true, n: 0 });
      // La ubicación la pone el servidor: ninguna fila puede ser de otra.
      const propias = rows.map((r: Record<string, unknown>) => ({ ...r, sucursal_id: eq.location_id }));
      const err = await deps.espejo.escribir(table, propias, TABLAS[table]);
      return err ? json({ success: false, error: err }, 500) : json({ success: true, n: propias.length });
    }
    case 'alert_exists':
      return json({ success: true, exists: await deps.espejo.existeAlerta(eq.location_id, String(body.tipo ?? '').slice(0, 40), String(body.marca ?? '').slice(0, 120)) });
    case 'delete_account': {
      const r = await deps.rpc('pos_borrar_cuenta', conEquipo());
      if (!r?.ok) {
        return r?.code === 'MULTI_LOCATION'
          ? json({ success: false, code: 'MULTI_LOCATION', error: 'La empresa tiene varias sucursales: bórrala desde la app del dueño.' }, 409)
          : negado(r?.code);
      }
      for (const u of r.delete_users ?? []) await deps.borrarUsuario(String(u)).catch(() => null);
      return json({ success: true });
    }
  }
  return json({ success: false, error: `Acción desconocida: ${action}` }, 400);
}
