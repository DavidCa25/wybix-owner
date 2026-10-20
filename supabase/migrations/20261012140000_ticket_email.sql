begin;
create table if not exists public.ticket_mail_requests(
 id uuid primary key,device_id uuid not null references public.devices(id),company_id uuid not null references public.negocios(id),
 fingerprint text not null,status text not null default 'PENDING' check(status in ('PENDING','SENT')),
 created_at timestamptz not null default now(),reserved_at timestamptz not null default now(),provider_id text);
alter table public.ticket_mail_requests enable row level security;
revoke all on public.ticket_mail_requests from public,anon,authenticated;
create or replace function public.ticket_mail_reserve(p jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare d public.devices%rowtype;r public.ticket_mail_requests%rowtype;k uuid:=public.wx_uuid(p->>'id');begin
 select * into d from public.devices where id=public.wx_uuid(p->>'device_id') and status='ACTIVE' and kind in ('POS_PRIMARY','POS_SECONDARY','MOBILE_POS');
 if d.id is null or k is null or not exists(select 1 from public.negocios where id=d.company_id and status='ACTIVE') or not exists(select 1 from public.sucursales where id=d.location_id and status='ACTIVE') then return jsonb_build_object('ok',false,'code','DENIED');end if;
 perform pg_advisory_xact_lock(hashtextextended('ticket-email:'||d.company_id::text,0));
 select * into r from public.ticket_mail_requests where id=k for update;
 if found then
  if r.device_id<>d.id or r.fingerprint<>p->>'fingerprint' then return jsonb_build_object('ok',false,'code','CONFLICT');end if;
  if r.status='SENT' then return jsonb_build_object('ok',true,'sent',true);end if;
  if r.created_at<now()-interval '23 hours' then return jsonb_build_object('ok',false,'code','REVIEW_REQUIRED');end if;
  if r.reserved_at>now()-interval '60 seconds' then return jsonb_build_object('ok',false,'code','BUSY');end if;
  update public.ticket_mail_requests set reserved_at=now() where id=k;
 else
  if (select count(*) from public.ticket_mail_requests where company_id=d.company_id and created_at>now()-interval '1 hour')>=100 then return jsonb_build_object('ok',false,'code','RATE_LIMIT');end if;
  insert into public.ticket_mail_requests(id,device_id,company_id,fingerprint) values(k,d.id,d.company_id,p->>'fingerprint');
 end if;
 return jsonb_build_object('ok',true,'sent',false);
end $$;
create or replace function public.ticket_mail_complete(p jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
begin
 update public.ticket_mail_requests set status='SENT',provider_id=left(p->>'provider_id',100) where id=public.wx_uuid(p->>'id') and device_id=public.wx_uuid(p->>'device_id');
 return jsonb_build_object('ok',found);
end $$;
revoke all on function public.ticket_mail_reserve(jsonb),public.ticket_mail_complete(jsonb) from public,anon,authenticated;
grant execute on function public.ticket_mail_reserve(jsonb),public.ticket_mail_complete(jsonb) to service_role;
commit;
