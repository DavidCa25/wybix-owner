/** Datos sintéticos para Android + Edge Runtime LOCAL; no toca empresas existentes. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { snapshot } from '../packages/database/test/fixture.ts';

const contenedor = 'supabase_db_sb-local';
const psql = sql => {
  const r = spawnSync('docker', ['exec', '-i', contenedor, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};
for (const m of ['20261011160000_fase3_aprobaciones_payload.sql','20261011170000_fase3_reconciliacion.sql']) psql(readFileSync(`supabase/migrations/${m}`, 'utf8'));
const c = randomUUID(), home = randomUUID(), evento = randomUUID(), caja = randomUUID();
const code = `QAQA-${randomUUID().slice(0,8).toUpperCase()}`;
const s = snapshot();
const lit = v => "'" + String(v).replace(/'/g,"''") + "'";
psql(`BEGIN;
INSERT INTO negocios(id,nombre) VALUES('${c}','Wybix QA Fase3');
INSERT INTO sucursales(id,negocio_id,nombre,tipo,status) VALUES('${home}','${c}','Base QA','BRANCH','ACTIVE');
INSERT INTO sucursales(id,negocio_id,nombre,tipo,status,event_status,home_location_id,timezone)
 VALUES('${evento}','${c}','Feria QA','EVENT','ACTIVE','OPEN','${home}','America/Mexico_City');
INSERT INTO licenses(license_key,plan,customer_name,company_id,addons) VALUES('QA-${c}','multi','Prueba local','${c}',ARRAY['MOBILE_POS']);
INSERT INTO registers(id,company_id,location_id,register_uuid,code,name) VALUES('${caja}','${c}','${evento}','${caja}','QA1','Caja QA');
INSERT INTO catalog_publications(location_id,company_id,version,content_hash,payload) VALUES('${home}','${c}',1,'QA',${lit(JSON.stringify(s.catalog))}::jsonb);
${s.staff.map(e=> {
  const id = randomUUID();
  return `INSERT INTO employees(id,company_id,pos_user_uuid,display_name,home_location_id,pin_hash,pin_sal,pin_algo) VALUES('${id}','${c}','${e.uuid}',${lit(e.name)},'${home}',${lit(e.pin_hash)},${lit(e.pin_sal)},${lit(e.pin_algo)});
  INSERT INTO location_staff(location_id,employee_id,company_id,role,active) VALUES('${evento}','${id}','${c}',${lit(e.role)},true);`;
}).join('\n')}
INSERT INTO device_enrollments(company_id,location_id,purpose,kinds,code_hash,expires_at,register_id)
 VALUES('${c}','${evento}','ENROLL_DEVICE',ARRAY['MOBILE_POS'],wx_codigo_hash(${lit(code)}),now()+interval '1 hour','${caja}');
COMMIT;`);
mkdirSync('apps/pos-mobile/.expo', { recursive: true });
writeFileSync('apps/pos-mobile/.expo/qa-fase3-fixture.json',JSON.stringify({ company:c, home, evento, caja, code },null,2));
console.log(`Escenario sintético creado en ${contenedor}. Código ${code} (vence en una hora).`);
