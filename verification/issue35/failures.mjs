import{snapshot}from'./catalog.mjs';
import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{execFileSync}from'node:child_process';import{connect,repo,hardening,runtime,project,root,check,save}from'./db.mjs';
async function acl(c){return(await c.query("select a.attname,r.rolname,v.p,has_column_privilege(r.oid,a.attrelid,a.attnum,v.p) allowed from pg_attribute a cross join pg_roles r cross join(values('SELECT'),('INSERT'),('UPDATE'),('REFERENCES'))v(p) where a.attrelid='public.profiles'::regclass and a.attnum>0 and not a.attisdropped and r.rolname in('anon','authenticated','service_role') order by a.attnum,r.rolname,v.p")).rows;}
const full=fs.readFileSync(path.join(repo,'supabase/migrations',hardening[0]),'utf8');const inner=full.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
for(const label of ['a','b']){const c=await connect(label);try{
 // Require the untouched migration-path comparison. Never repair or rewrite history here.
 const gate=JSON.parse(fs.readFileSync(path.join(runtime,'pre-failure-comparison.json'),'utf8'));assert.deepEqual(gate.differences,[]);
 const historyBefore=(await c.query('select * from supabase_migrations.schema_migrations order by version')).rows;
 const catalogBefore=await snapshot(c);
 const before=await acl(c);
 await check(label+' unsafe profile prerequisite abort and rollback',async()=>{await c.query('BEGIN');try{await c.query('grant update(is_free)on profiles to authenticated');await assert.rejects(c.query(inner),/Apply restrict/i);}finally{await c.query('ROLLBACK');}assert.deepEqual(await acl(c),before);});
 await check(label+' mid-migration metadata mismatch restores earlier ACL resets',async()=>{await c.query('BEGIN');try{await c.query('alter table users disable row level security');await assert.rejects(c.query(inner),/Unexpected target table metadata/);}finally{await c.query('ROLLBACK');}assert.deepEqual(await acl(c),before);assert.equal((await c.query("select relrowsecurity from pg_class where oid='public.users'::regclass")).rows[0].relrowsecurity,true);});
 await check(label+' unexpected role inheritance stops migration',async()=>{const sql="BEGIN;CREATE ROLE issue35_rollback_parent;GRANT issue35_rollback_parent TO authenticated;SET LOCAL ROLE postgres;\n"+inner;let rejected=false;try{execFileSync('wsl',['-d','imahima-issue35-acl','-u','root','--','docker','--host','unix:///run/imahima35-docker.sock','exec','-i','supabase_db_'+project(label),'psql','-X','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1','-q'],{input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe']});}catch(e){fs.writeFileSync(path.join(runtime,label+'.rollback-role.private.log'),String(e.stderr));rejected=/Unexpected application role configuration/.test(String(e.stderr));}assert.equal(rejected,true);assert.deepEqual(await acl(c),before);assert.equal((await c.query("select count(*)::int n from pg_roles where rolname='issue35_rollback_parent'")).rows[0].n,0);});

 await check(label+' invalid room classifications roll back without schema or data drift',async()=>{
  const originalArchive=fs.readdirSync(path.join(repo,'supabase/migrations')).find(f=>f.includes('group_mvp_managed_archive'));
  const archiveSql=fs.readFileSync(path.join(repo,'supabase/migrations',originalArchive),'utf8');
  const rows=(await c.query('select id,mvp_managed,mvp_archived_at from rooms order by id')).rows;
  const complete=rows.map(r=>({room_id:r.id,mvp_managed:r.mvp_managed,evidence:'Synthetic classification fixture'}));
  const duplicate=structuredClone(complete);duplicate[0].room_id=duplicate[1].room_id;
  const unknown=structuredClone(complete);unknown[0].room_id='35000000-ffff-4fff-8fff-ffffffffffff';
  const noEvidence=structuredClone(complete);noEvidence[0].evidence='';
  for(const manifest of[null,[],duplicate,unknown,noEvidence]){
   await c.query("select set_config('imahima.room_classification',$1,false)",[JSON.stringify(manifest)]);
   try{await assert.rejects(c.query(archiveSql),/classification/i);}finally{await c.query('ROLLBACK');}
   assert.deepEqual((await c.query('select id,mvp_managed,mvp_archived_at from rooms order by id')).rows,rows);
  }
  return{cases:5};
 });
 await check(label+' historical group migration replay fails without changes',async()=>{
  const f=fs.readdirSync(path.join(repo,'supabase/migrations')).find(x=>x.includes('group_management_mvp'));
  try{await assert.rejects(c.query(fs.readFileSync(path.join(repo,'supabase/migrations',f),'utf8')),e=>e.code==='42701');}finally{await c.query('ROLLBACK');}
  assert.deepEqual(await acl(c),before);
 });
 await check(label+' PUBLIC-default EXECUTE cannot re-open runtime functions',async()=>{const r=await c.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname in('public','chat_private','group_mvp_private') and p.proname in('handle_new_user','generate_room_key','set_profile_is_free','claim_free_end_notifications','claim_member_free_notifications','chat_send_message','archive_empty_membership_rooms') and a.grantee=0");assert.equal(r.rows[0].n,0);});
 await check(label+' failed fixture transaction preserves data',async()=>{const count=(await c.query('select count(*)::int n from profiles')).rows[0].n;await c.query('BEGIN');try{await c.query("insert into auth.users(id,aud,role,email,raw_user_meta_data)values(gen_random_uuid(),'authenticated','authenticated','rollback@example.test','{}')");await assert.rejects(c.query('select 1/0'));}finally{await c.query('ROLLBACK');}assert.equal((await c.query('select count(*)::int n from profiles')).rows[0].n,count);});

 await check(label+' hardening preserves unlimited, active and expired ON values',async()=>{
  await c.query('BEGIN');try{
   const ids=[];
   for(let i=0;i<3;i++)ids.push((await c.query("insert into auth.users(id,aud,role,email,raw_user_meta_data)values(gen_random_uuid(),'authenticated','authenticated',gen_random_uuid()::text||'@example.test','{}')returning id")).rows[0].id);
   await c.query("update profiles set is_free=true,free_until=case when id=$1 then null when id=$2 then clock_timestamp()+interval '1 hour' else clock_timestamp()-interval '1 hour' end where id=any($3)",[ids[0],ids[1],ids]);
   const prior=(await c.query('select * from public.profiles where id=any($1)order by id',[ids])).rows;
   await c.query(inner);
   const h4=fs.readFileSync(path.join(repo,'supabase/migrations',hardening[3]),'utf8').replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');await c.query(h4);
   assert.deepEqual((await c.query('select * from public.profiles where id=any($1)order by id',[ids])).rows,prior);
  }finally{await c.query('ROLLBACK');}
  assert.deepEqual(await acl(c),before);
 });
 await check(label+' exact 22-version history has no pending migration',async()=>{const rows=(await c.query('select version from supabase_migrations.schema_migrations')).rows;const versions=new Set(rows.map(x=>x.version));for(const file of fs.readdirSync(path.join(repo,'supabase/migrations')))assert.ok(versions.has(file.slice(0,14)));assert.equal(versions.size,22);});
 await check(label+' failure suite leaves complete catalog untouched',async()=>assert.deepEqual(await snapshot(c),catalogBefore));
 await check(label+' failure suite leaves full migration history untouched',async()=>assert.deepEqual((await c.query('select * from supabase_migrations.schema_migrations order by version')).rows,historyBefore));
 }finally{await c.end();}}
save('failure-results');
