import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manejarPosSync, type DepsPosSync } from '../pos-sync.ts';

function deps(resp: Record<string, any> = {}) {
  const llamadas: Array<{ fn: string; args: any }> = [];
  const d = {
    rpc: async (fn: string, args: any) => {
      llamadas.push({ fn, args });
      if (fn === 'device_autenticar') return args.token === 'credencial-de-la-caja-1234567890' ? { ok: true, device_id: 'caja-1', company_id: 'c', location_id: 'l', kind: 'POS_PRIMARY' } : { ok: false };
      return resp[fn] ?? { ok: true };
    },
    espejo: { escribir: async () => null, existeAlerta: async () => false },
    borrarUsuario: async () => undefined,
  } as unknown as DepsPosSync;
  return { d, llamadas };
}
const req = (body: unknown, credencial: string | null = 'credencial-de-la-caja-1234567890') => new Request('http://local/pos-sync', {
  method: 'POST', headers: credencial ? { 'x-wybix-device': credencial, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('multisucursal: el equipo sale de la credencial, nunca del cuerpo', async () => {
  for (const action of ['multi_estado', 'multi_publicar', 'multi_recibir', 'multi_excepciones', 'multi_traspaso_enviar', 'multi_traspaso_recibir', 'multi_traspaso_cancelar', 'multi_traspaso_bandeja']) {
    const { d, llamadas } = deps();
    const r = await manejarPosSync(req({ action, device_id: 'OTRA', company_id: 'OTRA', catalog: { products: [] } }), d);
    assert.equal(r.status, 200, action);
    const c = llamadas.find((l) => l.fn === action)!;
    assert.equal(c.args.device_id, 'caja-1', action);
    assert.ok(!('company_id' in c.args), action);
  }
});

test('sin credencial no se publica ni se traspasa nada', async () => {
  for (const action of ['multi_publicar', 'multi_traspaso_enviar']) {
    const { d, llamadas } = deps();
    const r = await manejarPosSync(req({ action }, null), d);
    assert.equal(r.status, 401);
    assert.ok(!llamadas.some((l) => l.fn === action));
  }
});

test('un catálogo o unas reglas que no son objeto llegan como null', async () => {
  const { d, llamadas } = deps();
  await manejarPosSync(req({ action: 'multi_publicar', catalog: [1, 2] }), d);
  await manejarPosSync(req({ action: 'multi_excepciones', reglas: 'todo', items: 'x' }), d);
  assert.equal(llamadas.find((l) => l.fn === 'multi_publicar')!.args.catalog, null);
  const e = llamadas.find((l) => l.fn === 'multi_excepciones')!.args;
  assert.equal(e.reglas, null);
  assert.equal(e.items, null);
});

test('los códigos de la nube llegan con mensaje en español', async () => {
  const { d } = deps({ multi_publicar: { ok: false, code: 'NOT_MATRIZ' }, multi_recibir: { ok: false, code: 'NO_ENTITLEMENT_MULTIBRANCH' } });
  const a = await (await manejarPosSync(req({ action: 'multi_publicar', catalog: { products: [] } }), d)).json();
  assert.match(a.error, /matriz/);
  const b = await (await manejarPosSync(req({ action: 'multi_recibir' }), d)).json();
  assert.match(b.error, /MultiSucursal/);
});
