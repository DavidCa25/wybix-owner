// Certificados de PRUEBA, hechos en memoria en cada corrida: una CA que hace de
// «Apple WWDR» y un certificado «Pass Type ID» firmado por ella, más una llave
// que hace de cuenta de servicio de Google. Nada de esto sirve fuera de las
// pruebas y nada se guarda en el repositorio.
import { concat, ctx, entero, nulo, octetos, oid, OID, pem, seq, set, tlv, utcTime, utf8 } from '../wallet-firma.ts';

const ALG = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' } as const;
const nombre = (cn: string, ou?: string) => seq(...(ou ? [set(seq(oid('2.5.4.11'), utf8(ou)))] : []), set(seq(oid('2.5.4.3'), utf8(cn))));

async function cert(sujeto: Uint8Array, emisor: Uint8Array, pub: CryptoKey, firma: CryptoKey, serie: number, ca: boolean): Promise<Uint8Array> {
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pub));
  const ahora = Date.now();
  const ext = ca ? [ctx(3, seq(seq(oid('2.5.29.19'), tlv(0x01, Uint8Array.of(0xff)), octetos(seq(tlv(0x01, Uint8Array.of(0xff)))))))] : [];
  const tbs = seq(ctx(0, entero(2)), entero(serie), seq(oid(OID.sha256Rsa), nulo()), emisor,
    seq(utcTime(new Date(ahora - 86400000)), utcTime(new Date(ahora + 86400000 * 30))), sujeto, spki, ...ext);
  const s = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', firma, tbs));
  return seq(tbs, seq(oid(OID.sha256Rsa), nulo()), tlv(0x03, concat(Uint8Array.of(0), s)));
}

const llavePem = async (k: CryptoKey) => pem('PRIVATE KEY', new Uint8Array(await crypto.subtle.exportKey('pkcs8', k)));

export interface Prueba {
  passTypeId: string; caPem: string; certPem: string; keyPem: string; wwdrPem: string; passPub: CryptoKey;
  googleKeyPem: string; googlePub: CryptoKey; googleSaJson: string;
}

export async function certificadosDePrueba(passTypeId = 'pass.mx.wybix.prueba'): Promise<Prueba> {
  const ca = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const pase = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const google = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const nCa = nombre('WWDR de PRUEBA (no es Apple)', 'Wybix pruebas');
  const caDer = await cert(nCa, nCa, ca.publicKey, ca.privateKey, 1, true);
  const paseDer = await cert(nombre(`Pass Type ID: ${passTypeId}`, 'PRUEBA0000'), nCa, pase.publicKey, ca.privateKey, 4242, false);
  const googleKeyPem = await llavePem(google.privateKey);
  return {
    passTypeId, caPem: pem('CERTIFICATE', caDer), wwdrPem: pem('CERTIFICATE', caDer), certPem: pem('CERTIFICATE', paseDer),
    keyPem: await llavePem(pase.privateKey), passPub: pase.publicKey,
    googleKeyPem, googlePub: google.publicKey,
    googleSaJson: JSON.stringify({ type: 'service_account', client_email: 'wallet@prueba.iam.gserviceaccount.com', private_key: googleKeyPem }),
  };
}

