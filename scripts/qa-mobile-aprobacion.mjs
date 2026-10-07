/** Puente QA: una dueña sintética con TOTP decide la petición hecha en Android. */
import { createClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const { SB_URL, SB_ANON, SB_SERVICE } = process.env;
if (!SB_URL || !['localhost','127.0.0.1'].includes(new URL(SB_URL).hostname) || !SB_ANON || !SB_SERVICE) throw Error('Solo Supabase local.');
const fixture = JSON.parse(readFileSync('apps/pos-mobile/.expo/qa-fase3-fixture.json', 'utf8'));
const sql = q => {
  const r = spawnSync('docker', ['exec','-i','supabase_db_sb-local','psql','-U','postgres','-At','-v','ON_ERROR_STOP=1'], { input:q, encoding:'utf8' });
  if (r.status) throw Error(r.stderr);
  return r.stdout.trim();
};
if (!/^[0-9a-f-]{36}$/.test(fixture.company) || sql(`select nombre from negocios where id='${fixture.company}'`) !== 'Wybix QA Fase3') throw Error('Escenario sintético requerido.');
const opts = { auth:{persistSession:false,autoRefreshToken:false} };
const admin = createClient(SB_URL, SB_SERVICE, opts), owner = createClient(SB_URL, SB_ANON, opts);
const email = `qa-aprobacion-${randomUUID()}@prueba.wybix.local`, password = randomUUID();
const {data:u,error:ue} = await admin.auth.admin.createUser({email,password,email_confirm:true});
if (ue) throw ue;
sql(`insert into company_memberships(company_id,user_id,role,status,origin) values('${fixture.company}','${u.user.id}','OWNER','ACTIVE','TEST')`);
const {error:le} = await owner.auth.signInWithPassword({email,password});
if (le) throw le;
const {data:f,error:fe} = await owner.auth.mfa.enroll({factorType:'totp',friendlyName:'QA Android'});
if (fe) throw fe;
let bits='';
for(const c of f.totp.secret.replace(/=+$/,'')) bits+='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5,'0');
const key=Buffer.from(Array.from({length:Math.floor(bits.length/8)},(_,i)=>parseInt(bits.slice(i*8,i*8+8),2)));
const counter=Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
const h=createHmac('sha1',key).update(counter).digest(), off=h[h.length-1]&15;
const code=String((h.readUInt32BE(off)&0x7fffffff)%1e6).padStart(6,'0');
const {error:ve}=await owner.auth.mfa.challengeAndVerify({factorId:f.id,code});
if(ve) throw ve;
console.log('Dueña sintética en AAL2. Esperando solicitud desde Android (máximo 4 min).');
let solicitud;
for(let i=0;i<120;i++) {
  const {data,error}=await owner.rpc('owner_aprobaciones',{p_company:fixture.company});
  if(error) throw error;
  solicitud=data.find(a=>a.status==='PENDING');
  if(solicitud) break;
  await new Promise(r=>setTimeout(r,2000));
}
if(!solicitud) throw Error('Android no solicitó aprobación.');
if(solicitud.action!=='RETIRO' || solicitud.payload.monto!=='5' || solicitud.payload.razon!=='Retiro a resguardo') throw Error('La prueba solo aprueba RETIRO de 5 por Retiro a resguardo.');
const {data:decision,error:de}=await owner.rpc('owner_decidir_aprobacion',{p_id:solicitud.id,p_decision:'APPROVED',p_hash:solicitud.payload_hash,p_nota:'QA local con TOTP'});
if(de || decision.status!=='APPROVED') throw Error('Decisión no aprobada.');
console.log('APPROVED con sesión real AAL2. Esperando consumo y movimiento.');
let resultado;
for(let i=0;i<60;i++) {
  resultado=JSON.parse(sql(`select json_build_object('status',a.status,'action',a.action,'aal',(select detail->>'aal' from cloud_audit where action='APPROVAL_DECIDE' and detail->>'id'=a.id::text limit 1),'movimientos',(select count(*) from cash_movement_facts c join sync_events e on e.aggregate_uuid=c.movement_uuid where c.company_id=a.company_id and e.payload->'authorized_by'->>'uuid'=a.id::text)) from approval_requests a where a.id='${solicitud.id}'`));
  if(resultado.status==='CONSUMED' && resultado.movimientos===1) break;
  await new Promise(r=>setTimeout(r,2000));
}
mkdirSync('docs/evidencia/fase3/android',{recursive:true});
writeFileSync('docs/evidencia/fase3/android/aprobacion.json',JSON.stringify({at:new Date().toISOString(),...resultado},null,2));
if(resultado.status!=='CONSUMED' || resultado.movimientos!==1 || resultado.aal!=='aal2') throw Error('Falta consumo o movimiento único con AAL2.');
console.log('OK: solicitud nativa, decisión AAL2, consumo y un único movimiento sincronizado.');
