// IEPS desglosado e impuestos locales en la factura (POS 0083/0085).
//
// Lo que se prueba, con un Fiscalapi simulado:
//   · sin desglose, el concepto sale igual que siempre (POS viejo);
//   · con desglose y el cálculo de Fiscalapi igual a lo cobrado: concepto sin
//     IEPS, IVA + IEPS (003) por concepto y complemento de impuestos locales;
//   · si el cálculo NO da lo cobrado (o falla), se timbra la factura de siempre
//     y se dice por qué: nunca sale un total distinto al del ticket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conceptos, impuestosLocales, timbrar } from '../fiscal.ts';

const papas = {
  description: 'Papas 45 g', quantity: 2, unitPrice: 50, taxObject: '02', taxRate: 0.16, claveProdServ: '50192100', claveUnidad: 'H87',
  desglose: { unitPrice: 46.296296, extraTaxes: [{ taxCode: '003', taxTypeCode: 'Tasa', taxRate: 0.08 }, { taxCode: '002', taxTypeCode: 'Tasa', taxRate: 0.5 }] },
};

test('conceptos: sin desglose, como siempre; con desglose, sin IEPS en el precio y con el IEPS 003 (solo 003 entra)', () => {
  const [viejo] = conceptos([papas], false);
  assert.equal(viejo.unitPrice, 50);
  assert.deepEqual(viejo.itemTaxes, [{ taxCode: '002', taxTypeCode: 'Tasa', taxRate: '0.160000', taxFlagCode: 'T' }]);
  const [nuevo] = conceptos([papas], true);
  assert.equal(nuevo.unitPrice, 46.296296);
  assert.deepEqual(nuevo.itemTaxes, [
    { taxCode: '002', taxTypeCode: 'Tasa', taxRate: '0.160000', taxFlagCode: 'T' },
    { taxCode: '003', taxTypeCode: 'Tasa', taxRate: '0.080000', taxFlagCode: 'T' },
  ]);
  const [exento] = conceptos([{ ...papas, taxObject: '01' }], true);
  assert.equal(exento.itemTaxes, undefined, 'un concepto que no es objeto de impuesto no lleva IEPS');
});

test('impuestos locales: solo los completos, con 6 decimales en la tasa y 2 en el importe', () => {
  assert.deepEqual(impuestosLocales([{ taxName: 'ISH', taxRate: 0.03, taxAmount: 30 }, { taxName: '', taxRate: 0.03, taxAmount: 1 }, { taxName: 'X', taxRate: 0, taxAmount: 1 }]),
    [{ taxName: 'ISH', taxRate: '0.030000', taxAmount: '30.00', taxFlagCode: 'T' }]);
});

function deps(totalCalculado: number | null, calcOk = true) {
  const llamadas: any[] = [];
  return {
    llamadas,
    rpc: async (fn: string) => (fn === 'device_autenticar' ? { ok: true, device_id: 'eq-1', company_id: 'c-1' }
      : fn === 'fiscal_autorizar' ? { ok: true, issuer: { id: 'i-1', person_id: 'p-1', tax_regime: '601', zip_code: '44100' } } : { ok: true }),
    fapi: async (path: string, init: any) => {
      llamadas.push([path, init.body]);
      if (path === '/api/v4/people') return { ok: true, status: 200, out: { data: { id: 'rec-1' } } };
      if (path === '/api/v4/invoices/calculate') return calcOk ? { ok: true, status: 200, out: { data: { total: totalCalculado } } } : { ok: false, status: 400, out: { details: 'no' } };
      return { ok: true, status: 200, out: { data: { id: 'f-1', uuid: 'u-1', total: 116 } } };
    },
    permitirLegado: false,
  };
}
const req = (cuerpo: any) => new Request('https://local.test/fiscal-stamp-invoice', {
  method: 'POST', headers: { 'x-wybix-device': '123456789012345678901' },
  body: JSON.stringify({ receptor: { rfc: 'AAA010101AAA', razonSocial: 'ACME', regimenFiscal: '601', usoCfdi: 'G03', zipCode: '44100' }, ...cuerpo }),
});

test('timbrar: si el cálculo da lo cobrado, se timbra con IEPS desglosado y complemento local', async () => {
  const d = deps(116);
  const r = await timbrar(req({ items: [papas], totalEsperado: 116, localTaxes: [{ taxName: 'ISH', taxRate: 0.03, taxAmount: 3 }] }), d as any);
  const out = await r.json();
  assert.equal(out.success, true); assert.equal(out.desglose, true);
  const timbrada = d.llamadas.find(([p]) => p === '/api/v4/invoices')[1];
  assert.equal(timbrada.items[0].unitPrice, 46.296296);
  assert.equal(timbrada.items[0].itemTaxes[1].taxCode, '003');
  assert.deepEqual(timbrada.complement.localTaxes.taxes[0].taxName, 'ISH');
});

test('timbrar: si el cálculo no da lo cobrado o falla, la factura de siempre y el motivo', async () => {
  for (const d of [deps(115.2), deps(null, false)]) {
    const r = await timbrar(req({ items: [papas], totalEsperado: 116 }), d as any);
    const out = await r.json();
    assert.equal(out.success, true); assert.equal(out.desglose, false); assert.ok(out.motivoSinDesglose);
    const timbrada = d.llamadas.find(([p]) => p === '/api/v4/invoices')[1];
    assert.equal(timbrada.items[0].unitPrice, 50);
    assert.equal(timbrada.items[0].itemTaxes.length, 1);
    assert.equal(timbrada.complement, undefined);
  }
  /* Un POS viejo (sin desglose): ni se llama al cálculo. */
  const d = deps(116);
  await timbrar(req({ items: [{ ...papas, desglose: undefined }] }), d as any);
  assert.equal(d.llamadas.some(([p]) => p === '/api/v4/invoices/calculate'), false);
});
