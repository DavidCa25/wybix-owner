import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketEscPos, ascii } from '../lib/escpos.ts';

const t = { negocio: 'I Do Nut', ubicacion: 'Feria León 2026', folio: 'F1-000123', fecha: '01/11/2026 19:05', cajero: 'lupita',
  lineas: [{ cantidad: '2', nombre: 'Dona glaseada', importe: '$50.00' }], total: '$50.00', pagos: [{ metodo: 'Efectivo', monto: '$100.00' }], cambio: '50.00' };

test('ESC/POS: inicializa, imprime en ASCII seguro y corta', () => {
  const b = ticketEscPos(t);
  assert.deepEqual([...b.slice(0, 2)], [0x1b, 0x40]);
  assert.deepEqual([...b.slice(-4)], [0x1d, 0x56, 66, 0]);
  const texto = Buffer.from(b).toString('latin1');
  assert.ok(texto.includes('Feria Leon 2026') && texto.includes('F1-000123') && texto.includes('Cambio'));
  assert.ok([...b].every((x) => x < 0x80), 'sin bytes fuera de ASCII');
  assert.equal(ascii('Atendió: Ñoño'), 'Atendio: Nono');
  assert.equal(ascii('7:05:58 p.m.'), '7:05:58 p.m.', 'la hora de Android no imprime "?"');
});
