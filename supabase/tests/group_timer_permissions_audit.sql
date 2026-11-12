-- READ ONLY. Run with an authorized SQL Editor/database connection.
-- This is a report, not a migration; do not invoke any timer/notification RPC.
select table_name, grantee, privilege_type
from information_schema.table_privileges
where table_schema='public'
  and table_name in ('rooms','room_members','profiles','user_device_tokens')
order by table_name, grantee, privilege_type;

select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where table_schema='public' and table_name in ('rooms','room_members','profiles')
order by table_name, column_name, grantee, privilege_type;

select tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname='public' and tablename in ('rooms','room_members','profiles','user_device_tokens');

select p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer,
  p.proacl as privileges, p.proconfig as settings,
  pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prokind='f'
  and (p.proname in ('set_profile_is_free','extend_profile_is_free',
    'auto_expire_free_status','toggle_profile_is_free','upsert_device_token')
    or p.proname ilike '%notif%' or p.proname ilike '%push%');

select t.tgrelid::regclass as table_name, t.tgname,
  pg_get_triggerdef(t.oid) as definition,
  pg_get_functiondef(t.tgfoid) as function_definition
from pg_trigger t
where not t.tgisinternal and t.tgrelid in (
 'public.profiles'::regclass,'public.rooms'::regclass,'public.room_members'::regclass);

-- Detect cron availability first. If present, review cron.job separately with
-- its owner; commands can contain secrets, so do not paste them without review.
select to_regclass('cron.job') as cron_job_catalog;
