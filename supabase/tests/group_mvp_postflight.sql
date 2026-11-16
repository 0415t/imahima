-- READ ONLY: after an explicitly approved migration, before group traffic.
-- One result set: section TEXT, data JSONB with status / expected / actual.
-- PASS = checked predicate passed; REVIEW = compare with the saved baseline;
-- FAIL = stop. Missing required new objects intentionally error and stop.
-- Export all 10 sections as one CSV. No mutation RPC or generator is invoked.
begin read only;
WITH
connection_rows AS (
select current_database(),current_user,session_user
),
table_security_rows AS (
select c.oid::regclass as table_name, pg_get_userbyid(c.relowner) as owner,
       c.relrowsecurity,c.relforcerowsecurity,c.relacl
from pg_class c where c.oid in ('public.rooms'::regclass,'public.room_members'::regclass,'public.group_mvp_rate_limits'::regclass)
),
general_table_privileges_rows AS (
select r.role_name,t.table_name,x.privilege,
       has_table_privilege(r.role_name,t.table_name,x.privilege) as allowed
from (values ('anon'),('authenticated')) r(role_name)
cross join (values ('public.rooms'),('public.room_members'),('public.group_mvp_rate_limits')) t(table_name)
cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) x(privilege)
),
rpc_execute_privileges_rows AS (
select r.role_name,f.signature,
       has_function_privilege(r.role_name,f.signature,'EXECUTE') as can_execute
from (values ('anon'),('authenticated'),('service_role')) r(role_name)
cross join (values ('public.group_mvp_execute(text,uuid,jsonb)'),
                   ('public.group_mvp_consume_rate(text,integer)')) f(signature)
),
rpc_security_rows AS (
select p.oid::regprocedure as function_name,pg_get_userbyid(p.proowner) as owner,
       p.prosecdef as security_definer,p.proconfig,p.proacl
from pg_proc p where p.oid in (
 'public.group_mvp_execute(text,uuid,jsonb)'::regprocedure,
 'public.group_mvp_consume_rate(text,integer)'::regprocedure)
),
service_table_privileges_rows AS (
select t.table_name,x.privilege,
       has_table_privilege('service_role',t.table_name,x.privilege) as allowed
from (values ('public.rooms'),('public.room_members'),('public.group_mvp_rate_limits')) t(table_name)
cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) x(privilege)
),
service_profile_read_rows AS (
select has_table_privilege('service_role','public.profiles','SELECT') as service_profile_read
),
room_counts_rows AS (
select count(*) as total_rooms,
       count(*) filter (where mvp_created_by is not null) as mvp_rooms,
       count(*) filter (where mvp_archived_at is not null) as archived_rooms
from public.rooms
),
membership_count_rows AS (
select count(*) as memberships from public.room_members
),
generator_definition_rows AS (
select pg_get_functiondef('public.generate_room_key()'::regprocedure) as generator_definition
),
report AS (
SELECT 1 AS section_order, 'connection'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN current_database()='postgres' AND current_user IN ('postgres','supabase_admin') THEN 'REVIEW' ELSE 'FAIL' END,
         'expected', 'Same approved project, database postgres and expected execution role. Compare Project Ref separately.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM connection_rows r)
       ) AS data
UNION ALL
SELECT 2 AS section_order, 'table_security'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN (SELECT count(*) FROM table_security_rows)=3 AND NOT EXISTS(SELECT 1 FROM table_security_rows WHERE relrowsecurity IS DISTINCT FROM true) THEN 'REVIEW' ELSE 'FAIL' END,
         'expected', 'All three tables exist and RLS is enabled. Compare owners and ACLs with the approved deployment baseline.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM table_security_rows r)
       ) AS data
UNION ALL
SELECT 3 AS section_order, 'general_table_privileges'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN (SELECT count(*) FROM general_table_privileges_rows)=42 AND NOT EXISTS(SELECT 1 FROM general_table_privileges_rows WHERE allowed IS DISTINCT FROM false) THEN 'PASS' ELSE 'FAIL' END,
         'expected', 'All 42 role/table/privilege combinations must have allowed=false, including TRUNCATE, REFERENCES and TRIGGER.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM general_table_privileges_rows r)
       ) AS data
UNION ALL
SELECT 4 AS section_order, 'rpc_execute_privileges'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN (SELECT count(*) FROM rpc_execute_privileges_rows)=6 AND NOT EXISTS(SELECT 1 FROM rpc_execute_privileges_rows WHERE can_execute IS DISTINCT FROM (role_name='service_role')) THEN 'PASS' ELSE 'FAIL' END,
         'expected', 'anon/authenticated cannot execute either RPC; service_role can execute both. Six combinations required.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM rpc_execute_privileges_rows r)
       ) AS data
UNION ALL
SELECT 5 AS section_order, 'rpc_security'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN (SELECT count(*) FROM rpc_security_rows)=2 AND NOT EXISTS(SELECT 1 FROM rpc_security_rows WHERE security_definer IS DISTINCT FROM false OR NOT coalesce('search_path=""'=ANY(proconfig),false)) THEN 'REVIEW' ELSE 'FAIL' END,
         'expected', 'Both RPCs must be SECURITY INVOKER, with empty search_path; verify owner against the actual migration execution role and review ACL.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM rpc_security_rows r)
       ) AS data
UNION ALL
SELECT 6 AS section_order, 'service_table_privileges'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN (SELECT count(*) FROM service_table_privileges_rows)=12 AND NOT EXISTS(SELECT 1 FROM service_table_privileges_rows WHERE allowed IS DISTINCT FROM true) THEN 'PASS' ELSE 'FAIL' END,
         'expected', 'All 12 service_role table/DML combinations must have allowed=true.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM service_table_privileges_rows r)
       ) AS data
UNION ALL
SELECT 7 AS section_order, 'service_profile_read'::text AS section,
       jsonb_build_object(
         'status', CASE WHEN EXISTS(SELECT 1 FROM service_profile_read_rows WHERE service_profile_read IS TRUE) THEN 'PASS' ELSE 'FAIL' END,
         'expected', 'service_role SELECT on profiles must remain true.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM service_profile_read_rows r)
       ) AS data
UNION ALL
SELECT 8 AS section_order, 'room_counts'::text AS section,
       jsonb_build_object(
         'status', 'REVIEW'::text,
         'expected', 'Before smoke writes/traffic, compare total_rooms to saved baseline and expect zero MVP/archived markers. Counts alone do not prove original IDs, names or invitation codes are unchanged.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM room_counts_rows r)
       ) AS data
UNION ALL
SELECT 9 AS section_order, 'membership_count'::text AS section,
       jsonb_build_object(
         'status', 'REVIEW'::text,
         'expected', 'Compare with the securely saved baseline before test writes or traffic. A matching count alone does not prove membership pairs are unchanged.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM membership_count_rows r)
       ) AS data
UNION ALL
SELECT 10 AS section_order, 'generator_definition'::text AS section,
       jsonb_build_object(
         'status', 'REVIEW'::text,
         'expected', 'Review the complete definition: UUIDv4 with hyphens removed yields 32 hex characters. This read-only query does not call the generator or verify code issuance by execution.',
         'actual', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) FROM generator_definition_rows r)
       ) AS data
)
SELECT section, data
FROM report
ORDER BY section_order;
commit;
