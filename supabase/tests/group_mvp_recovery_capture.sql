-- READ ONLY. Run BEFORE applying the group migration in the intended project.
-- One SELECT result: section TEXT, data JSONB (an array in every section).
-- Export the complete result as one CSV; empty sections are [] and NULL fields
-- remain JSON null. Definitions and generated SQL strings are never executed.
-- Save outside Git. Missing original generator intentionally fails the capture.
begin read only;
WITH
capture_context_rows AS (
select current_database(),current_user,session_user,now() as captured_at
),
generator_definition_rows AS (
select p.oid::regprocedure as function_name,
       pg_get_userbyid(p.proowner) as owner,p.proacl,p.proconfig,p.prosecdef,
       pg_get_functiondef(p.oid) as original_definition,
       format('ALTER FUNCTION public.generate_room_key() OWNER TO %I;',
              pg_get_userbyid(p.proowner)) as restore_owner_statement
from pg_proc p where p.oid='public.generate_room_key()'::regprocedure
),
generator_execute_grants_rows AS (
select pg_get_userbyid(a.grantor) as grantor,
       case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       a.privilege_type,a.is_grantable,
       format('GRANT %s ON FUNCTION public.generate_room_key() TO %s%s;',
         a.privilege_type,
         case when a.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(a.grantee)) end,
         case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as restore_statement
from pg_proc p
cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
where p.oid='public.generate_room_key()'::regprocedure
),
table_security_rows AS (
select c.oid::regclass as table_name,pg_get_userbyid(c.relowner) as owner,c.relacl,
       c.relrowsecurity,c.relforcerowsecurity,
       format('ALTER TABLE %s %s ROW LEVEL SECURITY;',c.oid::regclass,
         case when c.relrowsecurity then 'ENABLE' else 'DISABLE' end) as restore_rls_statement,
       format('ALTER TABLE %s %s ROW LEVEL SECURITY;',c.oid::regclass,
         case when c.relforcerowsecurity then 'FORCE' else 'NO FORCE' end) as restore_force_statement
from pg_class c where c.oid in ('public.rooms'::regclass,'public.room_members'::regclass)
),
table_grants_rows AS (
select c.oid::regclass as table_name,pg_get_userbyid(a.grantor) as grantor,
       case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       a.privilege_type,a.is_grantable,
       format('GRANT %s ON TABLE %s TO %s%s;',a.privilege_type,c.oid::regclass,
         case when a.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(a.grantee)) end,
         case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as restore_statement
from pg_class c
cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
where c.oid in ('public.rooms'::regclass,'public.room_members'::regclass)
),
column_grants_rows AS (
select c.oid::regclass as table_name,att.attname,att.attacl,
       pg_get_userbyid(a.grantor) as grantor,
       case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       a.privilege_type,a.is_grantable,
       format('GRANT %s (%I) ON TABLE %s TO %s%s;',a.privilege_type,att.attname,c.oid::regclass,
         case when a.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(a.grantee)) end,
         case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as restore_statement
from pg_class c join pg_attribute att on att.attrelid=c.oid
cross join lateral aclexplode(att.attacl) a
where c.oid in ('public.rooms'::regclass,'public.room_members'::regclass)
  and att.attnum>0 and not att.attisdropped
),
policies_rows AS (
select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
from pg_policies where schemaname='public' and tablename in ('rooms','room_members','profiles')
),
constraints_rows AS (
select conrelid::regclass as table_name,conname,contype,convalidated,
       pg_get_constraintdef(oid) as definition
from pg_constraint where conrelid in ('public.rooms'::regclass,'public.room_members'::regclass,'public.profiles'::regclass)
),
indexes_rows AS (
select indexname,indexdef from pg_indexes where schemaname='public' and tablename in ('rooms','room_members')
),
new_objects_rows AS (
select to_regclass('public.group_mvp_rate_limits') as rate_table,
       to_regprocedure('public.group_mvp_execute(text,uuid,jsonb)') as management_rpc,
       to_regprocedure('public.group_mvp_consume_rate(text,integer)') as rate_rpc,
       to_regclass('public.idx_room_members_user_id_room_id') as membership_index
),
new_columns_rows AS (
select column_name,data_type from information_schema.columns
where table_schema='public' and table_name='rooms'
  and column_name in ('mvp_created_by','mvp_archived_at')
),
report AS (
SELECT 1 AS section_order, 'capture_context'::text AS section,
       (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)
        FROM capture_context_rows r) AS data
UNION ALL
SELECT 2 AS section_order, 'generator_definition'::text AS section,
       (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)
        FROM generator_definition_rows r) AS data
UNION ALL
SELECT 3 AS section_order, 'generator_execute_grants'::text AS section,
       (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)
        FROM generator_execute_grants_rows r) AS data
UNION ALL
SELECT 4 AS section_order, 'table_security'::text AS section,
       (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)
        FROM table_security_rows r) AS data
UNION ALL
SELECT 5 AS section_order, 'table_grants'::text AS section,
       (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)
        FROM table_grants_rows r) AS data
UNION ALL
SELECT 6 AS section_order, 'column_grants'::text AS section,
       (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)
        FROM column_grants_rows r) AS data
UNION ALL
SELECT 7 AS section_order, 'policies'::text AS section,
       (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)
        FROM policies_rows r) AS data
UNION ALL
SELECT 8 AS section_order, 'constraints'::text AS section,
       (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)
        FROM constraints_rows r) AS data
UNION ALL
SELECT 9 AS section_order, 'indexes'::text AS section,
       (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)
        FROM indexes_rows r) AS data
UNION ALL
SELECT 10 AS section_order, 'new_objects'::text AS section,
       (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)
        FROM new_objects_rows r) AS data
UNION ALL
SELECT 11 AS section_order, 'new_columns'::text AS section,
       (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb)
        FROM new_columns_rows r) AS data
)
SELECT section, data
FROM report
ORDER BY section_order;
commit;
