import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manejarAdmin, registroAdmin, type DepsAdmin } from '../admin/manejador.ts';
import { alcanza } from '../admin/nucleo.ts';

const ORIGEN = 'https://wybixpos.com.mx';
const LIC = '11111111-2222-4333-8444-555555555555';

type Llamada = { fn: string; args: Record<string, unknown> };

function deps(over: Partial<DepsAdmin> = {}, opts: { rol?: string | null; aal?: string; respuestas?: Record<string, unknown>; limite?: boolean; cerrada?: boolean } = {}) {
  const llamadas: Llamada[] = [];
  const d: DepsAdmin = {
    origenes: [ORIGEN],
    sesion: async (jwt) => (jwt === 'bueno' ? { id: 'u-1', email: 'yo@wybix.mx', aal: opts.aal ?? 'aal2', sesionId: 's-1' } : null),
    rpc: async (fn, args) => {
      llamadas.push({ fn, args });
      if (fn === 'admin_gate') {
        if (opts.cerrada) return { data: { ok: false, code: 'UNAUTHORIZED' }, error: null };
        if (opts.rol === null) return { data: { ok: false, code: 'NOT_ADMIN' }, error: null };
        if (opts.limite === false) return { data: { ok: false, code: 'RATE_LIMIT' }, error: null };
        return { data: { ok: true, role: opts.rol ?? 'OWNER' }, error: null };
      }
      if (fn === 'admin_audit_log') return { data: null, error: null };
      if (opts.respuestas && fn in opts.respuestas) return { data: opts.respuestas[fn], error: null };
      return { data: { ok: true }, error: null };
    },
    ...over,
  };
  return { d, llamadas };
}

const peticion = (accion: string, datos: unknown = {}, h: Record<string, string> = {}) => new Request('http://local/admin', {
  method: 'POST',
  headers: { authorization: 'Bearer bueno', origin: ORIGEN, 'content-type': 'application/json', ...h },
  body: JSON.stringify({ accion, datos }),
});
const leer = async (r: Response) => ({ status: r.status, body: await r.json() });
const auditorias = (ll: Llamada[]) => ll.filter((l) => l.fn === 'admin_audit_log').map((l) => l.args);

test('registro: nombres únicos y cada rol ve lo suyo', () => {
  const r = registroAdmin();
  assert.ok(r.nombres().length > 25);
  assert.ok(r.permitidos('VIEWER').includes('licencias'));
  assert.ok(!r.permitidos('VIEWER').includes('licencia.estado'));
  assert.ok(r.permitidos('OPERATOR').includes('licencia.estado'));
  assert.ok(!r.permitidos('OPERATOR').includes('catalogo.precio'));
  assert.ok(r.permitidos('OWNER').includes('admin.asignar'));
  assert.ok(alcanza('OWNER', 'VIEWER') && !alcanza('VIEWER', 'OPERATOR'));
});

test('CORS: origen ajeno se rechaza y no toca la base', async () => {
  const { d, llamadas } = deps();
  const r = await manejarAdmin(peticion('tablero', {}, { origin: 'https://malo.com' }), d);
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(llamadas, []);
  const pre = await manejarAdmin(new Request('http://local/admin', { method: 'OPTIONS', headers: { origin: ORIGEN } }), d);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGEN);
});

test('sin sesión: 401 sin tocar la base', async () => {
  const { d, llamadas } = deps();
  const r = await manejarAdmin(peticion('tablero', {}, { authorization: 'Bearer falso' }), d);
  assert.equal(r.status, 401);
  assert.deepEqual(llamadas, []);
});

test('sin segundo factor (aal1): 403 MFA_REQUIRED y queda auditado', async () => {
  const { d, llamadas } = deps({}, { aal: 'aal1' });
  const { status, body } = await leer(await manejarAdmin(peticion('tablero'), d));
  assert.equal(status, 403);
  assert.equal(body.code, 'MFA_REQUIRED');
  assert.equal(auditorias(llamadas).length, 1);
  assert.ok(!llamadas.some((l) => l.fn === 'admin_q_overview'));
});

test('usuario que no es admin: 403 NOT_ADMIN auditado', async () => {
  const { d, llamadas } = deps({}, { rol: null });
  const { status, body } = await leer(await manejarAdmin(peticion('tablero'), d));
  assert.equal(status, 403);
  assert.equal(body.code, 'NOT_ADMIN');
  assert.equal(auditorias(llamadas)[0].p_ok, false);
});

test('límite de peticiones: 429', async () => {
  const { d } = deps({}, { limite: false });
  assert.equal((await manejarAdmin(peticion('tablero'), d)).status, 429);
});

test('VIEWER no puede suspender: 403 y la negación se audita', async () => {
  const { d, llamadas } = deps({}, { rol: 'VIEWER' });
  const r = await manejarAdmin(peticion('licencia.estado', { id: LIC, status: 'suspendida', reason: 'falta de pago' }), d);
  assert.equal(r.status, 403);
  assert.ok(!llamadas.some((l) => l.fn === 'license_set_status'));
  assert.equal(auditorias(llamadas)[0].p_action, 'licencia.estado');
});

test('acción desconocida: 404', async () => {
  const { d } = deps();
  assert.equal((await manejarAdmin(peticion('borrar.todo'), d)).status, 404);
});

test('entrada inválida: 400 con el campo y sin llamar a la base', async () => {
  const { d, llamadas } = deps();
  const { status, body } = await leer(await manejarAdmin(peticion('licencia.estado', { id: 'no-uuid', status: 'suspendida', reason: 'motivo largo' }), d));
  assert.equal(status, 400);
  assert.match(body.error, /id/);
  assert.ok(!llamadas.some((l) => l.fn === 'license_set_status'));
  const sinMotivo = await manejarAdmin(peticion('licencia.estado', { id: LIC, status: 'suspendida', reason: 'x' }), d);
  assert.equal(sinMotivo.status, 400);
});

test('suspender: llama a license_set_status con la firma del admin y audita objetivo y motivo', async () => {
  const { d, llamadas } = deps({}, { rol: 'OPERATOR', respuestas: { license_set_status: { ok: true, from: 'activa', status: 'suspendida' } } });
  const { status, body } = await leer(await manejarAdmin(peticion('licencia.estado', { id: LIC, status: 'suspendida', reason: 'falta de pago', extra: 'x' }), d));
  assert.equal(status, 200);
  assert.equal(body.data.status, 'suspendida');
  const rpc = llamadas.find((l) => l.fn === 'license_set_status')!;
  assert.deepEqual(rpc.args, { p_license: LIC, p_status: 'suspendida', p_reason: 'falta de pago', p_actor: 'admin:u-1' });
  const a = auditorias(llamadas)[0];
  assert.equal(a.p_target, `licencia:${LIC}`);
  assert.equal(a.p_reason, 'falta de pago');
  assert.equal(a.p_ok, true);
  assert.equal((a.p_input as Record<string, unknown>).extra, undefined, 'los campos de más no viajan');
});

test('rechazo de negocio: se devuelve el código de la base (422) y se audita como fallido', async () => {
  const { d, llamadas } = deps({}, { respuestas: { license_downgrade_to_mono: { ok: false, code: 'DEVICES_OVER_LIMIT', error: 'Tiene 3 computadoras activas.' } } });
  const { status, body } = await leer(await manejarAdmin(peticion('licencia.mono', { id: LIC, reason: 'cliente pidió bajar' }), d));
  assert.equal(status, 422);
  assert.equal(body.code, 'DEVICES_OVER_LIMIT');
  assert.equal(auditorias(llamadas)[0].p_ok, false);
});

test('error de base: 500 genérico al navegador, detalle solo en la bitácora', async () => {
  const llamadasAudit: string[] = [];
  const { d } = deps({
    rpc: async (fn) => {
      if (fn === 'admin_gate') return { data: { ok: true, role: 'OWNER' }, error: null };
      if (fn === 'admin_audit_log') { llamadasAudit.push(fn); return { data: null, error: null }; }
      return { data: null, error: { message: 'relation "secreta" does not exist' } };
    },
  });
  const { status, body } = await leer(await manejarAdmin(peticion('tablero'), d));
  assert.equal(status, 500);
  assert.doesNotMatch(body.error, /secreta/);
  assert.equal(llamadasAudit.length, 1);
});

test('consulta inexistente: 404 NOT_FOUND', async () => {
  const { d } = deps({}, { respuestas: { admin_q_licencia: null } });
  assert.equal((await manejarAdmin(peticion('licencia', { id: LIC }), d)).status, 404);
});

test('renovar manual: arma p_purchase con días, pago y motivo', async () => {
  const { d, llamadas } = deps();
  await manejarAdmin(peticion('licencia.renovar', {
    id: LIC, kind: 'MANUAL', days: 60, payment: { provider: 'TRANSFER', ref: 'SPEI-1', amount: '1500' }, reason: 'renovación por transferencia',
  }), d);
  const rpc = llamadas.find((l) => l.fn === 'license_renew')!;
  assert.deepEqual(rpc.args.p_purchase, { provider: 'TRANSFER', ref: 'SPEI-1', price_paid: 1500, discount_reason: 'renovación por transferencia', days: 60 });
});

test('emitir licencia: el actor lo pone el servidor, no el navegador', async () => {
  const { d, llamadas } = deps();
  await manejarAdmin(peticion('licencia.emitir', {
    edition: 'EDITION_MONO', vertical: 'COMMERCE', origin: 'PRODUCTION',
    payment: { provider: 'COURTESY' }, customer: { name: 'Taller Ríos' }, reason: 'cortesía de lanzamiento', actor: 'web',
  }), d);
  const orden = llamadas.find((l) => l.fn === 'license_issue_manual')!.args.p_order as Record<string, unknown>;
  assert.equal(orden.actor, 'admin:u-1');
  assert.equal(orden.support, 'BASIC');
});

test('QA: solo viajan las llaves que se mandaron', async () => {
  const { d, llamadas } = deps();
  await manejarAdmin(peticion('licencia.qa', { id: LIC, grants: { verticals: ['COMMERCE'] }, reason: 'suite de pruebas' }), d);
  assert.deepEqual(llamadas.find((l) => l.fn === 'license_qa_grant')!.args.p_grants, { verticals: ['COMMERCE'] });
});

test('OPERATOR no cambia precios; OWNER sí', async () => {
  const op = deps({}, { rol: 'OPERATOR' });
  assert.equal((await manejarAdmin(peticion('catalogo.precio', { code: 'EDITION_MONO', list_price: 100, reason: 'ajuste anual' }), op.d)).status, 403);
  const ow = deps({}, { rol: 'OWNER' });
  assert.equal((await manejarAdmin(peticion('catalogo.precio', { code: 'EDITION_MONO', list_price: 100, reason: 'ajuste anual' }), ow.d)).status, 200);
  assert.deepEqual(ow.llamadas.find((l) => l.fn === 'license_catalog_update')!.args.p_changes, { list_price: 100 });
});

test('yo: devuelve rol y permisos para que el panel oculte lo demás', async () => {
  const { d } = deps({}, { rol: 'VIEWER' });
  const { body } = await leer(await manejarAdmin(peticion('yo'), d));
  assert.equal(body.data.rol, 'VIEWER');
  assert.ok(body.data.permitidos.includes('tablero'));
  assert.ok(!body.data.permitidos.includes('licencia.emitir'));
});

test('sesión cerrada (admin_gate): 401 aunque el JWT no haya vencido', async () => {
  const { d, llamadas } = deps({}, { cerrada: true });
  const { status, body } = await leer(await manejarAdmin(peticion('tablero'), d));
  assert.equal(status, 401);
  assert.equal(body.code, 'UNAUTHORIZED');
  assert.ok(!llamadas.some((l) => l.fn === 'admin_q_overview'));
});

test('puerta: un solo viaje previo a la consulta, con usuario y sesión del JWT', async () => {
  const { d, llamadas } = deps();
  await manejarAdmin(peticion('tablero'), d);
  assert.deepEqual(llamadas.map((l) => l.fn), ['admin_gate', 'admin_q_overview']);
  assert.equal(llamadas[0].args.p_user, 'u-1');
  assert.equal(llamadas[0].args.p_session, 's-1');
});
