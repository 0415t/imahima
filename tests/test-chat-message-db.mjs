// Opt-in fresh PostgreSQL17 on loopback. No .env, shared DB, Docker or Push API.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import net from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transactionBody } from '../verification/issue35/sql-transactions.mjs';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
require('tsx/cjs');
const { createChatMessageNotificationPoller } = require('../server/jobs/chat-message-notifications.ts');

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assert.ok(process.env.ISSUE36_PG_BIN,'Explicit ISSUE36_PG_BIN (PostgreSQL17 bin directory) required');
const bin=path.resolve(process.env.ISSUE36_PG_BIN),run=path.join(root,'.runtime','issue36-db-'+randomUUID()),data=path.join(run,'data');
fs.mkdirSync(run,{recursive:true});
const env={...process.env};for(const k of Object.keys(env))if(/^(PG|SUPABASE_|EXPO_PUBLIC_|DATABASE_URL$|ISSUE35_|ISSUE36_)/.test(k))delete env[k];env.PGSSLMODE='disable';
const exe=n=>path.join(bin,n+(process.platform==='win32'?'.exe':''));
assert.match(cp.execFileSync(exe('postgres'),['--version'],{env,encoding:'utf8',windowsHide:true}),/PostgreSQL\) 17\./);
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const args=['-X','-w','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=terse'];
const report={completed:false,serverStopped:false,sharedConnections:0,pushRequests:0,tests:[],limitations:['Synthetic auth.uid/users and inert Cron fixtures; no real Auth HTTP/Realtime service or devices']};
let started=false,query=0;
function cmd(name,argv,fail=false){const r=cp.spawnSync(exe(name),argv,{env,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});if(!fail)assert.equal(r.status,0,r.stderr||r.error?.message);return r;}
function ctl(argv){const r=cp.spawnSync(exe('pg_ctl'),argv,{env,windowsHide:true,stdio:'ignore',timeout:30000});assert.equal(r.status,0,'Isolated pg_ctl failed');}
function sql(text,fail=false,user='postgres') {if(user==='postgres'&&text.startsWith('SET ROLE service_role;'))user='service_role';const f=path.join(run,'query-'+(++query)+'.sql');fs.writeFileSync(f,text+'\n');return cmd('psql',[...args,'-U',user,'-f',f],fail);}
function value(text){return sql(text).stdout.trim();}
const lit=s=>"'"+String(s).replaceAll("'","''")+"'";
const service=s=>'SET ROLE service_role;'+s+';RESET ROLE;';
const rpc=(name,params)=>JSON.parse(value(service('SELECT public.'+name+'('+params+')')));
function test(name,fn){fn();report.tests.push({name,passed:true});console.log('PASS '+name);}
function fixture(){
 const actor=randomUUID(),recipient=randomUUID(),off=randomUUID();
 for(const [id,name]of [[actor,'Sender snapshot'],[recipient,'Recipient'],[off,'OFF recipient']])sql(`INSERT INTO auth.users VALUES(${lit(id)},jsonb_build_object('username',${lit(name)}));`);
 const room=rpc('group_mvp_execute',`'create',${lit(actor)},'{"name":"Synthetic chat"}'` ).data.group.id;
 sql(`INSERT INTO public.room_members(room_id,user_id) VALUES(${lit(room)},${lit(recipient)}),(${lit(room)},${lit(off)});`);
 value(service(`SELECT * FROM public.set_profile_is_free(${lit(recipient)},true,30)`));
 const client=randomUUID();
 const send=()=>rpc('chat_send_message',`${lit(actor)},${lit(room)},'Synthetic body',${lit(client)}`);
 return {actor,recipient,off,room,client,send};
}
function notification(f){return value(`SELECT id FROM public.chat_message_notifications WHERE room_id=${lit(f.room)} AND recipient_user_id=${lit(f.recipient)};`);}
function claim(f,max=3){return JSON.parse(value(service(`SELECT coalesce(json_agg(c),'[]') FROM public.claim_chat_message_notifications(1000,120,${max}) c`))).find(c=>c.notification_id===notification(f));}
function validation(id,token){return JSON.parse(value(service(`SELECT row_to_json(v) FROM public.validate_chat_message_notification(${lit(id)},${lit(token)}) v`)));}
function finish(id,token,status,accepted=0){return value(service(`SELECT public.complete_chat_message_notification(${lit(id)},${lit(token)},${lit(status)},NULL,${accepted})`));}
function parallel(text){return new Promise((resolve,reject)=>{const child=cp.spawn(exe('psql'),[...args,'-U','service_role'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',c=>c===0?resolve(out.trim()):reject(Error(err)));child.stdin.end(text);});}
function heldTransaction(text) {
 const child=cp.spawn(exe('psql'),[...args,'-U','service_role'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let output='',errors='',readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const timer=setTimeout(()=>{child.stdin.end('ROLLBACK;\n');readyReject(Error('Isolated transaction barrier timeout'));},10000);
 child.stdout.on('data',b=>{output+=b;if(output.includes('issue36_transaction_held')){clearTimeout(timer);readyResolve();}});
 child.stderr.on('data',b=>errors+=b);child.on('error',readyReject);
 const done=new Promise((resolve,reject)=>child.on('close',c=>{clearTimeout(timer);if(c===0)resolve(output);else{const e=Error(errors);readyReject(e);reject(e);}}));
 child.stdin.write('BEGIN;'+text+";SELECT 'issue36_transaction_held';\n");
 return {ready,done,commit:()=>child.stdin.end('COMMIT;\n'),rollback:()=>child.stdin.end('ROLLBACK;\n')};
}
try{
 cmd('initdb',['-D',data,'-U','fixture_admin','-A','trust','--no-locale','--encoding=UTF8']);started=true;
 ctl(['start','-D',data,'-l',path.join(run,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -c ssl=off -c wal_level=logical -c max_connections=20 -c shared_buffers=32MB`,'-w','-t','15']);
 sql(`CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS;
 CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role LOGIN BYPASSRLS;CREATE ROLE supabase_admin NOLOGIN BYPASSRLS;
 ALTER DATABASE postgres OWNER TO postgres;CREATE SCHEMA auth AUTHORIZATION supabase_admin;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_user_meta_data jsonb);ALTER TABLE auth.users OWNER TO supabase_admin;
 GRANT ALL ON auth.users TO postgres;GRANT USAGE,CREATE ON SCHEMA auth TO postgres;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE SCHEMA cron AUTHORIZATION postgres;CREATE TABLE cron.job(jobname text);ALTER TABLE cron.job OWNER TO postgres;
 INSERT INTO cron.job VALUES('auto-expire-free-status');
 CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$SELECT 1::bigint$$;
 GRANT ALL ON SCHEMA public TO postgres;`,false,'fixture_admin');
 assert.equal(path.resolve(sql('SHOW data_directory',false,'fixture_admin').stdout.trim()).toLowerCase(),data.toLowerCase());
 assert.equal(value('SELECT NOT rolsuper AND rolbypassrls FROM pg_roles WHERE rolname=current_user'),'t');
 sql(`CREATE PUBLICATION supabase_realtime;ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;`);
 const versions=['20261001000000','20261006000000','20261017000000','20261104000000','20261105000000','20261105000001','20261106000000','20261106000001','20261111000000',
 '20261111000001','20261118000000','20261107000000','20261110000000','20261117000001','20261117000000','20261112000000','20261118000001','20261113000000','20261118000002','20261116000000','20261118000003'];
 const files=fs.readdirSync(path.join(root,'supabase/migrations'));
 for(const version of versions){const file=files.find(f=>f.startsWith(version+'_'));assert.ok(file);const body=transactionBody(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8'));sql("BEGIN;SET LOCAL imahima.room_classification='[]';"+body+'COMMIT;');}
 const preserved=fixture();
 const originalMembership=value(`SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY user_id)::text) FROM public.room_members m WHERE room_id=${lit(preserved.room)}`);
 const aclBefore=value("SELECT jsonb_agg(jsonb_build_object('name',c.relname,'acl',c.relacl::text) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'");
 sql('BEGIN;'+transactionBody(fs.readFileSync(path.join(root,'supabase/migrations/20261121000000_chat_message_push_notifications.sql'),'utf8'))+'COMMIT;');
 test('migration applies after actual H1-H4 with nonsuperuser postgres',()=>assert.equal(value("SELECT count(*) FROM pg_trigger WHERE tgname IN('chat_push_enqueue','chat_push_cancel_deleted','chat_push_membership_generation')"),'3'));
 test('existing membership data and table ACLs are preserved; generations backfilled',()=>{
  assert.equal(value(`SELECT md5(jsonb_agg(to_jsonb(m)-'push_membership_id' ORDER BY user_id)::text) FROM public.room_members m WHERE room_id=${lit(preserved.room)}`),originalMembership);
  assert.equal(value("SELECT jsonb_agg(jsonb_build_object('name',c.relname,'acl',c.relacl::text) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'chat_message_notifications'"),aclBefore);
  assert.equal(value(`SELECT count(*)=count(DISTINCT push_membership_id) FROM public.room_members WHERE room_id=${lit(preserved.room)}`),'t');
 });
 test('OFF sender saves messages; only same-room ON recipient is snapshotted',()=>{
  const f=fixture(),sent=f.send();assert.equal(sent.status,201);
  assert.equal(value(`SELECT count(*) FROM public.chat_message_notifications WHERE room_id=${lit(f.room)}`),'1');
  assert.equal(value(`SELECT bool_and(n.recipient_period_id=p.free_period_id AND n.recipient_membership_id=rm.push_membership_id AND n.expires_at=m.created_at+interval '5 minutes') FROM public.chat_message_notifications n JOIN public.profiles p ON p.id=n.recipient_user_id JOIN public.room_members rm ON rm.room_id=n.room_id AND rm.user_id=p.id JOIN public.messages m ON m.id=n.message_id WHERE n.room_id=${lit(f.room)}`),'t');
  assert.equal(f.send().data.deduplicated,true);assert.equal(value(`SELECT count(*) FROM public.chat_message_notifications WHERE room_id=${lit(f.room)}`),'1');
  value(service(`SELECT * FROM public.set_profile_is_free(${lit(f.off)},true,30)`));
  assert.equal(value(`SELECT count(*) FROM public.chat_message_notifications WHERE room_id=${lit(f.room)}`),'1');
 });
 test('outbox failure rolls back message and event; same client ID can retry',()=>{
  const f=fixture();sql(`CREATE FUNCTION public.issue36_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Synthetic outbox failure';END$$;CREATE TRIGGER issue36_fail BEFORE INSERT ON public.chat_message_notifications FOR EACH ROW EXECUTE FUNCTION public.issue36_fail();`);
  const r=sql(service(`SELECT public.chat_send_message(${lit(f.actor)},${lit(f.room)},'Synthetic body',${lit(f.client)})`),true);assert.notEqual(r.status,0);
  assert.equal(value(`SELECT count(*) FROM public.messages WHERE room_id=${lit(f.room)}`),'0');assert.equal(value(`SELECT count(*) FROM public.room_message_events WHERE room_id=${lit(f.room)}`),'0');
  sql('DROP TRIGGER issue36_fail ON public.chat_message_notifications;DROP FUNCTION public.issue36_fail();');assert.equal(f.send().status,201);
 });
 test('OFF then ON cancels the old period; extension preserves it',()=>{
  const f=fixture();f.send();const c=claim(f);assert.ok(validation(c.notification_id,c.lease_token).still_valid);
  value(service(`SELECT * FROM public.extend_profile_is_free(${lit(f.recipient)})`));assert.ok(validation(c.notification_id,c.lease_token).still_valid);
  value(service(`SELECT * FROM public.set_profile_is_free(${lit(f.recipient)},false,NULL);SELECT * FROM public.set_profile_is_free(${lit(f.recipient)},true,30)`));
  assert.equal(validation(c.notification_id,c.lease_token).still_valid,false);
 });
 test('leave and rejoin in ONE transaction never restores an old membership',()=>{
  const f=fixture();f.send();const c=claim(f);const key=value(`SELECT room_key FROM public.rooms WHERE id=${lit(f.room)}`);
  const joined=value(`SELECT joined_at FROM public.room_members WHERE room_id=${lit(f.room)} AND user_id=${lit(f.recipient)}`);
  value(service(`BEGIN;SELECT public.group_mvp_execute('leave',${lit(f.recipient)},jsonb_build_object('room_id',${lit(f.room)}));SELECT public.group_mvp_execute('join',${lit(f.recipient)},jsonb_build_object('invite_code',${lit(key)}));COMMIT`));
  sql(`UPDATE public.room_members SET joined_at=${lit(joined)} WHERE room_id=${lit(f.room)} AND user_id=${lit(f.recipient)}`);
  assert.equal(validation(c.notification_id,c.lease_token).still_valid,false);
 });
 test('role changes preserve membership; moving away and back rotates generation',()=>{
  const f=fixture();f.send();const c=claim(f);
  sql(`UPDATE public.room_members SET role='owner' WHERE room_id=${lit(f.room)} AND user_id=${lit(f.recipient)}`);
  assert.ok(validation(c.notification_id,c.lease_token).still_valid);
  const other=rpc('group_mvp_execute',`'create',${lit(f.actor)},'{"name":"Other room"}'`).data.group.id;
  sql(`BEGIN;UPDATE public.room_members SET room_id=${lit(other)} WHERE room_id=${lit(f.room)} AND user_id=${lit(f.recipient)};UPDATE public.room_members SET room_id=${lit(f.room)} WHERE room_id=${lit(other)} AND user_id=${lit(f.recipient)};COMMIT;`);
  assert.equal(validation(c.notification_id,c.lease_token).still_valid,false);
 });
 test('sender leave and Auth deletion preserve the message and saved display name',()=>{
  const f=fixture();f.send();const c=claim(f);
  rpc('group_mvp_execute',`'leave',${lit(f.actor)},jsonb_build_object('room_id',${lit(f.room)})`);
  assert.ok(validation(c.notification_id,c.lease_token).still_valid);
  sql(`SET ROLE supabase_admin;DELETE FROM auth.users WHERE id=${lit(f.actor)};RESET ROLE;`,false,'fixture_admin');
  const v=validation(c.notification_id,c.lease_token);assert.ok(v.still_valid);assert.equal(v.sender_name,'Sender snapshot');
  assert.equal(value(`SELECT sender_id IS NULL AND deleted_at IS NULL FROM public.messages WHERE id=${lit(c.message_id)}`),'t');
 });
 test('deletion cancels unsent rows, retains tombstone and never regenerates on retry',()=>{
  const f=fixture();const sent=f.send();const c=claim(f);
  rpc('chat_delete_message',`${lit(f.actor)},${lit(f.room)},${lit(sent.data.message.id)}`);
  assert.equal(validation(c.notification_id,c.lease_token).owned,false);
  assert.equal(value(`SELECT status FROM public.chat_message_notifications WHERE id=${lit(c.notification_id)}`),'cancelled');
  assert.equal(f.send().data.deduplicated,true);assert.equal(value(`SELECT count(*) FROM public.chat_message_notifications WHERE room_id=${lit(f.room)}`),'1');
 });
 test('retry delay respected, expired lease gets a new token and old owner is refused',()=>{
  const f=fixture();f.send();const c=claim(f);assert.equal(finish(c.notification_id,c.lease_token,'failed'),'t');
  assert.equal(claim(f),undefined);sql(`UPDATE public.chat_message_notifications SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=${lit(c.notification_id)}`);
  const second=claim(f);assert.notEqual(second.lease_token,c.lease_token);assert.equal(finish(c.notification_id,c.lease_token,'sent',1),'f');
  sql(`UPDATE public.chat_message_notifications SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${lit(c.notification_id)}`);
  const third=claim(f);assert.notEqual(third.lease_token,second.lease_token);assert.equal(finish(third.notification_id,third.lease_token,'failed'),'t');
  assert.equal(value(`SELECT status FROM public.chat_message_notifications WHERE id=${lit(c.notification_id)}`),'exhausted');
 });
 test('TTL forbids send/reclaim, but confirmed acceptance can be recorded after expiry',()=>{
  const f=fixture();f.send();const c=claim(f);
  sql(`UPDATE public.chat_message_notifications SET message_created_at=current_timestamp-interval '6 minutes',expires_at=current_timestamp-interval '1 minute' WHERE id=${lit(c.notification_id)}`);
  assert.equal(validation(c.notification_id,c.lease_token).still_valid,false);assert.equal(claim(f),undefined);
  assert.equal(value(`SELECT status FROM public.chat_message_notifications WHERE id=${lit(c.notification_id)}`),'expired');
  assert.equal(finish(c.notification_id,c.lease_token,'sent',1),'t');assert.equal(claim(f),undefined);
 });
 test('expired recipients and archived rooms are invalid without a send',()=>{
  const f=fixture();f.send();const c=claim(f);
  sql(`UPDATE public.profiles SET free_until=clock_timestamp()-interval '1 second' WHERE id=${lit(f.recipient)}`);
  assert.equal(validation(c.notification_id,c.lease_token).still_valid,false);
  const g=fixture();g.send();const d=claim(g);sql(`UPDATE public.rooms SET mvp_archived_at=clock_timestamp() WHERE id=${lit(g.room)}`);
  assert.equal(validation(d.notification_id,d.lease_token).still_valid,false);
 });
 test('app roles have no direct outbox or private-helper access; only server can call RPCs',()=>{
  for(const role of ['anon','authenticated','service_role'])assert.equal(value(`SELECT has_table_privilege('${role}','public.chat_message_notifications','SELECT') OR has_table_privilege('${role}','public.chat_message_notifications','INSERT')`),'f');
  for(const role of ['anon','authenticated'])assert.equal(value(`SELECT has_function_privilege('${role}','public.claim_chat_message_notifications(integer,integer,integer)','EXECUTE')`),'f');
  assert.equal(value("SELECT has_function_privilege('service_role','public.claim_chat_message_notifications(integer,integer,integer)','EXECUTE')"),'t');
  assert.equal(value("SELECT has_schema_privilege('service_role','chat_push_private','USAGE')"),'f');
  assert.equal(value("SELECT count(*) FROM pg_publication_tables WHERE tablename='chat_message_notifications'"),'0');
 });
 const atomic=fixture();
 const held=heldTransaction(`SELECT public.chat_send_message(${lit(atomic.actor)},${lit(atomic.room)},'Synthetic body',${lit(atomic.client)})`);
 try{
  await held.ready;
  assert.equal(value(`SELECT count(*) FROM public.messages WHERE room_id=${lit(atomic.room)}`),'0');
  assert.equal(value(`SELECT count(*) FROM public.chat_message_notifications WHERE room_id=${lit(atomic.room)}`),'0');
 }finally{held.commit();await held.done;}
 assert.equal(value(`SELECT count(*) FROM public.chat_message_notifications WHERE room_id=${lit(atomic.room)}`),'1');
 report.tests.push({name:'other connections cannot see message or outbox before commit',passed:true});
 const duplicate=fixture();const duplicateSql=service(`SELECT public.chat_send_message(${lit(duplicate.actor)},${lit(duplicate.room)},'Synthetic body',${lit(duplicate.client)})`);
 const duplicateResults=await Promise.all([parallel(duplicateSql),parallel(duplicateSql)]);
 assert.deepEqual(duplicateResults.map(x=>JSON.parse(x).status).sort(),[200,201]);
 assert.equal(value(`SELECT count(*) FROM public.chat_message_notifications WHERE room_id=${lit(duplicate.room)}`),'1');
 assert.equal(value(`SELECT count(*) FROM public.room_message_events WHERE room_id=${lit(duplicate.room)} AND event_type='created'`),'1');
 report.tests.push({name:'concurrent HTTP-style client-ID retries generate one event and outbox',passed:true});
 const f=fixture();f.send();const sqlClaim=service(`SELECT coalesce(json_agg(c),'[]') FROM public.claim_chat_message_notifications(1000,120,3) c`);
 const [one,two]=await Promise.all([parallel(sqlClaim),parallel(sqlClaim)]);const all=[...JSON.parse(one),...JSON.parse(two)];
 assert.equal(new Set(all.map(c=>c.notification_id)).size,all.length);assert.equal(all.filter(c=>c.notification_id===notification(f)).length,1);
 report.tests.push({name:'independent claim processes do not share any notification lease',passed:true});console.log('PASS independent claim processes');
 // The following scenarios use the real worker and RPCs, but only synthetic
 // loopback data and an injected Push transport. Retire earlier test work first.
 sql("UPDATE public.chat_message_notifications SET status='cancelled',lease_expires_at=NULL WHERE status IN('pending','processing','failed')");
 const slow=fixture(),later=fixture();slow.send();later.send();
 const pair=[notification(slow),notification(later)];
 const pairSql=pair.map(lit).join(',');
 const oldBatch=value(`BEGIN;SELECT count(*) FROM public.claim_chat_message_notifications(20,120,3);
 SELECT json_build_object('attempted',count(*) FILTER(WHERE attempts=1),'leased',count(*) FILTER(WHERE lease_token IS NOT NULL))
 FROM public.chat_message_notifications WHERE id IN(${pairSql});ROLLBACK`).split(/\r?\n/);
 assert.equal(oldBatch[0],'2');assert.deepEqual(JSON.parse(oldBatch[1]),{attempted:2,leased:2});
 report.tests.push({name:'old batch claim reproduces lease and attempt consumption for waiting work (rolled back)',passed:true});
 const mapClaim=c=>({notificationId:c.notification_id,roomId:c.room_id,messageId:c.message_id,recipientUserId:c.recipient_user_id,leaseToken:c.lease_token});
 function workerDeps(send,trace=[],asyncClaim=false){return {
  claimNotifications:async()=>{
   trace.push('claim');
   const query=service("SELECT coalesce(json_agg(c),'[]') FROM public.claim_chat_message_notifications(1,120,3) c");
   const rows=JSON.parse(asyncClaim?await parallel(query):value(query));
   return {claims:rows.map(mapClaim),error:null};
  },
  validateNotification:async(id,token)=>{const v=validation(id,token);return {validation:v?{
   owned:v.owned,stillValid:v.still_valid,senderName:v.sender_name,messageBody:v.message_body,remainingMs:v.remaining_ms,expiration:v.expiration,
  }:null,error:null};},
  getDeviceTokens:async()=>({tokens:['ExponentPushToken[synthetic]'],error:null}),
  sendPushNotifications:send,
  completeNotification:async(id,token,status,_reason,accepted)=>{
   trace.push('complete:'+id);return {completed:finish(id,token,status,accepted)==='t',error:null};
  },
 };}
 const acceptedResult={sent:1,error:null,failures:{temporary:0,permanent:0,unknown:0}};
 let unblockSlow,slowEntered;
 const slowReady=new Promise(resolve=>{slowEntered=resolve;});const slowGate=new Promise(resolve=>{unblockSlow=resolve;});
 const trace=[];let sendCount=0;
 const slowWorker=createChatMessageNotificationPoller(workerDeps(async(_tokens,_message,_signal,onAccepted)=>{
  if(++sendCount===1){slowEntered();await slowGate;}onAccepted(1);return acceptedResult;
 },trace));
 const slowRun=slowWorker.runOnce();
 try{
  await slowReady;
  assert.equal(value(`SELECT status||':'||attempts||':'||(lease_token IS NULL)::text FROM public.chat_message_notifications WHERE id=${lit(pair[1])}`),'pending:0:true');
  // Simulate server-side expiry of the preceding lease instead of sleeping 120s.
  sql(`UPDATE public.chat_message_notifications SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${lit(pair[0])}`);
  assert.equal(value(`SELECT status||':'||attempts||':'||(lease_expires_at IS NULL)::text FROM public.chat_message_notifications WHERE id=${lit(pair[1])}`),'pending:0:true');
  assert.deepEqual(trace,['claim']);
 }finally{unblockSlow();await slowRun;await slowWorker.stop();}
 assert.deepEqual(trace,['claim','complete:'+pair[0],'claim','complete:'+pair[1],'claim']);
 assert.equal(value(`SELECT count(*) FROM public.chat_message_notifications WHERE id IN(${pairSql}) AND status='sent' AND attempts=1`),'2');
 report.tests.push({name:'real worker does not lease waiting work; claims next immediately after completion',passed:true});

 const concurrent=[fixture(),fixture()];for(const item of concurrent)item.send();
 const concurrentIds=concurrent.map(notification),sentIds=[];
 let releaseWorkers,bothSending;const bothReady=new Promise(resolve=>{bothSending=resolve;});const sendGate=new Promise(resolve=>{releaseWorkers=resolve;});
 const workers=[0,1].map(()=>createChatMessageNotificationPoller(workerDeps(async(_tokens,message,_signal,onAccepted)=>{
  sentIds.push(message.data.notificationId);if(sentIds.length===2)bothSending();await sendGate;onAccepted(1);return acceptedResult;
 },[],true)));
 const runs=workers.map(worker=>worker.runOnce());
 let barrierTimeout;
 try{
  await Promise.race([bothReady,new Promise((_,reject)=>{barrierTimeout=setTimeout(()=>reject(Error('Concurrent worker barrier timeout')),10000);})]);
  assert.deepEqual([...sentIds].sort(),[...concurrentIds].sort());assert.equal(new Set(sentIds).size,2);
 }finally{clearTimeout(barrierTimeout);releaseWorkers();await Promise.all(runs);await Promise.all(workers.map(worker=>worker.stop()));}
 assert.equal(value(`SELECT count(*) FROM public.chat_message_notifications WHERE id IN(${concurrentIds.map(lit).join(',')}) AND status='sent' AND attempts=1`),'2');
 report.tests.push({name:'two real workers individually claim distinct notifications and complete once',passed:true});

 const retry=fixture();retry.send();const retryId=notification(retry);let sendAttempts=0;const retryTrace=[];
 const retryWorker=createChatMessageNotificationPoller(workerDeps(async()=>++sendAttempts===1
  ?{sent:0,error:new Error('Synthetic temporary failure'),failures:{temporary:1,permanent:0,unknown:0}}:acceptedResult,retryTrace));
 try{
  await retryWorker.runOnce();assert.equal(sendAttempts,1);assert.equal(retryTrace.filter(x=>x==='claim').length,2);
  assert.equal(value(`SELECT status||':'||attempts FROM public.chat_message_notifications WHERE id=${lit(retryId)}`),'failed:1');
  assert.equal(value(`SELECT next_attempt_at>clock_timestamp() FROM public.chat_message_notifications WHERE id=${lit(retryId)}`),'t');
  await retryWorker.runOnce();assert.equal(sendAttempts,1);
  sql(`UPDATE public.chat_message_notifications SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=${lit(retryId)}`);
  await retryWorker.runOnce();assert.equal(sendAttempts,2);
  assert.equal(value(`SELECT status||':'||attempts FROM public.chat_message_notifications WHERE id=${lit(retryId)}`),'sent:2');
 }finally{await retryWorker.stop();}
 report.tests.push({name:'real worker respects DB backoff, avoids immediate retry and later completes successfully',passed:true});
 report.completed=true;
}finally{
 if(started&&fs.existsSync(path.join(data,'postmaster.pid')))ctl(['stop','-D',data,'-m','fast','-w','-t','15']);
 report.serverStopped=!fs.existsSync(path.join(data,'postmaster.pid'));
 fs.writeFileSync(path.join(run,'results.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({reportDirectory:run,...report,tests:report.tests.length}));
}
