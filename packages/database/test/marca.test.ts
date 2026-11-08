import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base, snapshot } from './fixture.ts';
import { aplicarSnapshot, type MarcaGuardada } from '../src/index.ts';

const LOGO = 'data:image/png;base64,iVBORw0KGgo=';
const leer = async (db: Awaited<ReturnType<typeof base>>['db']) => {
  const r = await db.get<{ v: string }>(`SELECT v FROM kv WHERE k = 'marca'`);
  return r ? JSON.parse(r.v) as MarcaGuardada : null;
};

test('marca: llega con el snapshot, se conserva sin reenviar el logo y se quita con brand = null', async () => {
  const { raw, db } = await base();
  try {
    assert.equal(await leer(db), null, 'sin marca: Wybix');
    await aplicarSnapshot(db, { ...snapshot(), brand: { hash: 'h1', color: '#E91E63', logo_incluido: true, logo: LOGO } });
    assert.deepEqual(await leer(db), { hash: 'h1', color: '#E91E63', logo: LOGO });
    // Misma marca: la nube ya no manda el logo; la tablet conserva el suyo.
    await aplicarSnapshot(db, { ...snapshot(), brand: { hash: 'h1', color: '#E91E63', logo_incluido: false, logo: null } });
    assert.deepEqual(await leer(db), { hash: 'h1', color: '#E91E63', logo: LOGO });
    // Una nube anterior a la marca (sin el campo) no borra nada.
    await aplicarSnapshot(db, snapshot());
    assert.equal((await leer(db))?.logo, LOGO);
    // La dueña cambió el color y quitó el logo.
    await aplicarSnapshot(db, { ...snapshot(), brand: { hash: 'h2', color: '#1F2E86', logo_incluido: true, logo: null } });
    assert.deepEqual(await leer(db), { hash: 'h2', color: '#1F2E86', logo: null });
    // Quitó la marca: regresa a Wybix.
    await aplicarSnapshot(db, { ...snapshot(), brand: null });
    assert.equal(await leer(db), null);
  } finally { raw.close(); }
});

test('marca: si la nube no incluyó el logo de un hash que la tablet no tenía, lo vuelve a pedir', async () => {
  const { raw, db } = await base();
  try {
    await aplicarSnapshot(db, { ...snapshot(), brand: { hash: 'h9', color: '#E91E63', logo_incluido: false, logo: null } });
    assert.deepEqual(await leer(db), { hash: '', color: '#E91E63', logo: null }, 'sin hash: el siguiente snapshot trae el logo');
  } finally { raw.close(); }
});
