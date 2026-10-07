/**
 * FASE 3 · MFA DE PUNTA A PUNTA CONTRA SUPABASE AUTH DE VERDAD (pila local).
 *
 *     supabase start   (en un proyecto con estas migraciones y TOTP activo)
 *     SB_URL=... SB_ANON=... SB_SERVICE=... SB_DB=<contenedor de postgres> node scripts/probar-mfa-e2e.mjs
 *
 * Nada de emulación: GoTrue real enrola el factor, emite el reto, verifica
 * códigos TOTP calculados aquí (RFC 6238) y sube la sesión a AAL2; la base
 * real (auth.mfa_factors, JWT con `aal`) decide; la función owner-mfa corre en
 * el edge-runtime local. Crea su propio usuario y empresa de prueba.
 */
import { createClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const { SB_URL, SB_ANON, SB_SERVICE, SB_DB } = process.env;
if (!SB_URL || !SB_ANON || !SB_SERVICE || !SB_DB) { console.error('Faltan SB_URL, SB_ANON, SB_SERVICE o SB_DB.'); process.exit(2); }
if (!['127.0.0.1', 'localhost'].includes(new URL(SB_URL).hostname) || !/^supabase_db_[a-z0-9-]*local$/.test(SB_DB)) {
  throw new Error('MFA E2E solo permite infraestructura local de pruebas.');
}

let fallos = 0, pasos = 0;
const check = (id, ok, msg, det = '') => { pasos++; if (!ok) fallos++; console.log(`   ${ok ? 'ok   ' : 'FALLA'}  ${id}. ${msg}${det ? '  · ' + det : ''}`); };
const sql = (q) => { const r = spawnSync('docker', ['exec', '-i', SB_DB, 'psql', '-U', 'postgres', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], { input: q, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };

// ---------------------------------------------------------------- TOTP
function base32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out);
}
function totp(secreto, desfase = 0) {
  const t = Math.floor(Date.now() / 1000 / 30) + desfase; const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(t));
  const h = createHmac('sha1', base32(secreto)).update(b).digest(); const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const otroCodigo = (c) => String((Number(c) + 500000) % 1e6).padStart(6, '0');
const nuevo = () => createClient(SB_URL, SB_ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
const MFA = ['MFA_REQUIRED', 'MFA_ENROLL_REQUIRED'];

const email = `duena-${randomUUID().slice(0, 8)}@prueba.wybix.local`, password = `Clave-${randomUUID()}`;
try {
  console.log(`\nMFA E2E · ${SB_URL} · ${email}\n`);
  const { data: u, error: eu } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (eu) throw new Error(eu.message);
  const uid = u.user.id;
  const company = sql(`insert into negocios (nombre, owner_id) values ('Empresa MFA E2E', '${uid}') returning id;`);
  sql(`insert into sucursales (negocio_id, nombre, device_key) values ('${company}', 'Centro MFA', 'e2e-${randomUUID()}');
       insert into company_memberships (company_id, user_id, role, status, origin) values ('${company}', '${uid}', 'OWNER', 'ACTIVE', 'TEST');`);
  const home = sql(`select id from sucursales where negocio_id = '${company}' limit 1;`);
  const crearEvento = (c) => c.rpc('owner_crear_evento', { p_company: company, p: { nombre: `Feria ${Date.now()}`, home_location_id: home } });

  // 1. Sin factor
  const a = nuevo();
  await a.auth.signInWithPassword({ email, password });
  const n0 = (await a.auth.mfa.getAuthenticatorAssuranceLevel()).data;
  const r0 = (await crearEvento(a)).data;
  check('E2E01', n0.currentLevel === 'aal1' && n0.nextLevel === 'aal1' && r0?.code === 'MFA_ENROLL_REQUIRED',
    'sin factor: la sesión es AAL1 y administrar responde MFA_ENROLL_REQUIRED', `${n0.currentLevel}/${n0.nextLevel} · ${r0?.code}`);

  // 2. Enrolar con GoTrue y un código TOTP real
  const { data: en, error: ee } = await a.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'E2E' });
  if (ee) throw new Error(`enroll: ${ee.message}`);
  const secreto = en.totp.secret;
  const malo = await a.auth.mfa.challengeAndVerify({ factorId: en.id, code: otroCodigo(totp(secreto)) });
  check('E2E02', !!malo.error && (await a.auth.mfa.getAuthenticatorAssuranceLevel()).data.currentLevel === 'aal1',
    'un código TOTP incorrecto no confirma el factor ni sube la sesión');
  const bueno = await a.auth.mfa.challengeAndVerify({ factorId: en.id, code: totp(secreto) });
  const n1 = (await a.auth.mfa.getAuthenticatorAssuranceLevel()).data;
  check('E2E03', !bueno.error && n1.currentLevel === 'aal2', 'el código correcto confirma el factor y la sesión pasa a AAL2', bueno.error?.message ?? '');

  // 3. Con AAL2 la nube deja pasar (lo que responda ya no es MFA)
  const r1 = (await crearEvento(a)).data;
  check('E2E04', r1 && !MFA.includes(r1.code), 'con AAL2 administrar ya no lo frena el MFA', JSON.stringify(r1?.code ?? r1?.ok));
  const cods = (await a.rpc('mfa_generar_codigos')).data;
  check('E2E05', cods?.ok && cods.codigos.length === 10, 'con AAL2 se generan los 10 códigos de recuperación');
  await a.rpc('mfa_registrar', { p_evento: 'ENROLLED' });

  // 4. Sesión nueva: pide el segundo paso
  const b = nuevo();
  await b.auth.signInWithPassword({ email, password });
  const n2 = (await b.auth.mfa.getAuthenticatorAssuranceLevel()).data;
  const r2 = (await crearEvento(b)).data;
  const c2 = (await b.rpc('mfa_generar_codigos')).data;
  check('E2E06', n2.currentLevel === 'aal1' && n2.nextLevel === 'aal2' && r2?.code === 'MFA_REQUIRED' && c2?.code === 'MFA_REQUIRED',
    'iniciar sesión de nuevo: AAL1 con siguiente nivel AAL2; administrar y generar códigos piden MFA_REQUIRED', `${n2.currentLevel}/${n2.nextLevel} · ${r2?.code} · ${c2?.code}`);
  const lect = await b.rpc('mis_empresas');
  check('E2E07', !lect.error, 'en AAL1 las lecturas siguen funcionando (el tablero abre)', lect.error?.message ?? '');

  // 5. Recuperación por la función owner-mfa (edge-runtime local)
  const c = nuevo();
  await c.auth.signInWithPassword({ email, password });
  const inv = async (codigo) => {
    const r = await fetch(`${SB_URL}/functions/v1/owner-mfa`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_ANON, Authorization: `Bearer ${(await c.auth.getSession()).data.session.access_token}` }, body: JSON.stringify({ action: 'recuperar', codigo }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const sinJwt = await fetch(`${SB_URL}/functions/v1/owner-mfa`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_ANON }, body: '{"action":"recuperar","codigo":"AAAAA-BBBBB"}' });
  check('E2E08', sinJwt.status === 401, 'owner-mfa sin sesión: 401', String(sinJwt.status));
  const malR = await inv('AAAAA-BBBBB');
  check('E2E09', malR.status === 400 && malR.body?.code === 'INVALID_CODE', 'un código de recuperación inventado no sirve', JSON.stringify(malR));
  const okR = await inv(cods.codigos[3].toLowerCase());
  const factoresDespues = Number(sql(`select count(*) from auth.mfa_factors where user_id = '${uid}';`));
  check('E2E10', okR.status === 200 && okR.body?.ok && okR.body.factores_quitados === 1 && factoresDespues === 0,
    'con un código válido se quitan los factores', JSON.stringify(okR));
  const otraSesion = await b.auth.refreshSession();
  check('E2E11', !!otraSesion.error, 'y la OTRA sesión abierta quedó cerrada (ya no refresca)', otraSesion.error?.message ?? 'sigue viva');
  const reuso = await inv(cods.codigos[3]);
  check('E2E12', reuso.status === 400, 'el mismo código no sirve dos veces', JSON.stringify(reuso));
  await c.auth.refreshSession();
  const r3 = (await crearEvento(c)).data;
  check('E2E13', r3?.code === 'MFA_ENROLL_REQUIRED', 'sin factor otra vez, administrar exige enrolarse de nuevo', r3?.code);

  // 6. Límite de intentos (contando el reuso de arriba)
  for (let i = 0; i < 4; i++) await inv('CCCCC-DDDDD');
  const bloqueado = await inv(cods.codigos[4]);
  check('E2E14', bloqueado.status === 429 && bloqueado.body?.code === 'RATE_LIMITED', 'tras 5 fallos en 15 min responde 429 aun con un código válido', JSON.stringify(bloqueado));

  // 7. Auditoría
  const aud = sql(`select string_agg(action || ':' || result, ',' order by id) from cloud_audit where actor_id = '${uid}';`);
  check('E2E15', ['MFA_RECOVERY_GENERATE:OK', 'MFA_ENROLLED:OK', 'MFA_RECOVERY_USE:DENIED', 'MFA_RECOVERY_USE:OK', 'MFA_RECOVERED:OK', 'MFA_RECOVERY_USE:RATE_LIMITED'].every((x) => aud.includes(x)),
    'cloud_audit tiene generación, enrolamiento, intentos, uso, recuperación y bloqueo', aud);
} catch (e) {
  check('E2E-Z', false, 'la prueba se interrumpió', e.message);
}
console.log(`\n${pasos - fallos}/${pasos} comprobaciones correctas${fallos ? ` · ${fallos} FALLAS` : ''}`);
process.exit(fallos ? 1 : 0);
