import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manejarOwnerMfa, type DepsOwnerMfa } from '../owner-mfa.ts';

function deps(rpcResp: Record<string, any> = {}, over: Partial<DepsOwnerMfa> = {}) {
  const log: string[] = [];
  const d: DepsOwnerMfa = {
    usuarioDeJwt: async (jwt) => (jwt === 'jwt-bueno' ? { id: 'u1' } : null),
    rpc: async (nombre, args) => { log.push(`rpc:${nombre}:${JSON.stringify(args)}`); return { data: rpcResp[nombre] ?? { ok: true }, error: null }; },
    factores: async () => [{ id: 'f1' }, { id: 'f2' }],
    borrarFactor: async (_u, f) => { log.push(`borrar:${f}`); },
    cerrarOtrasSesiones: async () => { log.push('cerrar-otras'); },
    ...over,
  };
  return { d, log };
}
const req = (jwt: string | null, body: unknown) => new Request('http://local/owner-mfa', {
  method: 'POST', headers: jwt ? { Authorization: `Bearer ${jwt}` } : {}, body: JSON.stringify(body),
});

test('sin sesión válida: 401 y no se toca nada', async () => {
  const { d, log } = deps();
  assert.equal((await manejarOwnerMfa(req(null, { action: 'recuperar', codigo: 'AAAAA-BBBBB' }), d)).status, 401);
  assert.equal((await manejarOwnerMfa(req('jwt-falso', { action: 'recuperar', codigo: 'AAAAA-BBBBB' }), d)).status, 401);
  assert.deepEqual(log, []);
});

test('código con forma inválida: ni siquiera se consulta (no gasta intentos)', async () => {
  const { d, log } = deps();
  assert.equal((await manejarOwnerMfa(req('jwt-bueno', { action: 'recuperar', codigo: '123' }), d)).status, 400);
  assert.deepEqual(log, []);
});

test('código inválido o bloqueado: no se quitan factores', async () => {
  const a = deps({ mfa_consumir_codigo: { ok: false, code: 'INVALID_CODE' } });
  const r1 = await manejarOwnerMfa(req('jwt-bueno', { action: 'recuperar', codigo: 'AAAAA-BBBBB' }), a.d);
  assert.equal(r1.status, 400);
  assert.ok(!a.log.some((l) => l.startsWith('borrar')));
  const b = deps({ mfa_consumir_codigo: { ok: false, code: 'RATE_LIMITED' } });
  const r2 = await manejarOwnerMfa(req('jwt-bueno', { action: 'recuperar', codigo: 'AAAAA-BBBBB' }), b.d);
  assert.equal(r2.status, 429);
  assert.equal((await r2.json()).code, 'RATE_LIMITED');
  assert.ok(!b.log.some((l) => l.startsWith('borrar')));
});

test('código válido: se consume CON el usuario del JWT, se quitan todos los factores, se cierran las otras sesiones y se audita', async () => {
  const { d, log } = deps();
  const r = await manejarOwnerMfa(req('jwt-bueno', { action: 'recuperar', codigo: 'aaaaa bbbbb', user_id: 'OTRA-PERSONA' }), d);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, factores_quitados: 2 });
  assert.match(log[0], /^rpc:mfa_consumir_codigo:\{"p_user":"u1"/, 'el usuario sale del JWT, nunca del cuerpo');
  assert.deepEqual(log.slice(1), ['borrar:f1', 'borrar:f2', 'cerrar-otras', 'rpc:mfa_recuperacion_completada:{"p_user":"u1","p_factores_quitados":2}']);
});

test('si falla a medias, lo dice y lo audita (el código ya se gastó)', async () => {
  const { d, log } = deps({}, { borrarFactor: async (_u, f) => { if (f === 'f2') throw new Error('auth caído'); log.push(`borrar:${f}`); } });
  const r = await manejarOwnerMfa(req('jwt-bueno', { action: 'recuperar', codigo: 'AAAAA-BBBBB' }), d);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { ok: false, code: 'PARTIAL', factores_quitados: 1 });
  assert.ok(log.some((l) => l.startsWith('rpc:mfa_recuperacion_completada') && l.includes('"p_factores_quitados":1')));
});
