import{createBaseline,migrateBaseline,assertPreserved}from'./b-baseline.mjs';
import{randomUUID}from'node:crypto';import{roleQuery,requiredCheck}from'./verification-control.mjs';
import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';
import{connect,plan,repo,files,original,hardening,save,check}from'./db.mjs';
import{applyRecorded,inTransaction,rollbackOnly}from'./sql-transactions.mjs';
const c=await connect(plan.label);try{
 const tables=(await c.query("select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in('r','p')")).rows;
 assert.equal(tables.length,0,'Existing application tables: refusing provisioning');
 const hist=(await c.query("select to_regclass('supabase_migrations.schema_migrations') present")).rows[0].present;
 if(hist)assert.equal((await c.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n,0,'Existing migration history');
 assert.equal((await c.query('select count(*)::int n from auth.users')).rows[0].n,0,'Existing Auth users');
 assert.equal((await c.query('select count(*)::int n from issue35_verification.provisioning_state')).rows[0].n,0,'Partial provisioning exists; use a new temporary project');
 await c.query("insert into issue35_verification.provisioning_state(id,status)values(true,'started')");
 await inTransaction(c,()=>c.query('create schema if not exists supabase_migrations;create table if not exists supabase_migrations.schema_migrations(version text primary key,name text,statements text[])'));
 const read=name=>fs.readFileSync(path.join(repo,'supabase/migrations',name),'utf8'),file=version=>{const name=files.find(f=>f.startsWith(version+'_'));assert.ok(name,'Missing fixed migration');return name;};
 const probeH1=async()=>requiredCheck(await check('H1 intermediate group creation remains available',()=>rollbackOnly(c,async()=>{
   const id=randomUUID();await c.query("insert into auth.users(id,aud,role,email,raw_user_meta_data)values($1,'authenticated','authenticated',$2,'{}')",[id,id+'@issue35.invalid']);
   const rows=await roleQuery(c,"select public.group_mvp_execute('create',$1,$2::jsonb) result",[id,JSON.stringify({name:'Synthetic H1 intermediate'})]);
   assert.equal(rows[0].result.status,201);
  })),'H1 intermediate runtime compatibility');
 if(plan.label==='b'){
  const baseline=await createBaseline(c,{file,read,applied:name=>check('baseline '+name,()=>true)});
  fs.writeFileSync(path.join(plan.runtime,'b.baseline.private.json'),JSON.stringify(baseline.data),{flag:'wx'});
  fs.writeFileSync(path.join(plan.runtime,'b.coverage.json'),JSON.stringify(baseline.coverage),{flag:'wx'});
  await migrateBaseline(c,{file,read,hardening,afterH1:probeH1,applied:name=>check('B '+name,()=>true)});
  requiredCheck(await check('B preserves all synthetic existing data',()=>assertPreserved(c,baseline.data)),'B data preservation');
 }else{
 for(const f of [...original,...hardening]){
  const sql=fs.readFileSync(path.join(repo,'supabase/migrations',f),'utf8');
  await applyRecorded(c,{version:f.slice(0,14),name:f.slice(15,-4),sql,classification:f.includes('managed_archive')?[]:undefined,onCommitted:()=>check('applied '+f,()=>true)});
  if(f===hardening[0])await probeH1();

 }
 }
 assert.deepEqual((await c.query('select version from supabase_migrations.schema_migrations order by version')).rows.map(r=>r.version),files.map(f=>f.slice(0,14)));
 await c.query("update issue35_verification.provisioning_state set status='complete' where id=true");
 await c.query("NOTIFY pgrst, 'reload schema'");
}finally{await c.end();}save('migration-results');
