-- READ ONLY: execute in the exact intended deployment project/session/role.
-- One result set: section TEXT, data JSONB with status / expected / actual.
-- PASS = a machine-checkable prerequisite passed; REVIEW = human comparison is
-- still required; FAIL = stop. This report does NOT approve/apply a migration.
-- Missing base objects are reported, not hidden by a failing regclass cast.
-- Export all 12 sections as one CSV; no original inspection query is omitted.
begin read only;
WITH
connection_rows AS (
select current_database() as database_name, current_user as execution_role,
       session_user as login_role, version() as database_version
),
execution_role_rows AS (
select rolname, rolsuper, rolbypassrls from pg_roles where rolname=current_user
),
objects_rows AS (
select object_name, to_regclass(object_name) as existing_object
from (values ('public.rooms'),('public.room_members'),('public.profiles'),
             ('auth.users'),('public.group_mvp_rate_limits')) x(object_name)
),
new_columns_rows AS (
select table_name,column_name,data_type
from information_schema.columns
where table_schema='public' and table_name='rooms'
  and column_name in ('mvp_created_by','mvp_archived_at')
),
new_rpcs_rows AS (
select p.oid::regprocedure as existing_function, pg_get_userbyid(p.proowner) as owner
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in ('group_mvp_execute','group_mvp_consume_rate')
),
membership_index_rows AS (
select n.nspname, c.relname, c.relkind, i.indisvalid, i.indisready,
       i.indrelid::regclass as target_table, pg_get_indexdef(i.indexrelid) as definition,
       am.amname as access_method, i.indnkeyatts, i.indnatts,
       coalesce(c.relkind='i' AND i.indisvalid AND i.indisready
         AND i.indrelid=to_regclass('public.room_members') AND am.amname='btree'
         AND i.indnkeyatts=2 AND i.indnatts=2
         AND i.indpred IS NULL AND i.indexprs IS NULL
         AND pg_get_indexdef(i.indexrelid,1,true)='user_id'
         AND pg_get_indexdef(i.indexrelid,2,true)='room_id', false) as is_expected_definition
from pg_class c join pg_namespace n on n.oid=c.relnamespace
left join pg_index i on i.indexrelid=c.oid
left join pg_am am on am.oid=c.relam
where n.nspname='public' and c.relname='idx_room_members_user_id_room_id'
),
constraints_rows AS (
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in (to_regclass('public.rooms'),to_regclass('public.room_members'),to_regclass('public.profiles'))
),
indexes_rows AS (
select indexname,indexdef from pg_indexes
where schemaname='public' and tablename in ('rooms','room_members')
),
generator_rows AS (
select p.oid::regprocedure::text as function_name, pg_get_userbyid(p.proowner) as owner,
       p.prorettype::regtype as return_type, p.pronargs as argument_count, p.proacl, p.proconfig,
       pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='generate_room_key' and p.prokind='f'
),
table_security_rows AS (
select c.oid::regclass as table_name, pg_get_userbyid(c.relowner) as owner,
       c.relacl,c.relrowsecurity,c.relforcerowsecurity
from pg_class c where c.oid in (to_regclass('public.rooms'),to_regclass('public.room_members'),to_regclass('public.profiles'))
),
policies_rows AS (
select tablename,policyname,roles,cmd,qual,with_check
from pg_policies where schemaname='public' and tablename in ('rooms','room_members','profiles')
),
default_privileges_rows AS (
select pg_get_userbyid(d.defaclrole) as creator_role,n.nspname,d.defaclobjtype,d.defaclacl
from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
where d.defaclnamespace=0 or n.nspname='public'
),
report AS (
SELECT 1 AS section_order, 'connection'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN EXISTS (SELECT 1 FROM connection_rows WHERE database_name = 'postgres' AND execution_role IN ('postgres','supabase_admin')) THEN 'REVIEW' ELSE 'FAIL' END,
         'expected', 'database_name = postgres; execution_role = postgres or supabase_admin. Independently match Dashboard Project Ref; database name does not identify the project.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM connection_rows r)
       ) AS data
UNION ALL
SELECT 2 AS section_order, 'execution_role'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN (SELECT count(*) FROM execution_role_rows)=1 THEN 'REVIEW' ELSE 'FAIL' END,
         'expected', 'Exactly one expected role; review ownership/DDL rights. Superuser/BYPASSRLS are recorded, not universally required.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM execution_role_rows r)
       ) AS data
UNION ALL
SELECT 3 AS section_order, 'objects'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN (SELECT count(*) FROM objects_rows WHERE object_name <> 'public.group_mvp_rate_limits' AND existing_object IS NOT NULL)=4 AND NOT EXISTS (SELECT 1 FROM objects_rows WHERE object_name='public.group_mvp_rate_limits' AND existing_object IS NOT NULL) THEN 'PASS' ELSE 'FAIL' END,
         'expected', 'rooms, room_members, profiles, auth.users must exist; group_mvp_rate_limits must not exist.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM objects_rows r)
       ) AS data
UNION ALL
SELECT 4 AS section_order, 'new_columns'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN EXISTS (SELECT 1 FROM new_columns_rows) THEN 'FAIL' ELSE 'PASS' END,
         'expected', 'Zero rows: neither mvp_created_by nor mvp_archived_at exists.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM new_columns_rows r)
       ) AS data
UNION ALL
SELECT 5 AS section_order, 'new_rpcs'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN EXISTS (SELECT 1 FROM new_rpcs_rows) THEN 'FAIL' ELSE 'PASS' END,
         'expected', 'Zero rows across ALL overloads of group_mvp_execute and group_mvp_consume_rate.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM new_rpcs_rows r)
       ) AS data
UNION ALL
SELECT 6 AS section_order, 'membership_index'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN EXISTS (SELECT 1 FROM membership_index_rows WHERE is_expected_definition IS DISTINCT FROM true) THEN 'FAIL' ELSE 'PASS' END,
         'expected', 'Absent, or valid/ready ordinary btree index on public.room_members(user_id, room_id), with no predicate, expressions, INCLUDE columns or nondefault key formatting.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM membership_index_rows r)
       ) AS data
UNION ALL
SELECT 7 AS section_order, 'constraints'::text AS section,
       jsonb_build_object(
         'status', 'REVIEW'::text,
         'expected', 'Review primary/foreign keys and deletion behavior against the approved audit. room_members user_id continues to reference auth.users.id.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM constraints_rows r)
       ) AS data
UNION ALL
SELECT 8 AS section_order, 'indexes'::text AS section,
       jsonb_build_object(
         'status', 'REVIEW'::text,
         'expected', 'Review PK indexes and exact rooms_room_key_unique name enforcing room_key uniqueness. IF NOT EXISTS does not validate an existing index.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM indexes_rows r)
       ) AS data
UNION ALL
SELECT 9 AS section_order, 'generator'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN EXISTS (SELECT 1 FROM generator_rows WHERE argument_count=0 AND return_type='text'::regtype) THEN 'REVIEW' ELSE 'FAIL' END,
         'expected', 'Must include generate_room_key() returning text. Review full definition, owner, ACL and settings; securely retain the original.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM generator_rows r)
       ) AS data
UNION ALL
SELECT 10 AS section_order, 'table_security'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN (SELECT count(*) FROM table_security_rows)=3 THEN 'REVIEW' ELSE 'FAIL' END,
         'expected', 'Review owners, original ACL and RLS/FORCE flags for all three tables against the saved baseline.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM table_security_rows r)
       ) AS data
UNION ALL
SELECT 11 AS section_order, 'policies'::text AS section,
       jsonb_build_object(
         'status', 'REVIEW'::text,
         'expected', 'Review every policy, including profiles policy dependencies. An empty policy list is not automatically safe.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM policies_rows r)
       ) AS data
UNION ALL
SELECT 12 AS section_order, 'default_privileges'::text AS section,
       jsonb_build_object(
         'status', 'REVIEW'::text,
         'expected', 'Review global and public-schema defaults, especially for the intended creator; ensure explicit migration REVOKEs cover all general grantees.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM default_privileges_rows r)
       ) AS data
)
SELECT section, data
FROM report
ORDER BY section_order;
commit;
