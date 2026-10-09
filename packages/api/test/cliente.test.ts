import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearClienteNube, ErrorNube } from '../src/index.ts';

function cliente(respuestas: Array<{ status?: number; body: unknown; date?: string }>) {
  const peticiones: any[] = [];
  const c = crearClienteNube({
    base: 'https://nube', anonKey: 'anon', version: '0.1.0', credencial: async () => 'credencial-de-la-tablet-1234567890',
    identidad: async () => ({ company_uuid: 'c', location_uuid: 'l' }),
    fetch: (async (_u: string, init: any) => {
      peticiones.push(JSON.parse(init.body));
      const r = respuestas.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.date ? { date: r.date } : {} });
    }) as typeof fetch,
  });
  return { c, peticiones };
}

test('desfase: se mide con la cabecera Date de la respuesta (servidor - tablet)', async () => {
  const futuro = new Date(Date.now() + 2 * 3600_000).toUTCString();     // el servidor va 2 h adelante
  const { c } = cliente([{ body: { success: true }, date: futuro }]);
  assert.ok(c.desfase);
  assert.ok(c.latido);
  assert.equal(c.desfase(), null, 'sin respuestas todavía no hay medición');
  await c.latido({ pendientes: 0 } as any);
  const d = c.desfase()!;
  assert.ok(Math.abs(d.ms - 2 * 3600_000) < 2000, `desfase medido ${d.ms}`);
});

test('una respuesta sin cabecera Date no borra la última medición', async () => {
  const { c } = cliente([{ body: { success: true }, date: new Date().toUTCString() }, { body: { success: true } }]);
  assert.ok(c.desfase);
  assert.ok(c.latido);
  await c.latido({ pendientes: 0 } as any);
  const antes = c.desfase();
  await c.latido({ pendientes: 0 } as any);
  assert.deepEqual(c.desfase(), antes);
});

test('aprobaciones: el cuerpo lleva la acción y el payload, nunca un device_id', async () => {
  const { c, peticiones } = cliente([{ body: { success: true, id: 'a1', status: 'PENDING' } }]);
  await c.aprobaciones.solicitar({ id: 'a1', accion: 'MERMA', solicita: { uuid: 'e', name: 'lupita', role: 'CASHIER' }, payload: { cantidad: '3' } });
  assert.deepEqual(peticiones[0], { action: 'approval_request', id: 'a1', approval_action: 'MERMA', requested_by: { uuid: 'e', name: 'lupita', role: 'CASHIER' }, payload: { cantidad: '3' } });
  assert.ok(!('device_id' in peticiones[0]));
});

test('snapshot anuncia soporte comercial y conserva UPDATE_REQUIRED sin revocar el equipo', async () => {
  const {c,peticiones}=cliente([{body:{success:true,catalog:{}}},{status:409,body:{success:false,code:'UPDATE_REQUIRED',error:'Actualiza Wybix'}}]);
  await c.snapshot({snapshot_version:0,catalog_version:0,security_revision:0});assert.deepEqual(peticiones[0],{action:'mobile_snapshot',commercial_schema:2});
  await assert.rejects(c.snapshot({snapshot_version:0,catalog_version:0,security_revision:0}),e=>e instanceof ErrorNube && e.status===409 && e.code==='UPDATE_REQUIRED');
});
