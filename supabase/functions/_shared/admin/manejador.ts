// ============================================================================
//  MANEJADOR HTTP DEL PANEL DE ADMINISTRACIÓN (sin Deno: se prueba en Node)
// ----------------------------------------------------------------------------
//  Una sola tubería para TODAS las operaciones; cada etapa corta con su
//  propio código HTTP:
//
//    origen    CORS solo para los orígenes permitidos (wybixpos.com.mx)   403
//    sesión    JWT firmado por Supabase Auth (verificado localmente)      401
//    MFA       el JWT trae aal2 (segundo factor verificado)               403
//    puerta    UN viaje a admin_gate: la sesión sigue viva en             401
//              auth.sessions, fila activa en platform_admins,             403
//              peticiones por minuto por administrador                    429
//    comando   existe en el registro y el rol alcanza                     404/403
//    entrada   esquema del comando                                        400
//    ejecutar  función de Postgres                                        200/4xx/500
//    auditar   todo cambio (bien o mal) y toda negación -> admin_audit
//
//  La service role vive SOLO en la Edge Function (index.ts). El navegador
//  manda su JWT; nunca una llave.
// ============================================================================
import { alcanza, Registro, type Actor, type Comando, type Contexto, type Resultado, type Rol, type Rpc } from './nucleo.ts';
import { ErrorValidacion } from './validar.ts';
import { consultas } from './consultas.ts';
import { licencias } from './licencias.ts';
import { operacion } from './operacion.ts';

export interface Sesion {
  id: string; email: string | null; aal: string | null;
  /** `session_id` del JWT: admin_gate comprueba que siga abierta. */
  sesionId: string | null;
}

export interface DepsAdmin {
  /** Verifica el JWT (firma, vencimiento, emisor) y devuelve el usuario y su nivel de autenticación. */
  sesion: (jwt: string) => Promise<Sesion | null>;
  rpc: Rpc;
  /** Orígenes permitidos para el navegador (CORS). */
  origenes: string[];
  limitePorMinuto?: number;
  registro?: Registro;
  log?: (msg: string) => void;
}

export const registroAdmin = (): Registro => new Registro([...consultas, ...licencias, ...operacion]);

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400, BAD_SLUG: 400, NOT_FOUND: 404, UNKNOWN_ACTION: 404,
  UNAUTHORIZED: 401, MFA_REQUIRED: 403, NOT_ADMIN: 403, FORBIDDEN: 403, ORIGIN: 403,
  RATE_LIMIT: 429, DB_ERROR: 500, INTERNAL: 500,
};
const MENSAJE_INTERNO = 'Error interno. Quedó registrado en la bitácora.';

export async function manejarAdmin(req: Request, deps: DepsAdmin): Promise<Response> {
  const registro = deps.registro ?? registroAdmin();
  const origen = req.headers.get('origin');
  const origenOk = origen !== null && deps.origenes.includes(origen);
  const cors: Record<string, string> = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '600',
    ...(origenOk ? { 'Access-Control-Allow-Origin': origen! } : {}),
  };
  const responder = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
    status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  const fallo = (code: string, error: string) => responder({ ok: false, code, error }, STATUS[code] ?? 422);

  // ------------------------------------------------------------------ origen
  if (req.method === 'OPTIONS') return new Response(null, { status: origenOk ? 204 : 403, headers: cors });
  if (req.method !== 'POST') return fallo('BAD_REQUEST', 'Método no permitido.');
  // Sin Origin (curl, scripts) se permite: la sesión con MFA sigue siendo obligatoria.
  if (origen !== null && !origenOk) return fallo('ORIGIN', 'Origen no permitido.');

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;
  const agente = req.headers.get('user-agent');
  const auditar = async (actor: { id: string | null; rol: Rol | null }, accion: string, ok: boolean,
                         extra: { target?: string | null; reason?: string | null; input?: unknown; result?: unknown } = {}) => {
    const { error } = await deps.rpc('admin_audit_log', {
      p_actor: actor.id, p_role: actor.rol, p_action: accion, p_target: extra.target ?? null, p_reason: extra.reason ?? null,
      p_input: extra.input ?? {}, p_result: extra.result ?? null, p_ok: ok, p_ip: ip, p_user_agent: agente,
    }).catch((e: unknown) => ({ error: { message: String(e) } }));
    if (error) deps.log?.(`admin_audit_log falló: ${error.message}`);
  };

  // ------------------------------------------------------------------ sesión
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const sesion = jwt ? await deps.sesion(jwt).catch(() => null) : null;
  if (!sesion) return fallo('UNAUTHORIZED', 'Inicia sesión.');

  let cuerpo: { accion?: unknown; datos?: unknown };
  try { cuerpo = await req.json(); } catch { return fallo('BAD_REQUEST', 'Cuerpo inválido.'); }
  const accion = typeof cuerpo?.accion === 'string' ? cuerpo.accion.slice(0, 60) : '';

  // ------------------------------------------------------------------ MFA y rol
  if (sesion.aal !== 'aal2') {
    await auditar({ id: sesion.id, rol: null }, accion || '(sin acción)', false, { result: { code: 'MFA_REQUIRED' } });
    return fallo('MFA_REQUIRED', 'Verifica tu segundo factor.');
  }
  // ------------------------------------------------------------------ puerta
  const puerta = await deps.rpc('admin_gate', {
    p_user: sesion.id, p_session: sesion.sesionId, p_limit: deps.limitePorMinuto ?? 120, p_window_s: 60,
  });
  const g = (puerta.data ?? {}) as { ok?: boolean; code?: string; role?: Rol };
  if (puerta.error) {
    deps.log?.(`admin_gate falló: ${puerta.error.message}`);
    return fallo('INTERNAL', MENSAJE_INTERNO);
  }
  if (!g.ok) {
    if (g.code === 'RATE_LIMIT') return fallo('RATE_LIMIT', 'Demasiadas peticiones. Espera un minuto.');
    if (g.code === 'UNAUTHORIZED') return fallo('UNAUTHORIZED', 'Tu sesión terminó. Vuelve a entrar.');
    await auditar({ id: sesion.id, rol: null }, accion || '(sin acción)', false, { result: { code: 'NOT_ADMIN' } });
    return fallo('NOT_ADMIN', 'Tu cuenta no es administradora.');
  }
  const actor: Actor = { id: sesion.id, email: sesion.email, rol: g.role! };

  // ------------------------------------------------------------------ comando
  const cmd: Comando | undefined = registro.obtener(accion);
  if (!cmd) return fallo('UNKNOWN_ACTION', 'Acción desconocida.');
  if (!alcanza(actor.rol, cmd.rol)) {
    await auditar(actor, accion, false, { result: { code: 'FORBIDDEN', requiere: cmd.rol } });
    return fallo('FORBIDDEN', `Necesitas el rol ${cmd.rol}.`);
  }

  let entrada: unknown;
  try {
    entrada = cmd.entrada(cuerpo.datos ?? {}, '');
  } catch (e) {
    if (e instanceof ErrorValidacion) return fallo('BAD_REQUEST', `Revisa ${e.campo}: ${e.message.split(': ').slice(1).join(': ')}`);
    return fallo('BAD_REQUEST', 'Datos inválidos.');
  }

  // ------------------------------------------------------------------ ejecutar
  const ctx: Contexto = { actor, rpc: deps.rpc, firma: `admin:${actor.id}`, permitidos: registro.permitidos(actor.rol) };
  let r: Resultado;
  try {
    r = await cmd.ejecutar(entrada, ctx);
  } catch (e) {
    r = { ok: false, code: 'INTERNAL', error: e instanceof Error ? e.message : String(e) };
  }

  // ------------------------------------------------------------------ auditar
  if (cmd.tipo === 'cambio') {
    await auditar(actor, accion, r.ok, {
      target: cmd.objetivo?.(entrada) ?? null,
      reason: cmd.motivo?.(entrada) ?? null,
      input: entrada,
      result: r.ok ? r.data : { code: r.code, error: r.error },
    });
  } else if (!r.ok && STATUS[r.code] === 500) {
    await auditar(actor, accion, false, { input: entrada, result: { code: r.code, error: r.error } });
  }

  if (r.ok) return responder({ ok: true, data: r.data });
  // El detalle técnico de la base no sale al navegador: queda en la bitácora.
  return fallo(r.code, STATUS[r.code] === 500 ? MENSAJE_INTERNO : r.error);
}
