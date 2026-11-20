import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';
import {execFileSync} from 'node:child_process';import {EventEmitter} from 'node:events';
import {statements,transactionBody,inTransaction,rollbackOnly,applyRecorded,probeRejected} from './sql-transactions.mjs';
import {runComparison,comparisonPaths,normalization} from './comparison-runner.mjs';
import {enterFailureSuite,verifyFailureGate,connectAndValidate,closeAll,exactIds,assertProfileStates,expectedMutation,roleQuery,assertTimerDeadline,requiredCheck} from './verification-control.mjs';
import {assertListing,assertEnabled} from './cli-assertions.mjs';
import {assertNoGrantOptions} from './acl.mjs';import {snapshot,differences} from './catalog.mjs';
import {startBackend} from './backend-lifecycle.mjs';
import {assertBlockedActive,handledRequest,verifyLockExpiry} from './lock-expiry.mjs';
import {root,repo} from './configuration.mjs';
const vmAssert={...assert,deepEqual:(a,b,m)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)),m)};
const source=f=>fs.readFileSync(path.join(root,f),'utf8');
const old=f=>execFileSync('git',['-c','safe.directory='+repo,'show','244c43858408852252ec159e5d8caeb6c8baef31:verification/issue35/'+f],{cwd:repo,encoding:'utf8'});
const oldSql=f=>execFileSync('git',['-c','safe.directory='+repo,'show','244c43858408852252ec159e5d8caeb6c8baef31:supabase/migrations/'+f],{cwd:repo,encoding:'utf8'});
const sqlFiles=fs.readdirSync(path.join(repo,'supabase/migrations')).sort();
const sql=f=>fs.readFileSync(path.join(repo,'supabase/migrations',f),'utf8');
const initial=()=>({objects:[],history:[],marker:false,defaults:false,member:false,archive:false});
class MemoryDB{
 constructor(db={state:initial(),lock:false}){this.db=db;this.log=[];this.saved=null;this.fail=null;this.ended=false;}
 get state(){return this.db.state;}
 async end(){this.ended=true;}
 async query(text,args=[]){
  this.log.push(text);
  if(text.includes('pg_try_advisory_lock')){const locked=!this.db.lock;if(locked)this.db.lock=true;return{rows:[{locked}]};}
  if(text.includes('pg_advisory_unlock')){const unlocked=this.db.lock;this.db.lock=false;return{rows:[{unlocked}]};}
  if(text.includes("to_regclass('issue35_verification"))return{rows:[{present:this.state.marker}]};
  if(text.startsWith('select nspname')||text.includes('from pg_depend')||text.includes('from pg_class'))return{rows:[]};
  if(text==='select count(*)::text n from auth.users')return{rows:[{n:'0'}]};
  const pieces=statements(text);if(pieces.length>1){let result;for(const p of pieces)result=await this.query(p.sql.trim(),args);return result;}
  const command=pieces[0]?.tokens||'';
  if(command==='BEGIN'){this.saved=structuredClone(this.state);return{rows:[]};}
  if(command==='ROLLBACK'){if(this.saved)this.db.state=this.saved;this.saved=null;return{rows:[]};}
  if(command==='COMMIT'){if(this.fail==='COMMIT')throw Error('Commit failed');this.saved=null;return{rows:[]};}
  if(text.startsWith('select name,statements'))return{rows:this.state.history.filter(r=>r.version===args[0])};
  if(text.startsWith('insert into supabase_migrations.schema_migrations')){if(this.fail==='history')throw Error('History insert failed');this.state.history.push({version:args[0],name:args[1],statements:args[2]});}
  if(/create schema issue35_verification/i.test(text))this.state.marker=true;
  if(/alter default privileges/i.test(text))this.state.defaults=true;
  if(/create table demo/i.test(text))this.state.objects.push('demo');
  if(text.includes('FAIL_SQL'))throw Error('SQL failed');
  return{rows:[]};
 }
}
const migration={version:'20261118000000',name:'demo',sql:'-- header\nBEGIN;\nCREATE TABLE demo(id integer);\nCOMMIT;'};
function checks(){const rows=[];return{rows,async check(name,fn){try{await fn();rows.push({name,pass:true});return true;}catch(e){rows.push({name,pass:false,error:e});return false;}}};}
test('No.6: lexer unwraps every actual migration without touching files',()=>{assert.equal(sqlFiles.length,22);for(const f of sqlFiles){const body=transactionBody(sql(f));assert.ok(body.length);assert.ok(!statements(body).some(p=>['BEGIN','COMMIT'].includes(p.tokens)));}});
test('No.6: SQL strings identifiers nested comments and dollar bodies remain intact',()=>{const body="DO $fn$ BEGIN RAISE NOTICE 'COMMIT;'; END $fn$; SELECT 'BEGIN;''x', \"COMMIT;\"; /* a /* b */ c */ SELECT E'a\\\\b';";assert.equal(transactionBody('BEGIN;'+body+'COMMIT;'),body);});
test('No.6: unexpected or incomplete transaction controls rejected before SQL',()=>{for(const s of['BEGIN; SELECT 1;','SELECT 1; COMMIT;','BEGIN; SAVEPOINT x; COMMIT;',"SELECT 'unterminated", '/* unclosed'])assert.throws(()=>transactionBody(s));});
test('No.6: old SQL commit leaves effects after history failure; new path rolls everything back',async()=>{const oldClient=new MemoryDB();await oldClient.query(migration.sql);assert.deepEqual(oldClient.state.objects,['demo']);await oldClient.query('ROLLBACK');assert.deepEqual(oldClient.state.objects,['demo']);const c=new MemoryDB();c.fail='history';await assert.rejects(applyRecorded(c,migration),/History/);assert.deepEqual(c.state,initial());});
test('No.6: success is published only after SQL and history COMMIT',async()=>{const c=new MemoryDB();let committed=false;await applyRecorded(c,{...migration,onCommitted:()=>{assert.equal(c.log.at(-1),'COMMIT');assert.equal(c.state.history.length,1);committed=true;}});assert.equal(committed,true);assert.deepEqual(c.state.objects,['demo']);});
for(const failure of['SQL','COMMIT'])test('No.6: '+failure+' failure rolls back and never publishes success',async()=>{const c=new MemoryDB();if(failure==='COMMIT')c.fail='COMMIT';let passed=false;await assert.rejects(applyRecorded(c,{...migration,sql:failure==='SQL'?migration.sql.replace('CREATE TABLE demo(id integer);','CREATE TABLE demo(id integer); FAIL_SQL;'):migration.sql,onCommitted:()=>passed=true}));assert.deepEqual(c.state,initial());assert.equal(passed,false);});
test('No.6: existing version with different SQL is rejected',async()=>{const c=new MemoryDB();await applyRecorded(c,migration);await assert.rejects(applyRecorded(c,{...migration,sql:migration.sql+' -- changed'}),/SQL drift/);});
test('No.18: unexpectedly successful negative probe still rolls back',async()=>{const c=new MemoryDB();await assert.rejects(probeRejected(c,{sql:migration.sql,classification:[],expected:/classification/}));assert.deepEqual(c.state,initial());});
test('No.5: failed delete or incorrect archive cannot contaminate baseline',async()=>{for(const archive of[false,true]){const c=new MemoryDB();await assert.rejects(rollbackOnly(c,async()=>{c.state.member=true;if(!archive)throw Error('Delete failed');c.state.member=false;c.state.archive=true;assert.equal(c.state.archive,false);}));assert.deepEqual(c.state,initial());}});
test('No.3/8: actual failure-suite entry rejects changed B before mutation and closes clients',async()=>{const a={end:async()=>a.closed=true},b={end:async()=>b.closed=true};let mutations=0;await assert.rejects((async()=>{await enterFailureSuite({connect:async label=>label==='a'?a:b,snapshot:async c=>({acl:[c===a?'safe':'drift']}),record:{differences:[]}});mutations++;})(),/Current A\/B/);assert.equal(mutations,0);assert.equal(a.closed,true);assert.equal(b.closed,true);});
test('No.3: saved differences gate accepts stale evidence; actual fresh gate rejects it',async()=>{const saved={differences:[]};assert.deepEqual(saved.differences,[]);await assert.rejects(verifyFailureGate({clients:['a','b'],snapshot:async x=>({acl:[x]}),record:saved}));});
test('No.19/36: failed identity and partial acquisition close acquired clients',async()=>{const c={connect:async()=>{},end:async()=>c.closed=true};const original=Error('Identity mismatch');await assert.rejects(connectAndValidate({createClient:()=>c,config:{},validate:async()=>{throw original;}}),e=>e===original);assert.equal(c.closed,true);const a={end:async()=>a.closed=true};const report=checks();await runComparison({connect:async label=>{if(label==='b')throw Error('B failed');return a;},snapshot:async()=>({}),check:report.check,write:async()=>assert.fail('Cannot write success')});assert.equal(a.closed,true);assert.equal(report.rows[0].pass,false);});
test('No.36: close failure does not prevent other cleanup or replace primary error',async()=>{let second=false;const primary=Error('Original');await closeAll([{end:async()=>{throw Error('close');}},{end:async()=>second=true}],primary);assert.equal(second,true);assert.equal(primary.cleanupErrors.length,1);});
test('No.37: snapshot failure recorded as incomplete rather than 0/0',async()=>{const report=checks(),c={end:async()=>{}};await runComparison({connect:async()=>c,snapshot:async()=>{throw Error('snapshot');},check:report.check,write:async()=>assert.fail('No result')});assert.equal(report.rows.filter(r=>!r.pass).length,1);assert.match(report.rows[0].name,/incomplete/);});
test('No.38/39: pre-failure paths and labels cannot overwrite final evidence',async()=>{const before=comparisonPaths('/reports','/runtime',true,path),after=comparisonPaths('/reports','/runtime',false,path);assert.notEqual(before.detail,after.detail);assert.notEqual(before.checks,after.checks);assert.notEqual(before.catalog,after.catalog);assert.match(normalization,/CRLF/);const report=checks();await runComparison({connect:async()=>({end:async()=>{}}),snapshot:async()=>({tables:[]}),check:report.check,before:true,write:async result=>assert.deepEqual(result.differences,[])});assert.match(report.rows[0].name,/pre-failure/);});
const oldCli=()=>vm.runInNewContext(old('cli-assertions.mjs').replace(/^import[^\n]*\n/gm,'').replaceAll('export function','function')+';({assertListing,assertEnabled})',{assert:vmAssert});
test('No.14: complete pairs plus local-only or remote-only extras fail',()=>{const base='20261118000000 | 20261118000000 | time';for(const extra of['20990101000000 | | time',' | 20990101000000 | time']){oldCli().assertListing(base+'\n'+extra,['20261118000000']);assert.throws(()=>assertListing(base+'\n'+extra,['20261118000000']),/unmatched/);}});
test('No.15: false commented wrong or duplicate TOML settings fail',()=>{oldCli().assertEnabled('[dbXmigrations]\nenabled = true');for(const text of['[dbXmigrations]\nenabled = true','# [db.migrations]\nenabled = true','[db.migrations]\nenabled = false\n[other]\nenabled = true','[db.migrations]\nenabled = true\nenabled = false'])assert.throws(()=>assertEnabled(text));assertEnabled('[db.migrations]\nenabled = true # approved');});
test('No.20: effective ownership/inheritance options cannot hide behind empty raw ACL',async()=>{const src=old('acl.mjs');const oldAssert=vm.runInNewContext('('+src.slice(src.indexOf('export async function assertNoGrantOptions')).replace('export ','').trim()+')',{assert:vmAssert,grantOptions:async()=>[]});await oldAssert({});for(const kind of['ownership','inheritance']){const c={query:async sql=>({rows:sql.includes('has_table_privilege')?[{kind,grantable:true}]:[]})};await assert.rejects(assertNoGrantOptions(c),/effective GRANT OPTION/);}});
function catalogClient({replica='d',defaults=false}={}){return{async query(sql){if(sql.includes('from pg_default_acl'))return{rows:defaults?[{creator:'postgres',schema:'public',object_type:'r',grantee:'anon',privilege_type:'SELECT',is_grantable:false}]:[]};if(sql.includes('c.relrowsecurity'))return{rows:[{relname:'room_message_events',...(sql.includes('relreplident')?{relreplident:replica}:{})}]};if(sql.includes('pg_get_indexdef'))return{rows:[{index_name:'events_pk',...(sql.includes('indisreplident')?{indisreplident:replica==='i'}:{})}]};return{rows:[]};}};}
test('No.13/44: replica identity and default-only changes alter actual snapshots',async()=>{const a=await snapshot(catalogClient()),replica=await snapshot(catalogClient({replica:'i'})),defaults=await snapshot(catalogClient({defaults:true}));assert.ok(differences(a,replica).includes('tables'));assert.ok(differences(a,replica).includes('indexes'));assert.deepEqual(differences(a,defaults),['default_privileges']);});
test('No.28: SQL failure propagates without RESET ROLE masking',async()=>{const original=Object.assign(Error('permission denied'),{code:'42501'});let failed=false;const c={query:async sql=>{if(sql.startsWith('SET'))return{};if(failed)throw Object.assign(Error('aborted'),{code:'25P02'});failed=true;throw original;}};await assert.rejects(roleQuery(c,'bad query'),e=>e===original);});
test('No.29: unrelated assertion or unique constraint cannot kill a mutant',()=>{const unrelated=Object.assign(Error('Unrelated'),{code:'ERR_ASSERTION'});assert.throws(()=>expectedMutation(unrelated,'OFF_RECIPIENT_INVALID'));expectedMutation(Object.assign(Error('OFF_RECIPIENT_INVALID'),{code:'ERR_ASSERTION'}),'OFF_RECIPIENT_INVALID');const duplicate={code:'23505',table:'wrong',constraint:'wrong'};assert.throws(()=>expectedMutation(duplicate,'DUPLICATE',{table:'member_free_notifications',constraint:'expected'}));expectedMutation({...duplicate,table:'member_free_notifications',constraint:'expected'},'DUPLICATE',{table:'member_free_notifications',constraint:'expected'});});
test('No.30: count-preserving ID substitution fails',()=>{const actual=[10,12],expected=[10,11];assert.equal(actual.length,expected.length);assert.equal(new Set(actual).size,expected.length);assert.throws(()=>exactIds(actual,expected),/substituted/);exactIds([10,11],expected);});
test('No.34: missing or incorrect ON fixtures fail before replay',()=>{const now=new Date(),ids=['unlimited','active','expired'],rows=[{id:ids[0],is_free:true,free_until:null},{id:ids[1],is_free:true,free_until:new Date(+now+3600000)},{id:ids[2],is_free:true,free_until:new Date(+now-3600000)}];assertProfileStates(rows,ids,now);assert.throws(()=>assertProfileStates(rows.slice(1),ids,now));assert.throws(()=>assertProfileStates(rows.map((r,i)=>i===2?{...r,free_until:null}:r),ids,now));});
test('No.17: failed required check cannot publish a success marker',()=>{let marker=false;assert.throws(()=>{requiredCheck(false,'history');marker=true;});assert.equal(marker,false);requiredCheck(true,'history');});
test('No.26: waiter must identify the fixture blocker while still active',()=>{const now=new Date();assertBlockedActive({now,blockers:[7]},new Date(+now+100),7);assert.throws(()=>assertBlockedActive({now,blockers:[8]},new Date(+now+100),7));assert.throws(()=>assertBlockedActive({now:new Date(+now+200),blockers:[7]},new Date(+now+100),7));});
test('No.27: old loose bound accepts pre-lock origin; precise bound rejects it',()=>{const release=1000000000000,completion=release+100,wrong=new Date(release+1800000-1000).toISOString();assert.ok(Date.parse(wrong)>release+25*60000);assert.throws(()=>assertTimerDeadline(wrong,release,completion));assertTimerDeadline(new Date(release+1800000+50).toISOString(),release,completion);});
test('No.47: rejected HTTP handled and settled while releasing lock after observer error',async()=>{const requestError=Error('HTTP failed'),observerError=Error('Observer failed'),queries=[];const c={query:async s=>{queries.push(s);return{rows:[s.includes('returning')?{free_until:new Date(Date.now()+4000)}:{pid:7}]};}};const observer={query:async()=>{throw observerError;}};await assert.rejects(verifyLockExpiry({c,observer,id:'synthetic',request:()=>Promise.reject(requestError),kind:'set'}),e=>e===observerError);assert.equal(queries.at(-1),'ROLLBACK');assert.equal((await handledRequest(Promise.reject(requestError))).error,requestError);});
class Child extends EventEmitter{constructor(){super();this.exitCode=null;this.signalCode=null;this.kills=[];}kill(signal='SIGTERM'){this.kills.push(signal);setImmediate(()=>{this.exitCode=0;this.emit('exit',0);});return true;}}
test('No.4/25: unready or hanging health stops child and closes log',async()=>{for(const hanging of[false,true]){const child=new Child();let closed=0,aborted=false;const fetch=async(u,{signal})=>hanging?new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true})):{ok:false};await assert.rejects(startBackend({spawn:()=>child,openLog:()=>99,closeLog:()=>closed++,fetch,url:'http://local/health',timeout:15,poll:1,killTimeout:20}),/readiness/);assert.equal(closed,1);assert.equal(child.exitCode,0);assert.equal(child.kills.length,1);if(hanging)assert.equal(aborted,true);}});
test('No.4: spawn error closes log; ready backend returns an idempotent stop handle',async()=>{let closed=0;await assert.rejects(startBackend({spawn(){throw Error('spawn');},openLog:()=>99,closeLog:()=>closed++,fetch:async()=>({ok:true}),url:'local'}),/spawn/);assert.equal(closed,1);const child=new Child();const handle=await startBackend({spawn:()=>child,openLog:()=>99,closeLog:()=>closed++,fetch:async()=>({ok:true}),url:'local'});assert.equal(child.kills.length,0);await handle.stop();await handle.stop();assert.equal(closed,2);});
test('No.1: approved H1 conditionally preserves the archive column grant',()=>{const file=sqlFiles.find(f=>f.includes('harden_core')),before=oldSql(file),after=sql(file);assert.ok(!before.includes('$managed_insert$'));assert.match(after,/IF EXISTS[\s\S]*attname='mvp_managed'[\s\S]*GRANT INSERT \(mvp_managed\)/);for(const exists of[false,true]){const grants=new Set(['room_name','room_key','mvp_created_by']);if(exists&&after.includes('$managed_insert$'))grants.add('mvp_managed');assert.equal(grants.has('mvp_managed'),exists);}for(const f of sqlFiles.filter(f=>f.includes('harden_notification')||f.includes('harden_chat')))assert.ok(!sql(f).includes('ON public.rooms'));});
test('No.42: H4 checks every required core column before its grant',()=>{const file=sqlFiles.find(f=>f.includes('harden_archive')),before=oldSql(file),after=sql(file);for(const column of['room_name','room_key','mvp_created_by']){assert.ok(!before.includes("'"+column+"'"));assert.ok(after.includes("has_column_privilege('service_role','public.rooms','"+column+"','INSERT')"));}assert.ok(after.indexOf('Core room INSERT column privileges required')<after.indexOf('GRANT INSERT (mvp_managed)'));});

import {liveExclusion,currentPushEvidence} from './delivery-evidence.mjs';
test('No.22/24: a dead subscription cannot pass the actual exclusion helper',async()=>{
 let sent=0;
 // Previous negative-only assertion accepts a completely dead subscription.
 assert.equal([].some(x=>x==='denied'),false);
 await assert.rejects(liveExclusion({positive:async()=>++sent,negative:async()=>++sent,received:()=>false,wait:async fn=>assert.ok(fn(),'Control event missing'),settle:async()=>{}}),/Control event missing/);
 assert.equal(sent,1,'Denied probe must not run without positive control');
});
test('No.22/24: live stream passes exclusion; leaking denied event fails',async()=>{
 for(const leak of [false,true]){const seen=new Set();const invoke=()=>liveExclusion({positive:async()=>{seen.add('control');return 'control';},negative:async()=>{if(leak)seen.add('denied');return 'denied';},received:id=>seen.has(id),wait:async fn=>assert.ok(fn()),settle:async()=>{}});if(leak)await assert.rejects(invoke(),/Unauthorized Realtime/);else await invoke();}
});
test('No.48: historical success and wrong-recipient Push cannot satisfy current worker',()=>{
 const token='synthetic-token',hash=createHash('sha256').update(token).digest('hex');
 const record=ids=>Buffer.from(JSON.stringify({mode:'ok',recipient_sha256:ids})+'\n');
 const previous=record([hash]),wrong=record(['someone-else']);
 assert.ok(previous.toString().includes('ok'),'Old text-only probe accepts old evidence');
 assert.throws(()=>currentPushEvidence(previous,previous.length,token),/Current worker/);
 assert.throws(()=>currentPushEvidence(Buffer.concat([previous,wrong]),previous.length,token),/Current worker/);
 currentPushEvidence(Buffer.concat([previous,record([hash])]),previous.length,token);
 assert.throws(()=>currentPushEvidence(previous,previous.length+1,token),/offset/);
});
test('No.33/45/46: live harness retains all four replays, trigger and OFF prerequisites',()=>{
 const failures=source('failures.mjs'),features=source('features.mjs');
 assert.match(failures,/for\(const file of hardening\)/);
 assert.match(failures,/Auth fixture did not create a profile/);
 assert.match(failures,/\['profiles','auth.users'\]/);
 assert.match(features,/is_free,false/);assert.match(features,/free_until,null/);
});

import {cleanupResources} from './verification-control.mjs';
test('No.4/36: channel cleanup failure cannot skip backend stop or DB close',async()=>{
 const ran=[];await assert.rejects(cleanupResources([async()=>{ran.push('channel');throw Error('channel');},async()=>{ran.push('backend');throw Error('backend');},async()=>ran.push('db')]),e=>e instanceof AggregateError&&e.errors.length===2);assert.deepEqual(ran,['channel','backend','db']);
});
function callback(file,label){const s=source(file),start=s.indexOf("await check(label+' "+label);assert.ok(start>=0);const body=s.indexOf('async()=>{',start),end=s.lastIndexOf('});',s.indexOf('\n',body));return s.slice(body,end+1);}
test('No.46: actual OFF test rejects timed-ON prerequisite instead of accepting unrelated 409',async()=>{
 const body=callback('features.mjs','invalid duration and OFF extension preserve profile');
 for(const broken of [false,true]){
  let extended=false;
  const api=async(u,route,method,args)=>{if(route.endsWith('/extend')){extended=true;return{status:409};}if(args?.duration_minutes===31)return{status:400};return{status:200,data:{is_free:broken,free_until:broken?'future':null}};};
  const c={query:async()=>({rows:[{is_free:broken,free_until:broken?'future':null}]})};
  const run=()=>vm.runInNewContext('('+body+')()',{api,c,a:{id:'fixture'},assert:vmAssert});
  if(broken){await assert.rejects(run());assert.equal(extended,false);}else{await run();assert.equal(extended,true);}
 }
});
test('No.45: actual rollback-fixture test fails if Auth trigger never created profile',async()=>{
 const body=callback('failures.mjs','failed fixture transaction preserves data');
 for(const created of [false,true]){
  let transaction=false,rolled=false,proved=false;
  const c={query:async(s)=>{if(s.startsWith('select count'))return{rows:[{n:9}]};if(s.includes('insert into auth.users'))return{rows:[]};if(s==='select 1/0')throw Object.assign(Error('divide'),{code:'22012'});if(s.includes('select exists')){if(transaction){proved=true;return{rows:[{present:created}]};}return{rows:[{present:false}]};}throw Error(s);}};
  const rollbackOnly=async(client,fn)=>{transaction=true;try{await fn();}finally{transaction=false;rolled=true;}};
  const run=()=>vm.runInNewContext('('+body+')()',{c,rollbackOnly,randomUUID:()=> 'synthetic',assert:vmAssert});
  if(created)await run();else await assert.rejects(run(),/did not create a profile/);
  assert.equal(rolled,true);assert.equal(proved,true);
 }
});
