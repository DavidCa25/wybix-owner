import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canalInicial, CANAL_MOSTRADOR } from '../src/canal-evento.ts';
import type { PoliticaComercial } from '../src/comercial.ts';

const politica: PoliticaComercial = {
  version: 1, prices: [], promotions: [], combos: [],
  channels: [
    { id: 'LOCAL', name: 'Mostrador', active: true, inheritBase: true },
    { id: 'FERIA', name: 'Feria', active: true, inheritBase: false },
    { id: 'VIEJO', name: 'Canal viejo', active: false, inheritBase: true },
  ],
};

test('canal del evento: si el catálogo lo trae activo, la cuenta empieza ahí', () => {
  assert.equal(canalInicial(politica, 'FERIA'), 'FERIA');
});

test('sin canal, canal inactivo, desconocido o sin política: Mostrador', () => {
  assert.equal(canalInicial(politica, null), CANAL_MOSTRADOR);
  assert.equal(canalInicial(politica, 'VIEJO'), CANAL_MOSTRADOR);
  assert.equal(canalInicial(politica, 'NO_EXISTE'), CANAL_MOSTRADOR);
  assert.equal(canalInicial(undefined, 'FERIA'), CANAL_MOSTRADOR);
});
