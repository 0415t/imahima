import{enterFailureSuite,closeAll,assertProfileStates}from'./verification-control.mjs';
import{transactionBody,rollbackOnly}from'./sql-transactions.mjs';
import{randomUUID}from'node:crypto';
import{snapshot}from'./catalog.mjs';import{digest,verifySavedCatalog}from'./verification-control.mjs';
import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{execFileSync}from'node:child_process';import{connect,repo,hardening,runtime,project,root,labels,plan,notRun,check,save}from'./db.mjs';
async function acl(c){return(await c.query("select a.attname,r.rolname,v.p,has_column_privilege(r.oid,a.attrelid,a.attnum,v.p) allowed from pg_attribute a cross join pg_roles r cross join(values('SELECT'),('INSERT'),('UPDATE'),('REFERENCES'))v(p) where a.attrelid='public.profiles'::regclass and a.attnum>0 and not a.attisdropped and r.rolname in('anon','authenticated','service_role') order by a.attnum,r.rolname,v.p")).rows;}
const full=fs.readFileSync(path.join(repo,'supabase/migrations',hardening[0]),'utf8');const inner=transactionBody(full);
const record=JSON.parse(fs.readFileSync(path.join(plan.runDir,plan.label+'.snapshot.json'),'utf8'));
const clients=[];
try{const c=await connect(plan.label);clients.push(c);
const current=await snapshot(c);verifySavedCatalog(record,current,plan.target.ref);
if(plan.label==='b'){const comparison=JSON.parse(fs.readFileSync(path.join(plan.runDir,'comparison.json'),'utf8'));assert.equal(comparison.b_ref,plan.target.ref);assert.equal(comparison.b_digest,digest(current));assert.deepEqual(comparison.differences,[]);}
const catalogs=[current];
for(const [index,label]of labels.entries()){
 const historyBefore=(await c.query('select * from supabase_migrations.schema_migrations order by version')).rows;
 const catalogBefore=catalogs[index];
 const before=await acl(c);
 await check(label+' H4 rejects each missing core INSERT prerequisite atomically',async()=>{
  const h4=transactionBody(fs.readFileSync(path.join(repo,'supabase/migrations',hardening[3]),'utf8'));
  const prior=await snapshot(c);
  for(const column of ['room_name','room_key','mvp_created_by']){
   await c.query('BEGIN');try{await c.query('revoke insert('+column+') on public.rooms from service_role');await assert.rejects(c.query(h4),/Core room INSERT column privileges required/);}finally{await c.query('ROLLBACK');}
   assert.deepEqual(await snapshot(c),prior);
  }
 });

 await check(label+' unsafe profile prerequisite abort and rollback',async()=>{await c.query('BEGIN');try{await c.query('grant update(is_free)on profiles to authenticated');await assert.rejects(c.query(inner),/Apply restrict/i);}finally{await c.query('ROLLBACK');}assert.deepEqual(await acl(c),before);});
 await check(label+' mid-migration metadata mismatch restores earlier ACL resets',async()=>{await c.query('BEGIN');try{await c.query('alter table users disable row level security');await assert.rejects(c.query(inner),/Unexpected target table metadata/);}finally{await c.query('ROLLBACK');}assert.deepEqual(await acl(c),before);assert.equal((await c.query("select relrowsecurity from pg_class where oid='public.users'::regclass")).rows[0].relrowsecurity,true);});
 notRun(label+' unexpected managed-role inheritance mutation','Hosted supabase_admin unavailable; verify actual role metadata and offline guard contract.');

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
 await check(label+' failed fixture transaction preserves data',async()=>{const count=(await c.query('select count(*)::int n from profiles')).rows[0].n;const id=randomUUID();await rollbackOnly(c,async()=>{await c.query("insert into auth.users(id,aud,role,email,raw_user_meta_data)values($1,'authenticated','authenticated',$2,'{}')",[id,id+'@example.test']);assert.equal((await c.query('select exists(select 1 from profiles where id=$1) present',[id])).rows[0].present,true,'Auth fixture did not create a profile');await assert.rejects(c.query('select 1/0'),e=>e.code==='22012');});assert.equal((await c.query('select count(*)::int n from profiles')).rows[0].n,count);for(const table of ['profiles','auth.users'])assert.equal((await c.query('select exists(select 1 from '+table+' where id=$1) present',[id])).rows[0].present,false);});

 await check(label+' hardening preserves unlimited, active and expired ON values',async()=>{
  await c.query('BEGIN');try{
   const ids=[];
   for(let i=0;i<3;i++)ids.push((await c.query("insert into auth.users(id,aud,role,email,raw_user_meta_data)values(gen_random_uuid(),'authenticated','authenticated',gen_random_uuid()::text||'@example.test','{}')returning id")).rows[0].id);
   await c.query("update profiles set is_free=true,free_until=case when id=$1 then null when id=$2 then clock_timestamp()+interval '1 hour' else clock_timestamp()-interval '1 hour' end where id=any($3)",[ids[0],ids[1],ids]);
   const prior=(await c.query('select * from public.profiles where id=any($1)order by id',[ids])).rows;const now=(await c.query('select clock_timestamp() now')).rows[0].now;assertProfileStates(prior,ids,now);
   for(const file of hardening)await c.query(transactionBody(fs.readFileSync(path.join(repo,'supabase/migrations',file),'utf8')));
   assert.deepEqual((await c.query('select * from public.profiles where id=any($1)order by id',[ids])).rows,prior);
  }finally{await c.query('ROLLBACK');}
  assert.deepEqual(await acl(c),before);
 });
 await check(label+' exact 22-version history has no pending migration',async()=>{const rows=(await c.query('select version from supabase_migrations.schema_migrations')).rows;const versions=new Set(rows.map(x=>x.version));for(const file of fs.readdirSync(path.join(repo,'supabase/migrations')))assert.ok(versions.has(file.slice(0,14)));assert.equal(versions.size,22);});
 await check(label+' failure suite leaves complete catalog untouched',async()=>assert.deepEqual(await snapshot(c),catalogBefore));
 await check(label+' failure suite leaves full migration history untouched',async()=>assert.deepEqual((await c.query('select * from supabase_migrations.schema_migrations order by version')).rows,historyBefore));
 }}finally{await closeAll(clients);}
save('failure-results');
