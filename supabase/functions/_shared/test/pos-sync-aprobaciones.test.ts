import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manejarPosSync, type DepsPosSync } from '../pos-sync.ts';

function deps(resp: Record<string, any> = {}) {
  const llamadas: Array<{ fn: string; args: any }> = [];
  const d = {
    rpc: async (fn: string, args: any) => {
      llamadas.push({ fn, args });
      if (fn === 'device_autenticar') return args.token === 'credencial-de-la-tablet-1234567890' ? { ok: true, device_id: 'tablet-1', company_id: 'c', location_id: 'l', kind: 'MOBILE_POS' } : { ok: false };
      return resp[fn] ?? { ok: true, status: 'PENDING' };
    },
    espejo: { escribir: async () => null, existeAlerta: async () => false },
    borrarUsuario: async () => undefined,
  } as unknown as DepsPosSync;
  return { d, llamadas };
}
const req = (body: unknown, credencial: string | null = 'credencial-de-la-tablet-1234567890') => new Request('http://local/pos-sync', {
  method: 'POST', headers: credencial ? { 'x-wybix-device': credencial, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('approval_request: el device_id sale de la credencial aunque el cuerpo diga otro', async () => {
  const { d, llamadas } = deps();
  const r = await manejarPosSync(req({ action: 'approval_request', device_id: 'OTRA-TABLET', id: 'a1', approval_action: 'MERMA',
    requested_by: { uuid: 'e1', name: 'lupita', role: 'CASHIER' }, payload: { cantidad: '3' } }), d);
  assert.equal(r.status, 200);
  const c = llamadas.find((l) => l.fn === 'aprobacion_solicitar')!;
  assert.equal(c.args.device_id, 'tablet-1');
  assert.deepEqual(c.args.payload, { cantidad: '3' });
  assert.equal(c.args.action, 'MERMA');
});

test('sin credencial válida no se pide, consulta ni consume nada', async () => {
  for (const action of ['approval_request', 'approval_status', 'approval_consume', 'approval_cancel']) {
    const { d, llamadas } = deps();
    const r = await manejarPosSync(req({ action, id: 'a1' }, null), d);
    assert.equal(r.status, 401, action);
    assert.ok(!llamadas.some((l) => l.fn.startsWith('aprobacion_')), action);
  }
});

test('un payload que no es objeto no llega como tal (null)', async () => {
  const { d, llamadas } = deps();
  await manejarPosSync(req({ action: 'approval_consume', id: 'a1', payload: ['no', 'objeto'] }), d);
  assert.equal(llamadas.find((l) => l.fn === 'aprobacion_consumir')!.args.payload, null);
});

test('errores de la nube llegan con su código', async () => {
  const { d } = deps({ aprobacion_consumir: { ok: false, code: 'PAYLOAD_CHANGED' } });
  const r = await manejarPosSync(req({ action: 'approval_consume', id: 'a1', payload: {} }), d);
  const j = await r.json();
  assert.equal(r.status, 403);
  assert.equal(j.code, 'PAYLOAD_CHANGED');
  assert.match(j.error, /cambió/);
});
