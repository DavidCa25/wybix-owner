-- ============================================================================
--  CLASIFICAR Y REEMITIR las 7 licencias que existían antes del v2
-- ----------------------------------------------------------------------------
--  NO es una migración y NO se aplica sola. Se corre A MANO en producción
--  (supabase db query --linked -f ...) DESPUÉS de la PARTE A, de desplegar
--  license-check y de cargar la clave de firma de producción. Termina en
--  ROLLBACK: se revisa la salida y se cambia a COMMIT a propósito.
--
--  Auditoría de producción (solo lectura, 2026-09-26): ninguna es de un
--  cliente. Cinco «Prueba VM», un «Cliente QA MultiCaja» y una compra del
--  dueño por PayPal que nunca se activó.
--
--  Qué hace, y nada más:
--    1. fija `origin` (QA / INTERNAL / TEST) y deja una nota;
--    2. a las QA que se siguen usando les da permisos EXPLÍCITOS de pruebas
--       (license_qa_grant: solo funciona con TEST/QA/INTERNAL);
--    3. marca las demás como candidatas a cancelar (evento CANCEL_CANDIDATE).
--  No borra, no suspende, no cambia fechas de compra.
--
--  REEMITIR: no hay que tocar ningún equipo. Al siguiente refresco (o al
--  pulsar «Actualizar licencia»), cada VM activa recibe su certificado V2
--  FIRMADO con la clave de producción, con estos permisos y origen QA. Una
--  licencia sin firma ya no se acepta en el POS nuevo.
--
--  Cada cambio exige la clave esperada (4 últimos caracteres): si un id no
--  corresponde a lo auditado, no se toca.
-- ============================================================================
begin;

-- 1) Origen ----------------------------------------------------------------
with propuesta (id, fin_clave, origen, nota) as (values
  ('81666a44-8276-4173-bc91-c9692f83d809'::uuid, '4PKH', 'QA',       'VM de desarrollo en uso (último uso 2026-09-26).'),
  ('7484b07f-fcd5-4b09-8f44-b7ddb01e1adc'::uuid, 'UU7X', 'QA',       'QA MultiCaja; 2 equipos activos hasta 2026-09-13.'),
  ('b4a22322-cd10-4e4b-ac3b-2535bad7a06b'::uuid, '5UE6', 'INTERNAL', 'Compra del dueño por PayPal (wybixpos@gmail.com); nunca activada. Confirmar si fue sandbox o live.'),
  ('8bf0ca6a-cd9f-4138-ae12-2f5766384fc7'::uuid, 'V332', 'TEST',     'Prueba VM MultiCaja (max_registers 0); último uso 2026-09-09.'),
  ('94aac9c6-82b9-4047-ab25-318a018568a0'::uuid, 'SMBM', 'TEST',     'Prueba VM 2026-07-10; sin uso desde entonces.'),
  ('14151809-5336-42b6-b231-a08ffd916718'::uuid, 'E8FH', 'TEST',     'Prueba VM 2026-07-20; equipo liberado.'),
  ('3db46dcb-e6ac-42e8-8ea7-3377f812b076'::uuid, '6AJY', 'TEST',     'Prueba VM 2026-07-23; equipo liberado.')
)
update public.licenses l
   set origin = p.origen,
       notes  = trim(both ' ' from coalesce(l.notes, '') || ' [clasificación 2026-09: ' || p.nota || ']')
  from propuesta p
 where l.id = p.id and right(l.license_key, 4) = p.fin_clave and l.origin is null;

insert into public.license_events (license_id, type, data, actor)
select l.id, 'LICENSE_CLASSIFIED', jsonb_build_object('origin', l.origin), 'admin'
  from public.licenses l
 where l.id in ('81666a44-8276-4173-bc91-c9692f83d809', '7484b07f-fcd5-4b09-8f44-b7ddb01e1adc', 'b4a22322-cd10-4e4b-ac3b-2535bad7a06b',
                '8bf0ca6a-cd9f-4138-ae12-2f5766384fc7', '94aac9c6-82b9-4047-ab25-318a018568a0', '14151809-5336-42b6-b231-a08ffd916718',
                '3db46dcb-e6ac-42e8-8ea7-3377f812b076')
   and l.origin is not null
   and not exists (select 1 from public.license_events e where e.license_id = l.id and e.type = 'LICENSE_CLASSIFIED');

-- 2) Permisos EXPLÍCITOS de pruebas para las que se siguen usando -----------
-- VM de desarrollo: recorre los tres giros y las Pantallas Operativas.
select public.license_qa_grant('81666a44-8276-4173-bc91-c9692f83d809',
  '{"verticals": ["COMMERCE", "HOSPITALITY", "SERVICES"], "screen_tier": "UNLIMITED"}',
  'VM de QA: recorre los tres giros y las pantallas', 'admin');
-- QA MultiCaja: la edición ya es MultiCaja; los tres giros con su cuota normal.
select public.license_qa_grant('7484b07f-fcd5-4b09-8f44-b7ddb01e1adc',
  '{"verticals": ["COMMERCE", "HOSPITALITY", "SERVICES"], "screen_tier": "BASE", "edition": "multi"}',
  'QA de MultiCaja', 'admin');

-- 3) Candidatas a cancelar (NO se borran ni se suspenden) -------------------
select public.license_mark_cancel_candidate(id, 'prueba antigua sin uso', 'admin')
  from public.licenses
 where id in ('8bf0ca6a-cd9f-4138-ae12-2f5766384fc7', '94aac9c6-82b9-4047-ab25-318a018568a0',
              '14151809-5336-42b6-b231-a08ffd916718', '3db46dcb-e6ac-42e8-8ea7-3377f812b076');

-- Revisión antes de confirmar ----------------------------------------------
select id, right(license_key, 4) as clave, origin, plan,
       (license_runtime(id)->'verticals') as giros, (license_runtime(id)->'screens') as pantallas
  from public.licenses where origin in ('QA', 'INTERNAL', 'TEST') order by origin, created_at;
select * from public.license_review_queue;

rollback;   -- <- cambiar a COMMIT solo después de revisar
