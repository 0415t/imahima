import assert from 'node:assert/strict';
export async function grantOptions(c) {
 const roles="(a.grantee=0 or pg_get_userbyid(a.grantee) in ('anon','authenticated','service_role'))";
 const q=async(sql)=>(await c.query(sql)).rows;
 return await q(`select * from (
 select 'relation' kind,n.nspname||'.'||c.relname object,'' subobject,case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee,pg_get_userbyid(a.grantor) grantor,a.privilege_type,a.is_grantable from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner))) a where n.nspname='public' and ${roles}
 union all select 'column',n.nspname||'.'||c.relname,t.attname,case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable from pg_attribute t join pg_class c on c.oid=t.attrelid join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(t.attacl) a where n.nspname='public' and t.attnum>0 and not t.attisdropped and ${roles}
 union all select 'function',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')','',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname in ('public','chat_private','group_mvp_private') and ${roles}
 union all select 'schema',n.nspname,'',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a where n.nspname in ('public','chat_private','group_mvp_private','auth','extensions','cron') and ${roles}
 ) x order by kind,object,subobject,grantee,grantor,privilege_type`);
}
export async function assertNoGrantOptions(c) {
 const rows=await grantOptions(c);assert.deepEqual(rows.filter(r=>r.is_grantable),[],'Unexpected application GRANT OPTION');return {acl_entries:rows.length,roles:['PUBLIC','anon','authenticated','service_role']};
}
