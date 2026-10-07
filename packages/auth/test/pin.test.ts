import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { hashPin, verificarPin, FALLOS_MAX } from '../src/index.ts';

// El MISMO hash que genera el POS de Windows (electron/local-host/credenciales.js).
const POS = process.env.WYBIX_POS ?? 'C:/Users/Casillas/filtros_lubs_rios';
const credenciales = createRequire(import.meta.url)(`${POS}/electron/local-host/credenciales.js`);

test('el hash del POS Mobile es idéntico al del POS de Windows', () => {
  const { hash, sal } = credenciales.hashPin('4821');
  assert.equal(hashPin('4821', sal), hash);
  assert.notEqual(hashPin('4822', sal), hash);
});

test('PIN correcto, incorrecto, bloqueo al quinto fallo y respuesta uniforme', () => {
  const { hash, sal } = credenciales.hashPin('4821');
  const p = { pin_hash: hash, pin_sal: sal, pin_algo: 'scrypt:16384:8:1:32', active: true };
  const t0 = new Date('2026-11-01T12:00:00Z');
  assert.equal(verificarPin('4821', p, null, t0).resultado.ok, true);
  let est = null as any, r = null as any;
  for (let i = 0; i < FALLOS_MAX; i++) { r = verificarPin('0000', p, est, t0); est = r.intentos; }
  assert.equal(r.resultado.bloqueado, true);
  assert.equal(verificarPin('4821', p, est, new Date(t0.getTime() + 60_000)).resultado.ok, false, 'bloqueado aun con el PIN correcto');
  assert.equal(verificarPin('4821', p, est, new Date(t0.getTime() + 6 * 60_000)).resultado.ok, true, 'pasado el bloqueo, entra');
  const sinPersona = verificarPin('4821', null, null, t0).resultado as any;
  const malo = verificarPin('1111', p, null, t0).resultado as any;
  assert.equal(sinPersona.error, malo.error);
  assert.equal(verificarPin('4821', { ...p, active: false }, null, t0).resultado.ok, false, 'inactivo no entra');
});
