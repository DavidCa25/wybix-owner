-- Reversa de 20261122120000_admin_plataforma.sql. Quita el panel de la
-- plataforma: administradores, bitácora del panel y sus funciones. NO toca
-- licencias, compras ni eventos ya escritos (license_events / cloud_audit).
-- La bitácora admin_audit se pierde: respáldala antes si la necesitas.
begin;
drop function if exists
  public.admin_q_admins(), public.admin_q_auditoria(integer, bigint, text), public.admin_q_plataforma(), public.admin_q_catalogo(),
  public.admin_q_adaptaciones(boolean), public.admin_q_revision(), public.admin_q_comercial(integer),
  public.admin_q_pruebas(text, boolean, integer), public.admin_q_licencia(uuid),
  public.admin_q_licencias(text, text, text, integer, integer), public.admin_q_negocio(uuid), public.admin_q_overview(),
  public.admin_hoy_mx(), public.platform_admin_set(text, text, boolean, uuid),
  public.menu_admin_update(uuid, jsonb, text, text), public.app_release_upsert(text, text, text, text, text, text), public.admin_semver(text),
  public.owner_app_set_active(uuid, boolean, text, text), public.owner_app_quota_set(uuid, integer, text, text),
  public.device_set_status(uuid, text, text, text), public.device_trial_extend(text, integer, text, text),
  public.license_code_change_set_status(uuid, text, text), public.license_issue_manual(jsonb),
  public.license_set_addon(uuid, text, boolean, text, text), public.license_downgrade_to_mono(uuid, text, text),
  public.license_update_customer(uuid, jsonb, text, text), public.license_set_origin(uuid, text, text, text),
  public.license_set_status(uuid, text, text, text), public.license_new_key(), public.admin_requiere_motivo(text, text),
  public.admin_rate_hit(uuid, integer, integer),
  public.admin_audit_log(uuid, text, text, text, text, jsonb, jsonb, boolean, text, text), public.admin_whoami(uuid);
drop table if exists public.admin_rate, public.admin_audit, public.platform_admins;
drop function if exists public.admin_audit_append_only();
commit;
