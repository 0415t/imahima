-- READ ONLY. Run after migration IF removal is being considered. No removal SQL.
begin read only;
with targets(classid,objid,objsubid,label) as (
 select 'pg_class'::regclass,c.oid,0,c.oid::regclass::text
 from pg_class c where c.oid in (
   to_regclass('public.group_mvp_rate_limits'),
   to_regclass('public.idx_room_members_user_id_room_id'))
 union all
 select 'pg_proc'::regclass,p.oid,0,p.oid::regprocedure::text
 from pg_proc p where p.oid in (
   to_regprocedure('public.group_mvp_execute(text,uuid,jsonb)'),
   to_regprocedure('public.group_mvp_consume_rate(text,integer)'))
 union all
 select 'pg_class'::regclass,a.attrelid,a.attnum,'public.rooms.'||a.attname
 from pg_attribute a where a.attrelid='public.rooms'::regclass
   and a.attname in ('mvp_created_by','mvp_archived_at') and not a.attisdropped
)
select t.label,pg_describe_object(d.classid,d.objid,d.objsubid) as dependent_object,d.deptype
from targets t left join pg_depend d
 on d.refclassid=t.classid and d.refobjid=t.objid
 and (t.objsubid=0 or d.refobjsubid=t.objsubid)
order by t.label,dependent_object;

-- Text search supplements catalog dependencies; dynamic SQL/external callers
-- and PL/pgSQL body references may not be tracked. Recursively inspect callers.
with routines as (
 select p.oid::regprocedure as routine,pg_get_functiondef(p.oid) as definition
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where p.prokind in ('f','p') and n.nspname not in ('pg_catalog','information_schema')
   and n.nspname not like 'pg_toast%'
)
select * from routines where definition ~* '\m(group_mvp_execute|group_mvp_consume_rate|group_mvp_rate_limits|mvp_created_by|mvp_archived_at)\M';
commit;
