/**
 * PRUEBAS DEL CERTIFICADO FIRMADO (el mismo módulo que usan las Edge Functions).
 *
 *     node scripts/probar-certificado.mjs
 *
 * Node 24 ejecuta el .ts compartido tal cual (sin compilar). La verificación
 * se hace además con `node:crypto` en formato ieee-p1363, que es EXACTAMENTE
 * como verifica el POS: si esto pasa, lo que firma Supabase lo acepta Wybix.
 */
import { generateKeyPairSync, verify as verificarNode, createPublicKey } from 'node:crypto';
import { firmar, importarClavePrivada, payloadDeLicencia, payloadDePrueba, verificar } from '../supabase/functions/_shared/certificado.ts';
import { GRACE_DAYS, OFFLINE_DAYS } from '../supabase/functions/_shared/politica.ts';
import { cargarFirma } from '../supabase/functions/_shared/llaves.ts';

let fallos = 0, pasos = 0;
const check = (ok, msg, det = '') => { pasos++; if (!ok) fallos++; console.log(`   ${ok ? 'ok   ' : 'FALLA'}  ${msg}${det ? '  · ' + det : ''}`); };
const DIA = 86400000;

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
const clave = await importarClavePrivada(privPem);

const ahora = Date.parse('2026-10-01T12:00:00Z');
const rt = {
  license_id: '00000000-0000-0000-0000-000000000001', customer: 'Taller Casillas', edition: 'mono', registers_max: 1,
  verticals: [{ vertical: 'SERVICES', screen_tier: 'BASE' }, { vertical: 'COMMERCE', screen_tier: 'EXTENDED' }],
  entitlements: ['services', 'sales', 'commerce'], screens: { SERVICES: 3, COMMERCE: 10 }, addons: [],
  first_activated_at: '2026-10-01T12:00:00Z', paid_until: '2027-10-01T12:00:00Z',
};
const p = payloadDeLicencia(rt, 'PC-TALLER', ahora);
check(p.kind === 'LICENSE' && p.machine_id === 'PC-TALLER' && p.edition === 'mono' && p.registers_max === 1, 'el certificado de una licencia lleva edición, cajas y la computadora');
check(p.grace_until === new Date(Date.parse(rt.paid_until) + GRACE_DAYS * DIA).toISOString() && GRACE_DAYS === 45, 'gracia = pagado hasta + 45 días (de la política)');
check(p.valid_until === new Date(ahora + OFFLINE_DAYS * DIA).toISOString() && OFFLINE_DAYS === 45, 'vale 45 días sin volver a validarse (de la política)');
check(JSON.stringify(p.verticals) === '["COMMERCE","SERVICES"]' && p.screens.COMMERCE === 10, 'híbrido: giros y pantallas por giro');
const COMERCIAL = ['support_until', 'support_tier', 'included_code_changes', 'used_code_changes', 'remaining_code_changes',
                  'list_price', 'price_paid', 'discount_pct', 'discount_amount'];
check(COMERCIAL.every(k => !(k in p)), 'nada comercial en el certificado: ni soporte, ni adaptaciones (incluidas/usadas/restantes), ni precios');

const cert = await firmar(p, clave, 'k1');
check(cert.format === 'wybix-license' && cert.v === 1 && cert.kid === 'k1', 'formato del archivo');
check(!!(await verificar(cert, pubPem)), 'la firma verifica con la clave pública');

/* Como verifica el POS (node:crypto, ieee-p1363). */
const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const okPos = verificarNode('sha256', Buffer.from(cert.payload), { key: createPublicKey(pubPem), dsaEncoding: 'ieee-p1363' }, b64(cert.sig));
check(okPos, 'y verifica igual con node:crypto (como lo hará Wybix POS)');

/* Alterar cualquier cosa invalida la firma. */
const alterado = (cambio) => {
  const obj = JSON.parse(b64(cert.payload).toString('utf8'));
  cambio(obj);
  return { ...cert, payload: Buffer.from(JSON.stringify(obj)).toString('base64url') };
};
check(!(await verificar(alterado(o => { o.registers_max = null; o.edition = 'multi'; }), pubPem)), 'MonoCaja -> MultiCaja a mano: firma inválida');
check(!(await verificar(alterado(o => { o.paid_until = '2099-01-01T00:00:00Z'; }), pubPem)), 'estirar paid_until: firma inválida');
check(!(await verificar(alterado(o => { o.verticals.push('HOSPITALITY'); o.entitlements.push('hospitality'); }), pubPem)), 'agregar un giro: firma inválida');
check(!(await verificar(alterado(o => { o.screens.SERVICES = null; }), pubPem)), 'pantallas ilimitadas a mano: firma inválida');
const otra = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' });
check(!(await verificar(cert, otra)), 'firmado con otra clave: se rechaza');
check(!(await verificar({ ...cert, format: 'otro' }, pubPem)) && !(await verificar(null, pubPem)), 'estructura inválida: se rechaza');

const t0 = { machine_id: 'PC-X', business_name: null, started_at: '2026-10-01T12:00:00Z', expires_at: '2026-10-31T12:00:00Z' };
const pt = payloadDePrueba(t0, { verticals: ['HOSPITALITY'], entitlements: ['sales', 'hospitality'], screens: { HOSPITALITY: 3 } }, ahora);
check(pt.kind === 'TRIAL' && pt.grace_days === 0 && pt.trial_ends_at === '2026-10-31T12:00:00.000Z' && pt.valid_until === pt.trial_ends_at && pt.registers_max === 1,
  'la prueba usa el MISMO formato: TRIAL, 30 días, MonoCaja, sin gracia');
check(JSON.stringify(pt.verticals) === '["HOSPITALITY"]' && JSON.stringify(pt.screens) === '{"HOSPITALITY":3}',
  'la prueba es de UN giro (el elegido) con 3 Pantallas Operativas de ese giro');
const ptSin = payloadDePrueba(t0, { verticals: [], entitlements: ['sales'], screens: {} }, ahora);
check(ptSin.verticals.length === 0 && Object.keys(ptSin.screens).length === 0, 'antes de elegir giro: ningún giro y ninguna pantalla (nunca los tres)');

// ------------------------------------------------ configuración de firma y rotación
console.log('\n   · KID y rotación');
const par = () => { const k = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: k.publicKey.export({ type: 'spki', format: 'pem' }) }; };
const k1 = par(), k2 = par();
const env = (o) => (n) => o[n];
const f0 = await cargarFirma(env({ LICENSE_SIGNING_KEY: k1.priv, LICENSE_PUBLIC_KEYS: JSON.stringify({ 'wybix-lic-1': k1.pub }) }));
check(!f0.ok && f0.motivo === 'SIN_KID' && (await f0.firmar(p)) === null, 'sin LICENSE_SIGNING_KID no se firma (ya no cae en un KID por omisión)');
const fMal = await cargarFirma(env({ LICENSE_SIGNING_KEY: k2.priv, LICENSE_SIGNING_KID: 'wybix-lic-1', LICENSE_PUBLIC_KEYS: JSON.stringify({ 'wybix-lic-1': k1.pub }) }));
check(!fMal.ok && fMal.motivo === 'PAR_INCORRECTO', 'clave privada nueva con el KID de la anterior: autocomprobación falla y no se firma');
const f1 = await cargarFirma(env({ LICENSE_SIGNING_KEY: k1.priv, LICENSE_SIGNING_KID: 'wybix-lic-1', LICENSE_PUBLIC_KEYS: JSON.stringify({ 'wybix-lic-1': k1.pub }) }));
const c1 = await f1.firmar(p);
check(f1.ok && c1.kid === 'wybix-lic-1', 'KID 1 firma');
check(!JSON.stringify(f1).includes('PRIVATE KEY') && !String(f1.motivo ?? '').includes('PRIVATE'), 'la configuración cargada no expone la clave privada');
// Transición: la activa es la 2; la 1 sigue siendo de confianza.
const trans = { LICENSE_SIGNING_KEY: k2.priv, LICENSE_SIGNING_KID: 'wybix-lic-2', LICENSE_PUBLIC_KEYS: JSON.stringify({ 'wybix-lic-1': k1.pub, 'wybix-lic-2': k2.pub }) };
const f2 = await cargarFirma(env(trans));
const c2 = await f2.firmar(p);
check(f2.ok && c2.kid === 'wybix-lic-2', 'rotación: los certificados nuevos salen con KID 2');
check(!!(await f2.verificar(c1)) && !!(await f2.verificar(c2)), 'durante la transición el servidor verifica KID 1 (existentes) y KID 2 (nuevos)');
// Compromiso de KID 1.
const f3 = await cargarFirma(env({ ...trans, LICENSE_REVOKED_KIDS: 'wybix-lic-1' }));
const c3 = await f3.firmar(p);
const p3 = JSON.parse(b64(c3.payload).toString('utf8'));
check(JSON.stringify(p3.revoked_kids) === '["wybix-lic-1"]', 'KID comprometido: viaja en cada certificado nuevo (revoked_kids) para que el POS lo rechace');
check((await f3.verificar(c1)) === null, 'y el servidor deja de aceptar certificados firmados con él (liberar equipo)');
const f4 = await cargarFirma(env({ ...trans, LICENSE_SIGNING_KEY: k1.priv, LICENSE_SIGNING_KID: 'wybix-lic-1', LICENSE_REVOKED_KIDS: 'wybix-lic-1' }));
check(!f4.ok && f4.motivo === 'KID_REVOCADO', 'nunca se firma con un KID revocado');

console.log(fallos ? `\nRESULTADO: ${fallos} fallas de ${pasos}` : `\nRESULTADO: ${pasos} ok · 0 fallas`);
process.exit(fallos ? 1 : 0);
