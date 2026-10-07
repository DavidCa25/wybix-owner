import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { hashPin, hashPinAsync, pinCoincide, usarMotorScrypt, motorScryptActual, evaluarIntento, FALLOS_MAX, type MotorScrypt } from '../src/index.ts';

/*
 * El motor de scrypt cambia (nativo en Android, JavaScript en lo demás); el
 * RESULTADO no. Se prueba contra los vectores oficiales del RFC 7914, contra
 * hashes creados por el POS de Windows y entre motores.
 */
const POS = process.env.WYBIX_POS || 'C:/Users/Casillas/filtros_lubs_rios';
const credenciales = createRequire(import.meta.url)(`${POS}/electron/local-host/credenciales.js`);

// Un motor "nativo" de referencia: OpenSSL de Node (lo mismo que usa el POS de Windows).
const motorOpenSsl: MotorScrypt = (pw, salt, N, r, p, dkLen) => new Promise((ok, mal) =>
  crypto.scrypt(pw, salt, dkLen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (e, dk) => (e ? mal(e) : ok(dk.toString('hex')))));

test('RFC 7914 §12: vectores oficiales con el motor de JavaScript y con OpenSSL', async () => {
  const v3 = '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887';
  const v2 = 'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640';
  for (const [nombre, m] of [['js', null], ['openssl', motorOpenSsl]] as const) {
    usarMotorScrypt(m as MotorScrypt | null, nombre);
    // hashPinAsync usa los parámetros del algoritmo declarado.
    assert.equal(await hashPinAsync('pleaseletmein', 'SodiumChloride', 'scrypt:16384:8:1:64'), v3, `${nombre}: vector 3`);
    assert.equal(await hashPinAsync('password', 'NaCl', 'scrypt:1024:8:16:64'), v2, `${nombre}: vector 2`);
  }
  usarMotorScrypt(null);
});

test('hashes del POS de Windows: verifican igual con cualquier motor', async () => {
  for (const m of [null, motorOpenSsl]) {
    usarMotorScrypt(m, 'openssl');
    for (const pin of ['4821', '7305', '19283746', '0482']) {
      const { hash, sal } = credenciales.hashPin(pin);
      const persona = { pin_hash: hash, pin_sal: sal, pin_algo: 'scrypt:16384:8:1:32', active: true };
      assert.equal(await pinCoincide(pin, persona), true, `${motorScryptActual()} ${pin}`);
      assert.equal(await pinCoincide(pin === '4821' ? '4822' : '4821', persona), false);
    }
  }
  usarMotorScrypt(null);
});

test('los motores dan el mismo hash en 25 PIN y sales al azar (y el síncrono también)', async () => {
  for (let i = 0; i < 25; i++) {
    const pin = String(crypto.randomInt(0, 99_999_999)).padStart(4 + (i % 5), '0');
    const sal = crypto.randomBytes(16).toString('hex');
    usarMotorScrypt(null);
    const js = await hashPinAsync(pin, sal);
    usarMotorScrypt(motorOpenSsl, 'openssl');
    const ossl = await hashPinAsync(pin, sal);
    assert.equal(js, ossl);
    assert.equal(hashPin(pin, sal), js);
  }
  usarMotorScrypt(null);
});

test('la política no cambia: 5 fallos bloquean, el bloqueo gana al PIN correcto', () => {
  const t0 = new Date('2026-11-01T12:00:00Z');
  let est = null as Parameters<typeof evaluarIntento>[2];
  for (let i = 0; i < FALLOS_MAX - 1; i++) est = evaluarIntento(false, { active: true }, est, t0).intentos;
  const quinto = evaluarIntento(false, { active: true }, est, t0);
  assert.equal(quinto.resultado.ok, false);
  assert.equal((quinto.resultado as any).bloqueado, true);
  assert.equal(evaluarIntento(true, { active: true }, quinto.intentos, new Date(t0.getTime() + 60_000)).resultado.ok, false);
  assert.equal(evaluarIntento(true, { active: true }, quinto.intentos, new Date(t0.getTime() + 6 * 60_000)).resultado.ok, true);
  assert.equal(evaluarIntento(true, { active: false }, null, t0).resultado.ok, false, 'inactivo no entra aunque coincida');
});

test('sin persona se gasta igual un scrypt (respuesta uniforme)', async () => {
  let llamadas = 0;
  usarMotorScrypt(async (...a) => { llamadas++; return motorOpenSsl(...a); }, 'contador');
  assert.equal(await pinCoincide('4821', null), false);
  assert.equal(llamadas, 1);
  usarMotorScrypt(null);
});
