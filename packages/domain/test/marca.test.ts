import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarColor, logoValido, contraste, temaDeMarca, COLOR_WYBIX, LOGO_MAX_CARACTERES } from '../src/marca.ts';

const legible = (a: string, b: string) => contraste(a, b) >= 4.5;

test('color: acepta #RGB y #RRGGBB con o sin #; rechaza lo demás', () => {
  assert.equal(normalizarColor('#e91e63'), '#E91E63');
  assert.equal(normalizarColor('e91e63'), '#E91E63');
  assert.equal(normalizarColor(' #f0a '), '#FF00AA');
  for (const malo of ['', null, undefined, 'rojo', '#12345', '#1234567', 'rgb(1,2,3)', '#GGGGGG']) assert.equal(normalizarColor(malo), null, String(malo));
});

test('logo: solo PNG/JPEG/WebP en base64 y con tamaño acotado', () => {
  assert.ok(logoValido('data:image/png;base64,iVBORw0KGgo='));
  assert.ok(logoValido('data:image/webp;base64,UklGRg=='));
  assert.ok(!logoValido('data:image/svg+xml;base64,PHN2Zz4='), 'SVG no: puede llevar scripts y RN no lo pinta sin librería');
  assert.ok(!logoValido('https://ejemplo.com/logo.png'), 'URL no: la tablet trabaja sin Internet');
  assert.ok(!logoValido('data:image/png;base64,<script>'));
  assert.ok(!logoValido('data:image/png;base64,' + 'A'.repeat(LOGO_MAX_CARACTERES)));
  assert.ok(!logoValido(null));
});

test('sin color de marca, la tablet usa el de Wybix', () => {
  assert.equal(temaDeMarca(null).acento, COLOR_WYBIX);
  assert.equal(temaDeMarca('no-es-color').acento, COLOR_WYBIX);
});

test('tema: con cualquier color, el texto siempre se lee', () => {
  const colores = ['#FFFFFF', '#FFF200', '#F7C6D9', '#E91E63', '#167F92', '#000000', '#7FFF00', '#1F2E86', '#FF6F00', '#808080'];
  for (const c of colores) {
    const t = temaDeMarca(c);
    assert.ok(legible(t.acento, t.acentoTexto), `texto sobre ${c}`);
    assert.ok(legible(t.acentoTinta, '#FFFFFF'), `tinta de ${c} sobre blanco`);
    assert.ok(legible(t.seleccion, '#102B40'), `selección de ${c} con texto oscuro`);
  }
});

test('tema: un color oscuro lleva texto blanco; uno claro, tinta oscura y se oscurece para escribir', () => {
  const azul = temaDeMarca('#1F2E86');
  assert.deepEqual([azul.acento, azul.acentoTexto, azul.acentoTinta], ['#1F2E86', '#FFFFFF', '#1F2E86'], 'ya es legible: no se toca');
  const rosa = temaDeMarca('#E91E63');
  assert.equal(rosa.acentoTexto, '#FFFFFF');
  assert.ok(contraste(rosa.acento, '#E91E63') < 1.3, 'el rosa medio solo se oscurece lo mínimo');
  const amarillo = temaDeMarca('#FFF200');
  assert.equal(amarillo.acento, '#FFF200', 'el botón conserva el color de la marca');
  assert.notEqual(amarillo.acentoTexto, '#FFFFFF');
  assert.notEqual(amarillo.acentoTinta, '#FFF200');
});
