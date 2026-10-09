import {spawnSync} from 'node:child_process';import {readFileSync} from 'node:fs';
const container='supabase_db_sb-local',db='wybix_tmp_ticket_email';
const run=(args,input)=>{const r=spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:64*1024*1024});if(r.status!==0)throw Error(r.stderr.slice(0,400));return r.stdout;};
const sql=(text)=>run(['exec','-i',container,'psql','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-X','-q','-t','-A'],text);
const exists=run(['exec',container,'psql','-U','postgres','-d','postgres','-t','-A','-c',`select 1 from pg_database where datname='${db}'`]);if(exists.trim())throw Error('La base temporal ya existe; no se sobrescribe.');
let created=false;try{
 run(['exec',container,'pg_dump','-U','postgres','-d','postgres','--no-owner','--no-privileges','--schema=public','--schema=auth','--schema=extensions','-Fc','-f','/tmp/wybix-ticket-email.dump']);
 run(['exec',container,'createdb','-U','postgres',db]);created=true;
 sql("DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS extensions CASCADE;");
 run(['exec',container,'pg_restore','-U','postgres','-d',db,'--no-owner','--no-privileges','--exit-on-error','/tmp/wybix-ticket-email.dump']);
 sql(`alter default privileges in schema public grant all on tables to anon,authenticated,service_role;alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
 for(let i=0;i<2;i++)for(const file of ['20261012140000_ticket_email.sql','20261012150000_comercial_volumen_compatibilidad.sql'])sql(readFileSync('supabase/migrations/'+file,'utf8'));
 sql(`do $$ begin
 if has_table_privilege('anon','public.ticket_mail_requests','SELECT') or has_table_privilege('authenticated','public.ticket_mail_requests','INSERT') or has_function_privilege('anon','public.ticket_mail_reserve(jsonb)','EXECUTE') or has_function_privilege('authenticated','public.ticket_mail_complete(jsonb)','EXECUTE') then raise exception 'Grants abiertos';end if;
 if not has_function_privilege('service_role','public.ticket_mail_reserve(jsonb)','EXECUTE') then raise exception 'Falta service_role';end if;
 end $$;`);
 sql(`do $$ declare d public.devices;r jsonb;k uuid:=gen_random_uuid(); begin
 select * into d from public.devices where status='ACTIVE' and kind in('POS_PRIMARY','POS_SECONDARY','MOBILE_POS') and company_id in(select id from public.negocios where status='ACTIVE') and location_id in(select id from public.sucursales where status='ACTIVE') limit 1;
 if d.id is null then raise exception 'Falta equipo de prueba en restauración local';end if;
 r:=public.ticket_mail_reserve(jsonb_build_object('id',k,'device_id',d.id,'fingerprint','qa-hash'));
 if not(r->>'ok')::boolean then raise exception 'No reserva';end if;
 if public.ticket_mail_reserve(jsonb_build_object('id',k,'device_id',d.id,'fingerprint','qa-hash'))->>'code'<>'BUSY' then raise exception 'No bloquea duplicado';end if;
 if public.ticket_mail_reserve(jsonb_build_object('id',k,'device_id',d.id,'fingerprint','otro'))->>'code'<>'CONFLICT' then raise exception 'No detecta cambio de adjunto';end if;
 perform public.ticket_mail_complete(jsonb_build_object('id',k,'device_id',d.id,'provider_id','qa-mail'));
 if not(public.ticket_mail_reserve(jsonb_build_object('id',k,'device_id',d.id,'fingerprint','qa-hash'))->>'sent')::boolean then raise exception 'No recuerda envío';end if;
 end $$;`);
 console.log('TICKET_EMAIL_SQL_OK: restauración local, migración idempotente y permisos con defaults Supabase verificados');
}finally{if(created)run(['exec',container,'dropdb','-U','postgres',db]);run(['exec',container,'rm','-f','/tmp/wybix-ticket-email.dump']);}
