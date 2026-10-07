import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { usarMotorScrypt, type MotorScrypt } from '@wybix/auth';
import { adaptadorNode, crearPos, identificar } from '../src/index.ts';
import { base, U, PIN, lupita } from './fixture.ts';

/*
 * El PIN se verifica con el scrypt FUERA de la transacción. Lo que no puede
 * cambiar: el límite de intentos, el bloqueo, la auditoría sin el PIN, el
 * rol del evento y que todo sobreviva a un reinicio.
 */
let llamadas = 0;
const openssl: MotorScrypt = (pw, salt, N, r, p, dkLen) => new Promise((ok, mal) => {
  llamadas++;
  crypto.scrypt(pw, salt, dkLen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (e, dk) => (e ? mal(e) : ok(dk.toString('hex'))));
});

test('con motor nativo: correcto entra con el rol del EVENTO, incorrecto no; se mide cada etapa', async () => {
  usarMotorScrypt(openssl, 'openssl');
  const { db } = await base();
  let m: any = null;
  const ok = await identificar(db, U.lupita, PIN.lupita, new Date(), (x) => { m = x; });
  assert.equal(ok.ok && ok.persona.role, 'CASHIER');
  assert.ok(m && m.scrypt >= 0 && m.total >= m.scrypt, 'mide lectura, scrypt y escritura');
  const mal = await identificar(db, U.lupita, '9137');
  assert.equal(mal.ok, false);
  assert.equal((mal as any).error, 'PIN incorrecto.');
  const nadie = await identificar(db, '00000000-0000-4000-8000-000000000099', '9137');
  assert.equal((nadie as any).error, 'PIN incorrecto.', 'respuesta uniforme sin persona');
  usarMotorScrypt(null);
});

test('5 intentos A LA VEZ no se saltan el límite: queda bloqueada', async () => {
  usarMotorScrypt(openssl, 'openssl');
  const { db } = await base();
  await Promise.all(Array.from({ length: 5 }, () => identificar(db, U.lupita, '9137')));
  const b = await identificar(db, U.lupita, PIN.lupita);
  assert.equal(b.ok, false);
  assert.equal((b as any).bloqueado, true);
  usarMotorScrypt(null);
});

test('bloqueada: no se gasta ningún scrypt y el bloqueo sobrevive a reiniciar la app', async () => {
  usarMotorScrypt(openssl, 'openssl');
  const dir = mkdtempSync(join(tmpdir(), 'wx-pin-'));
  const archivo = join(dir, 'pos.db');
  const t0 = new Date('2026-11-01T12:00:00Z');
  const { raw, db } = await base(archivo);
  for (let i = 0; i < 5; i++) await identificar(db, U.lupita, '9137', t0);
  raw.close();
  // "Reinicio": se cierra y se abre el archivo.
  const raw2 = new DatabaseSync(archivo);
  const db2 = adaptadorNode(raw2);
  llamadas = 0;
  const b = await identificar(db2, U.lupita, PIN.lupita, new Date(t0.getTime() + 60_000));
  assert.equal((b as any).bloqueado, true, 'sigue bloqueada tras reiniciar');
  assert.equal(llamadas, 0, 'bloqueada: no calcula scrypt');
  const despues = await identificar(db2, U.lupita, PIN.lupita, new Date(t0.getTime() + 6 * 60_000));
  assert.equal(despues.ok, true, 'pasado el bloqueo, entra');
  const aud = JSON.stringify(await db2.all('SELECT * FROM audit_local'));
  assert.ok(!aud.includes(PIN.lupita) && !aud.includes('9137'), 'la auditoría no guarda el PIN');
  assert.equal((await db2.all(`SELECT * FROM audit_local WHERE action = 'PIN' AND result = 'BLOQUEADO'`)).length >= 2, true);
  raw2.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
  usarMotorScrypt(null);
});

test('offline y con permisos locales: la persona identificada opera según su rol', async () => {
  usarMotorScrypt(openssl, 'openssl');
  const { db } = await base();
  const pos = crearPos(db);
  const r = await identificar(db, U.lupita, PIN.lupita);
  assert.ok(r.ok);
  await assert.rejects(pos.registrarAjuste(lupita, U.dona, '-1', 'conteo'), /encargad|permiso/i, 'el cajero no ajusta');
  usarMotorScrypt(null);
});
