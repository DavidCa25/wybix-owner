import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearVerificador } from '../admin/jwt.ts';

const URL_SB = 'https://ref.supabase.co';
const SUB = '8dfcbb54-5f27-4e55-84d5-b783d65589b5';
const b64 = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');

async function preparar() {
  const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = { ...(await crypto.subtle.exportKey('jwk', par.publicKey)), kid: 'k1', alg: 'ES256' };
  const firmar = async (cuerpo: Record<string, unknown>, cab: Record<string, unknown> = { alg: 'ES256', kid: 'k1', typ: 'JWT' }) => {
    const base = `${b64(JSON.stringify(cab))}.${b64(JSON.stringify(cuerpo))}`;
    const f = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, par.privateKey, new TextEncoder().encode(base)));
    return `${base}.${b64(f)}`;
  };
  let descargas = 0;
  const verificar = crearVerificador({ supabaseUrl: URL_SB, descargarLlaves: async () => { descargas++; return [pub as never]; } });
  const valido = { sub: SUB, aud: 'authenticated', role: 'authenticated', iss: `${URL_SB}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 600, aal: 'aal2', session_id: 's-1', email: 'yo@wybix.mx' };
  return { firmar, verificar, valido, descargas: () => descargas };
}

test('jwt: token ES256 válido da sub, aal y session_id; las llaves se descargan una vez', async () => {
  const { firmar, verificar, valido, descargas } = await preparar();
  const c = await verificar(await firmar(valido));
  assert.equal(c?.sub, SUB);
  assert.equal(c?.aal, 'aal2');
  assert.equal(c?.session_id, 's-1');
  await verificar(await firmar(valido));
  assert.equal(descargas(), 1);
});

test('jwt: firma alterada, vencido, otro emisor, otra audiencia o HS256 -> null', async () => {
  const { firmar, verificar, valido } = await preparar();
  const t = await firmar(valido);
  const alterado = t.slice(0, t.lastIndexOf('.') + 1) + b64(new Uint8Array(64));
  assert.equal(await verificar(alterado), null);
  assert.equal(await verificar(await firmar({ ...valido, exp: Math.floor(Date.now() / 1000) - 5 })), null);
  assert.equal(await verificar(await firmar({ ...valido, iss: 'https://otro.supabase.co/auth/v1' })), null);
  assert.equal(await verificar(await firmar({ ...valido, aud: 'anon' })), null);
  assert.equal(await verificar(await firmar({ ...valido, role: 'service_role' })), null);
  assert.equal(await verificar(await firmar(valido, { alg: 'HS256', kid: 'k1' })), null);
  assert.equal(await verificar(await firmar(valido, { alg: 'ES256', kid: 'desconocida' })), null);
  assert.equal(await verificar('basura'), null);
});
