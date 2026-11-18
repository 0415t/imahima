-- Read only. After the separately approved managed-archive migration.
-- Use mvp_managed for classification, never creator presence.
begin read only;
with report as (
  select 1 as ordering,'classification'::text as section,jsonb_build_object(
    'total',count(*),'managed',count(*) filter(where mvp_managed),
    'legacy',count(*) filter(where not mvp_managed),'unclassified',count(*) filter(where mvp_managed is null)) as data
  from public.rooms
  union all
  select 2,'column',jsonb_agg(to_jsonb(c)) from (
    select column_name,data_type,is_nullable,column_default from information_schema.columns
    where table_schema='public' and table_name='rooms' and column_name='mvp_managed'
  ) c
  union all
  select 3,'trigger_security',jsonb_agg(to_jsonb(f)) from (
    select pg_get_userbyid(proowner) as owner,prosecdef,proconfig,proacl
    from pg_proc where oid='group_mvp_private.archive_empty_membership_rooms()'::regprocedure
  ) f
  union all
  select 4,'triggers',jsonb_agg(to_jsonb(t)) from (
    select tgname,tgenabled,pg_get_triggerdef(oid) as definition from pg_trigger
    where tgrelid='public.room_members'::regclass and tgname like 'group_mvp_archive_after_membership_%'
  ) t
  union all
  select 5,'direct_function_execution',jsonb_agg(to_jsonb(p)) from (
    select role_name,has_function_privilege(role_name,'group_mvp_private.archive_empty_membership_rooms()','EXECUTE') as allowed
    from (values('anon'),('authenticated'),('service_role')) r(role_name)
  ) p
)
select section,data from report order by ordering;
commit;
