// Diagnostic harness only. Does not change SDK/app code, schema, grants or publications.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { connectVerified, root, runtime } from './schema-tools.mjs';
const require = createRequire(new URL('../../server/index.ts', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const run = `${Date.now()}-${randomUUID().slice(0,8)}`;
const directory = path.join(runtime, `realtime-investigation-${run}`); fs.mkdirSync(directory);
const prior = JSON.parse(fs.readFileSync(path.join(runtime,'latest-integration.json'),'utf8'));
const previous = JSON.parse(fs.readFileSync(path.join(root,prior.directory,'results.json'),'utf8'));
let room = previous.database_events.find(e=>e.event_seq==='1'&&e.room_id===previous.data.rooms[0])?.room_id;
assert.ok(process.argv.slice(2).every(a=>['--fresh-filters','--cold-service'].includes(a)));
const freshFilters=process.argv.includes('--fresh-filters');
const coldService=process.argv.includes('--cold-service');assert.ok(!(freshFilters&&coldService));
const report = {run,started_at:new Date().toISOString(),room,mode:coldService?'cold-realtime-service':freshFilters?'fresh-room-filters':'existing-room',new_rooms:[],users:previous.data.users,versions:{node:process.version,sdk:require('@supabase/supabase-js/package.json').version},trials:[],sync:[],auth:[],wire:[],channels:[],receipts:[],rpc:[],http:[],waits:[]};
const save=()=>fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify(report,null,2));
let phase='preflight';
const progress=value=>{phase=value;fs.writeFileSync(path.join(directory,'progress.json'),JSON.stringify({phase,at:new Date().toISOString()}));};
process.on('exit',code=>fs.writeFileSync(path.join(directory,'process-exit.json'),JSON.stringify({code,phase})));
const now=()=>new Date().toISOString();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=v=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
const docker=args=>JSON.parse(execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
function environmentSnapshot(){
  const ids=execFileSync('docker',['ps','-aq'],{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean);
  const cs=docker(['inspect',...ids]);
  const vs=execFileSync('docker',['volume','ls','-q'],{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean);
  const snapshot={containers:cs.map(c=>({id:c.Id,name:c.Name,config:digest(c.Config),host:digest(c.HostConfig),mounts:digest([...c.Mounts].sort((a,b)=>a.Destination.localeCompare(b.Destination))),networks:Object.keys(c.NetworkSettings.Networks).sort()})).sort((a,b)=>a.id.localeCompare(b.id)),volumes:docker(['volume','inspect',...vs]).sort((a,b)=>a.Name.localeCompare(b.Name)),files:{}};
  for(const name of ['../../.env','../../server/.env','../../supabase/.temp/project-ref','../../supabase/.temp/linked-project.json','../../supabase/migrations/20261111000000_group_management_mvp.sql','../../supabase/migrations/20261113000000_group_chat_mvp.sql'])snapshot.files[name]=digest(fs.readFileSync(path.resolve(root,name)).toString('utf8'));
  return snapshot;
}
let db,child,status,baselineSchema,baselineEnv;
const sessions={},allClients=new Set(),entries=[],created=new Set();
const safeFailure=e=>({code:e.code??'DIAGNOSTIC_FAILURE',...(typeof e.actual==='number'?{actual:e.actual}:{}),...(typeof e.expected==='number'?{expected:e.expected}:{})});
function target(input){const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);assert.ok(['http://127.0.0.1:56321','http://127.0.0.1:56331'].includes(url.origin));return url;}
async function api(user,suffix,method='GET',body){
  const url=target('http://127.0.0.1:56331/groups/'+room+suffix);const start=now();
  const response=await fetch(url,{method,headers:{Authorization:'Bearer '+sessions[user].access_token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'});
  const data=await response.json();report.http.push({path:url.pathname,method,user,started_at:start,ack_at:now(),status:response.status});return{status:response.status,data};
}
async function quota(user){
  const {rows:[r]}=await db.query("select count(*)::int as n, greatest(0,ceil(extract(epoch from min(created_at)+interval '60 seconds'-clock_timestamp())*1000))::int as wait_ms from public.messages where sender_id=$1 and created_at>clock_timestamp()-interval '60 seconds'",[report.users[user]]);
  if(r.n>=10){const wait=r.wait_ms+100;report.waits.push({user,wait_ms:wait,at:now()});console.log('WAIT: unchanged real send quota ('+Math.ceil(wait/1000)+' seconds)');await sleep(wait);return quota(user);}
}
async function send(user,label){
  await quota(user);const started=now();const response=await api(user,'/messages','POST',{body:'Realtime diagnostic text',client_message_id:randomUUID()});assert.equal(response.status,201);
  const ack=now();created.add(response.data.message.id);
  const {rows:[event]}=await db.query("select event_seq::text,message_id::text,event_type,to_char(created_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as insert_at_utc,xmin::text as xid,to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as visible_after_ack_db_time from public.room_message_events where room_id=$1 and message_id=$2 and event_type='created'",[room,response.data.message.id]);
  return{label,user,room_id:room,message_id:response.data.message.id,event_type:'created',event_seq:event.event_seq,send_started_at:started,http_ack_at:ack,...event};
}
async function remove(user,id,label){
  assert.ok(created.has(id),'Only delete messages created by this diagnostic');const start=now();const r=await api(user,'/messages/'+id,'DELETE');assert.equal(r.status,200);
  const ack=now();const {rows:[event]}=await db.query("select event_seq::text,message_id::text,event_type,to_char(created_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as insert_at_utc,xmin::text as xid,to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as visible_after_ack_db_time from public.room_message_events where room_id=$1 and message_id=$2 and event_type='deleted'",[room,id]);
  return{label,user,room_id:room,message_id:id,send_started_at:start,http_ack_at:ack,...event};
}
function decodeFrame(data){try{const j=JSON.parse(typeof data==='string'?data:Buffer.from(data).toString());return Array.isArray(j)?{join_ref:j[0],ref:j[1],topic:j[2],event:j[3],payload:j[4]}:j;}catch{return null;}}
class TraceSocket extends WebSocket{
  constructor(url,protocols){assert.equal(new URL(url).origin,'ws://127.0.0.1:56321');super(url,protocols);this.addEventListener('message',e=>{const f=decodeFrame(e.data);if(!f)return;const record={direction:'in',at:now(),topic:f.topic,event:f.event,ref:f.ref};if(f.event==='phx_reply'){record.reply_status=f.payload?.status;record.postgres_binding_ids=f.payload?.response?.postgres_changes?.map(p=>p.id)??null;}if(f.event==='system'){record.status=f.payload?.status;record.extension=f.payload?.extension;}if(['phx_reply','system'].includes(f.event))report.wire.push(record);});}
  send(data){const f=decodeFrame(data);if(f&&['phx_join','access_token'].includes(f.event))report.wire.push({direction:'out',at:now(),topic:f.topic,event:f.event,ref:f.ref,postgres_changes:f.event==='phx_join'?f.payload?.config?.postgres_changes:undefined,wait_options:f.event==='phx_join'?f.payload?.config?.postgres_changes_options:undefined});return super.send(data);}
}
async function makeClient(user,label){
  const client=createClient(status.API_URL,status.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(input,init)=>{assert.equal(target(input).origin,'http://127.0.0.1:56321');return fetch(input,{...init,redirect:'error'});}},realtime:{transport:TraceSocket,logger:()=>{}}});allClients.add(client);
  client.auth.onAuthStateChange(event=>report.auth.push({user,label,event,at:now()}));
  const start=now();assert.equal((await client.auth.setSession(sessions[user])).error,null);await client.realtime.setAuth(sessions[user].access_token);
  report.auth.push({user,label,event:'EXPLICIT_JWT_SETTING_COMPLETE',started_at:start,at:now()});return client;
}
async function subscribe(client,user,label,filtered,wait=false){
  const info={user,label,filtered,wait,topic:`rt-diagnostic-${run}-${label}`,jwt_set_before_subscribe:true,subscribe_called_at:now(),states:[],system:[]};report.channels.push(info);
  const channel=client.channel(info.topic,wait?{config:{postgres_changes_options:{wait:true,timeout:15000}}}:undefined)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'room_message_events',...(filtered?{filter:'room_id=eq.'+room}:{})},p=>{report.receipts.push({label,user,filtered,room_id:p.new.room_id,event_seq:String(p.new.event_seq),message_id:p.new.message_id,event_type:p.new.event_type,insert_at_utc:p.new.created_at,commit_timestamp:p.commit_timestamp??null,received_at:now(),columns:Object.keys(p.new).sort()});})
    .on('system',{},p=>info.system.push({at:now(),status:p.status,extension:p.extension}));
  const entry={info,channel,client,active:true};entries.push(entry);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Object.assign(new Error(),{code:'SUBSCRIBE_TIMEOUT'})),22000);channel.subscribe((state,error)=>{info.states.push({state,at:now(),error_present:!!error});if(state==='SUBSCRIBED'){info.subscribed_at??=now();info.postgres_binding_ids=channel.bindings?.postgres_changes?.map(b=>b.id)??null;clearTimeout(timer);resolve();}else if(['CHANNEL_ERROR','TIMED_OUT'].includes(state)&&!coldService){clearTimeout(timer);reject(Object.assign(new Error(),{code:state}));}});});return entry;
}
async function pair(user,label,wait=false){const c=await makeClient(user,label);try{const f=await subscribe(c,user,label+'-filter',true,wait),a=await subscribe(c,user,label+'-all',false,wait);return{client:c,entries:[f,a]};}catch(error){for(const e of entries)if(e.client===c)e.active=false;await c.removeAllChannels();await c.realtime.disconnect();throw error;}}
async function retire(pair){for(const e of pair.entries)e.active=false;await pair.client.removeAllChannels();await pair.client.realtime.disconnect();}
async function registrationSnapshot(){const{rows}=await db.query("select subscription_id::text,to_char(created_at,'YYYY-MM-DD\"T\"HH24:MI:SS.US') as registered_at_utc_without_zone,claims->>'sub' as user_id,filters::text from realtime.subscription where entity='public.room_message_events'::regclass order by created_at,subscription_id");return rows;}
function got(entry,event){return report.receipts.some(r=>r.label===entry.info.label&&r.room_id===room&&r.event_seq===event.event_seq);}
async function observations(event,targets,controls){
  const end=Date.now()+5000;while(Date.now()<end){if(controls.every(e=>got(e,event)))break;await sleep(50);}
  const controlOk=controls.every(e=>got(e,event));
  await sleep(1800);
  return{...event,control_ok:controlOk,deliveries:targets.map(e=>({label:e.info.label,user:e.info.user,filtered:e.info.filtered,received:got(e,event),state:e.channel.state,connected:e.client.realtime.isConnected(),setup_errors:e.info.states.filter(s=>s.at<e.info.subscribed_at&&(s.error_present||['CHANNEL_ERROR','TIMED_OUT'].includes(s.state))),errors:e.info.states.filter(s=>s.at>=e.info.subscribed_at&&(s.error_present||['CHANNEL_ERROR','TIMED_OUT'].includes(s.state)))})),wal_commit_timestamps:[...new Set(report.receipts.filter(r=>r.event_seq===event.event_seq&&r.room_id===room).map(r=>r.commit_timestamp).filter(Boolean))],observation_end_at:now()};
}
async function schemaSignature(){const results=await db.query(fs.readFileSync(path.join(root,'sql/application_postflight.sql'),'utf8'));const r=results.find(r=>r.rows?.[0]?.report).rows[0].report;delete r.rows;return digest(r);}
async function initialSync(round,controls){
  const row={round,started_at:now(),events:[]};report.sync.push(row);let observer;
  try{
    observer=await pair('B',`sync-${round}`);const first=await send('A','before-baseline');row.events.push(first);
    const historyStarted=now();const hp=api('B','/messages?limit=100');const duringPromise=send('B','concurrent-baseline');
    const history=await hp;assert.equal(history.status,200);const historyAck=now();const during=await duringPromise;row.events.push(during);
    const high=history.data.sync_event_seq;row.baseline={started_at:historyStarted,ack_at:historyAck,event_seq:high,concurrent_side:BigInt(during.event_seq)<=BigInt(high)?'included-before-baseline':'after-baseline'};
    assert.ok(BigInt(first.event_seq)<=BigInt(high));
    // Compare missing initial events with later RT/REST overlap; this is a test
    // schedule, not an application workaround or a claim that sleep is a fix.
    await sleep(1500);const after=await send('A','after-baseline');row.events.push(after);assert.ok(BigInt(after.event_seq)>BigInt(high));
    const deleted=await remove('A',first.message_id,'delete-after-baseline');row.events.push(deleted);
    const control=await observations(deleted,observer.entries,controls);assert.ok(control.control_ok);
    let cursor,delta=[],states=[],pages=0;
    do{const r=await api('B','/message-events?limit=2'+(cursor?'&cursor='+cursor:'&after_event_seq='+high));assert.equal(r.status,200);delta.push(...r.data.events);states.push(...r.data.messages);cursor=r.data.next_cursor;pages++;}while(cursor&&pages<100);
    assert.equal(cursor,null);const buffer=report.receipts.filter(r=>observer.entries.some(e=>e.info.label===r.label));
    const restIds=new Set(delta.map(e=>room+':'+e.event_seq));const realtimeIds=new Set(buffer.map(e=>room+':'+e.event_seq));const union=new Set([...restIds,...realtimeIds]);
    const local=new Map(history.data.messages.map(m=>[m.id,m]));const apply=msgs=>{for(const m of msgs){const old=local.get(m.id);if(!old||BigInt(m.last_event_seq)>=BigInt(old.last_event_seq))local.set(m.id,m);}};
    apply(states);apply(states);apply(history.data.messages); // Replay duplicates and a stale history response.
    const{rows:stored}=await db.query('select id::text,room_seq::text,last_event_seq::text,body,deleted_at is not null as deleted from public.messages where room_id=$1 order by room_seq',[room]);
    assert.equal(local.size,stored.length);for(const m of stored){const value=local.get(m.id);assert.ok(value);assert.equal(value.body,m.body);assert.equal(value.room_seq,m.room_seq);assert.equal(value.last_event_seq,m.last_event_seq);assert.equal(!!value.deleted_at,m.deleted);}
    assert.equal(local.get(first.message_id).body,null);
    const overlap=[...restIds].filter(id=>realtimeIds.has(id)).length;assert.ok(overlap>0);
    row.result={status:'PASS',history_rows:history.data.messages.length,delta_pages:pages,rest_event_ids:[...restIds],realtime_event_ids:[...realtimeIds],overlap_count:overlap,deduplicated_event_count:union.size,db_messages:stored.length,tombstone_preserved:true,initial_events_missed_by_filtered:row.events.filter(e=>!got(observer.entries[0],e)).map(e=>e.event_seq),commit_note:'WAL commit timestamps from positive-control receipts; HTTP ACK/DB visibility bounds retained for all events'};
  }catch(e){row.result={status:'FAIL',failure:safeFailure(e)};}finally{if(observer)await retire(observer);row.finished_at=now();save();console.log(`SYNC ${round}: ${row.result?.status}`);}
}
try{
  const verified=await connectVerified();db=verified.client;report.identity=verified.identity;status=JSON.parse(fs.readFileSync(path.join(runtime,'local-status.credentials.json'),'utf8'));
  progress('preservation-baseline');
  baselineEnv=environmentSnapshot();fs.writeFileSync(path.join(directory,'environment-before.json'),JSON.stringify(baselineEnv,null,2));baselineSchema=await schemaSignature();
  progress('existing-membership-check');
  const{rows:membership}=await db.query('select user_id::text from public.room_members where room_id=$1 order by user_id',[room]);assert.deepEqual(membership.map(r=>r.user_id).sort(),[report.users.A,report.users.B].sort());
  const{rows:[settings]}=await db.query("select current_setting('track_commit_timestamp') as track_commit_timestamp,current_setting('TimeZone') as timezone,(select data_type from information_schema.columns where table_schema='public' and table_name='room_message_events' and column_name='room_id') as room_id_type");report.settings=settings;
  const admin=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>{assert.equal(target(input).origin,'http://127.0.0.1:56321');return fetch(input,{...init,redirect:'error'});}}});
  for(const user of ['A','B']){
    progress('local-session-'+user);
    const{rows:[account]}=await db.query('select email from auth.users where id=$1',[report.users[user]]);const link=await admin.auth.admin.generateLink({type:'magiclink',email:account.email});assert.equal(link.error,null);
    const anon=createClient(status.API_URL,status.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>{assert.equal(target(input).origin,'http://127.0.0.1:56321');return fetch(input,{...init,redirect:'error'});}}});
    const login=await anon.auth.verifyOtp({token_hash:link.data.properties.hashed_token,type:'magiclink'});assert.equal(login.error,null);assert.equal(login.data.user.id,report.users[user]);sessions[user]={access_token:login.data.session.access_token,refresh_token:login.data.session.refresh_token};report.auth.push({user,event:'LOCAL_AUTH_SESSION_ISSUED',at:now()});
  }
  const env={...process.env};for(const k of Object.keys(env))if(/^(SUPABASE_|EXPO_PUBLIC_|PG[A-Z_]|DATABASE_URL$|DOTENV_|GROUP_RATE_SECRET$)/.test(k))delete env[k];Object.assign(env,{SUPABASE_URL:status.API_URL,SUPABASE_SERVICE_ROLE_KEY:status.SERVICE_ROLE_KEY,CHAT_LOCAL_PROJECT_ID:'imahima-chat-local',CHAT_INTEGRATION_RUN:run,GROUP_RATE_SECRET:randomBytes(32).toString('hex'),PORT:'56331'});
  progress('local-api-start');
  child=spawn(process.execPath,['--import',pathToFileURL(path.resolve(root,'../../node_modules/tsx/dist/loader.mjs')).href,path.join(root,'integration-api.ts')],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc']});child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Local API timeout')),20000);child.on('message',m=>{if(m.type==='rpc')report.rpc.push(m);if(m.type==='ready'&&m.run===run){clearTimeout(t);resolve();}if(m.type==='fatal'){clearTimeout(t);reject(new Error('Local API failed'));}});child.once('error',()=>reject(new Error('Local API unavailable')));});
  const controlsA=await pair('A','existing-A'),controlsB=await pair('B','existing-B');const controls=[...controlsA.entries,...controlsB.entries];
  progress('subscription-matrix');
  await sleep(2500);report.registrations_before_trials=await registrationSnapshot();
  let index=0;
  if(!freshFilters&&!coldService){
  for(let round=1;round<=3;round++)for(const lifecycle of ['new','existing'])for(const delay of [0,1500]){
    const trial={round,lifecycle,delay_ms:delay,wait_option:false,started_at:now()};report.trials.push(trial);let a,b;
    try{trial.registrations_before=await registrationSnapshot();if(lifecycle==='new'){a=await pair('A',`r${round}-${delay}-A`);b=await pair('B',`r${round}-${delay}-B`);}else{a=controlsA;b=controlsB;}
      trial.targets=[...a.entries,...b.entries].map(e=>e.info.label);trial.all_subscribed_at=now();await sleep(delay);
      const user=index++%2?'B':'A';const event=await send(user,'matrix-created');trial.created=await observations(event,[...a.entries,...b.entries],controls);
      const deletion=await remove(user,event.message_id,'matrix-deleted');trial.deleted=await observations(deletion,[...a.entries,...b.entries],controls);trial.registrations_after=await registrationSnapshot();
      trial.valid=trial.created.control_ok&&trial.deleted.control_ok&&[...trial.created.deliveries,...trial.deleted.deliveries].every(d=>d.state==='joined'&&d.connected&&d.errors.length===0);
      trial.outcome=trial.valid?([trial.created,trial.deleted].every(o=>o.deliveries.every(d=>d.received))?'ALL_RECEIVED':'EVENT_MISSING'):'INVALID_CONTROL_OR_CHANNEL';
    }catch(e){trial.outcome='ERROR';trial.failure=safeFailure(e);}finally{if(lifecycle==='new'){if(a)await retire(a);if(b)await retire(b);}save();console.log(`MATRIX ${round} ${lifecycle} delay=${delay}: ${trial.outcome}`);}
  }
  for(let round=1;round<=3;round++){
    const trial={round,lifecycle:'new',delay_ms:0,wait_option:true,started_at:now()};report.trials.push(trial);let a,b;
    try{a=await pair('A',`wait-${round}-A`,true);b=await pair('B',`wait-${round}-B`,true);trial.targets=[...a.entries,...b.entries].map(e=>e.info.label);trial.all_subscribed_at=now();const user=index++%2?'B':'A';const event=await send(user,'wait-option-created');trial.created=await observations(event,[...a.entries,...b.entries],controls);trial.deleted=await observations(await remove(user,event.message_id,'wait-option-deleted'),[...a.entries,...b.entries],controls);trial.valid=trial.created.control_ok&&trial.deleted.control_ok&&[...trial.created.deliveries,...trial.deleted.deliveries].every(d=>d.state==='joined'&&d.connected&&d.errors.length===0);trial.outcome=trial.valid?([trial.created,trial.deleted].every(o=>o.deliveries.every(d=>d.received))?'ALL_RECEIVED':'EVENT_MISSING'):'INVALID_CONTROL_OR_CHANNEL';}catch(e){trial.outcome='ERROR';trial.failure=safeFailure(e);}finally{if(a)await retire(a);if(b)await retire(b);save();console.log(`WAIT-OPTION ${round}: ${trial.outcome}`);}
  }
  for(let round=1;round<=3;round++)await initialSync(round,controls);
  }else if(freshFilters){
    const groupRequest=async(user,route,body)=>{
      const response=await fetch(target('http://127.0.0.1:56331'+route),{method:'POST',headers:{Authorization:'Bearer '+sessions[user].access_token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'});
      const data=await response.json();report.http.push({path:route,user,method:'POST',status:response.status,ack_at:now()});return{status:response.status,data};
    };
    const positiveControls=controls.filter(e=>!e.info.filtered);
    for(let round=1;round<=3;round++)for(const condition of [{delay:0,wait:false},{delay:1500,wait:false},{delay:0,wait:true}]){
      const trial={round,lifecycle:'new-room-new-subscription',delay_ms:condition.delay,wait_option:condition.wait,started_at:now()};report.trials.push(trial);let a,b;
      try{
        const creator=index++%2?'B':'A',other=creator==='A'?'B':'A';
        const made=await groupRequest(creator,'/groups',{name:`Realtime fresh-filter ${run} ${round} ${condition.delay} ${condition.wait}`});assert.equal(made.status,201);
        room=made.data.group.id;trial.room_id=room;report.new_rooms.push(room);save();
        assert.equal((await groupRequest(other,'/groups/join',{invite_code:made.data.invite_code})).status,201);
        trial.registrations_before=await registrationSnapshot();a=await pair('A',`fresh-${round}-${condition.wait}-${condition.delay}-A`,condition.wait);b=await pair('B',`fresh-${round}-${condition.wait}-${condition.delay}-B`,condition.wait);
        trial.targets=[...a.entries,...b.entries].map(e=>e.info.label);trial.all_subscribed_at=now();await sleep(condition.delay);
        const event=await send(creator,'fresh-room-created');trial.created=await observations(event,[...a.entries,...b.entries],positiveControls);
        trial.deleted=await observations(await remove(creator,event.message_id,'fresh-room-deleted'),[...a.entries,...b.entries],positiveControls);
        trial.registrations_after=await registrationSnapshot();
        trial.valid=trial.created.control_ok&&trial.deleted.control_ok&&[...trial.created.deliveries,...trial.deleted.deliveries].every(d=>d.state==='joined'&&d.connected&&d.errors.length===0);
        trial.outcome=trial.valid?([trial.created,trial.deleted].every(o=>o.deliveries.every(d=>d.received))?'ALL_RECEIVED':'EVENT_MISSING'):'INVALID_CONTROL_OR_CHANNEL';
        // Recover the very event(s) actually missed above, without changing subscription behavior.
        const history=await api('B','/messages?limit=100');assert.equal(history.status,200);const h=history.data.sync_event_seq;
        let cursor,pages=0,events=[],states=[];
        do{const r=await api('B','/message-events?limit=1'+(cursor?'&cursor='+cursor:'&after_event_seq=0'));assert.equal(r.status,200);events.push(...r.data.events);states.push(...r.data.messages);cursor=r.data.next_cursor;pages++;}while(cursor&&pages<10);
        assert.equal(cursor,null);assert.equal(pages,2);assert.deepEqual(events.map(e=>e.type),['created','deleted']);
        const unique=new Set(events.map(e=>room+':'+e.event_seq));const rt=report.receipts.filter(r=>r.room_id===room&&trial.targets.includes(r.label));
        const duplicateCount=rt.filter(r=>unique.has(room+':'+r.event_seq)).length;assert.ok(duplicateCount>0);
        const local=new Map(history.data.messages.map(m=>[m.id,m]));for(const m of [...states,...states,...history.data.messages]){const old=local.get(m.id);if(!old||BigInt(m.last_event_seq)>=BigInt(old.last_event_seq))local.set(m.id,m);}
        const{rows:[stored]}=await db.query('select body,deleted_at is not null as deleted,last_event_seq::text from public.messages where id=$1',[event.message_id]);
        assert.equal(local.size,1);assert.equal(local.get(event.message_id).body,stored.body);assert.equal(!!local.get(event.message_id).deleted_at,stored.deleted);assert.equal(local.get(event.message_id).last_event_seq,stored.last_event_seq);
        trial.recovery={status:'PASS',baseline:h,delta_pages:pages,deduplicated_event_count:unique.size,rt_rest_overlap_receipts:duplicateCount,db_state_matches:true,actual_missing_created_receivers:trial.created.deliveries.filter(d=>!d.received).map(d=>d.label)};
      }catch(e){trial.outcome='ERROR';trial.failure=safeFailure(e);}finally{if(a)await retire(a);if(b)await retire(b);save();console.log(`FRESH-FILTER ${round} delay=${condition.delay} wait=${condition.wait}: ${trial.outcome}`);}
    }
  }else{
    await retire(controlsA);await retire(controlsB);
    for(let round=1;round<=3;round++)for(const condition of [{delay:0,wait:false},{delay:1500,wait:false},{delay:0,wait:true}]){
      const trial={round,room_id:room,lifecycle:'realtime-service-restarted',delay_ms:condition.delay,wait_option:condition.wait,started_at:now()};report.trials.push(trial);let a,b;
      try{
        const name='supabase_realtime_imahima-chat-local';const[c]=docker(['inspect',name]);
        assert.equal(c.Name,'/'+name);assert.equal(c.Config.Labels['com.supabase.cli.project'],'imahima-chat-local');assert.equal(path.resolve(c.Config.Labels['com.supabase.cli.workdir']),root);assert.deepEqual(Object.keys(c.NetworkSettings.Networks),['imahima-chat-local-net']);
        trial.service_restart={container_id:c.Id,started_at:now()};execFileSync('docker',['restart',name],{stdio:['ignore','pipe','pipe']});
        let healthy=false;for(let n=0;n<60;n++){const[current]=docker(['inspect',name]);assert.equal(current.Id,c.Id);if(current.State.Health?.Status==='healthy'){healthy=true;break;}await sleep(500);}assert.ok(healthy);trial.service_restart.healthy_at=now();
        const{rows:[position]}=await db.query('select coalesce(max(event_seq),0)::text as sequence from public.room_message_events where room_id=$1',[room]);trial.start_event_seq=position.sequence;
        trial.registrations_before=await registrationSnapshot();a=await pair('A',`cold-${round}-${condition.wait}-${condition.delay}-A`,condition.wait);b=await pair('B',`cold-${round}-${condition.wait}-${condition.delay}-B`,condition.wait);
        trial.targets=[...a.entries,...b.entries].map(e=>e.info.label);trial.all_subscribed_at=now();await sleep(condition.delay);
        const user=index++%2?'B':'A';const event=await send(user,'cold-created');trial.created=await observations(event,[...a.entries,...b.entries],[]);
        trial.created.control_ok=trial.created.deliveries.some(d=>d.received);
        trial.deleted=await observations(await remove(user,event.message_id,'cold-deleted'),[...a.entries,...b.entries],[...a.entries,...b.entries]);
        trial.registrations_after=await registrationSnapshot();
        // A missing recipient must not invalidate a delivery test merely because
        // the original control list included that recipient. Use another live
        // recipient of each exact event as the positive control.
        trial.valid=trial.created.deliveries.some(d=>d.received)&&trial.deleted.deliveries.some(d=>d.received)&&[...trial.created.deliveries,...trial.deleted.deliveries].every(d=>d.state==='joined'&&d.connected&&d.errors.length===0);
        trial.late_positive_control=trial.deleted.deliveries.some(d=>d.received);
        trial.outcome=trial.valid?([trial.created,trial.deleted].every(o=>o.deliveries.every(d=>d.received))?'ALL_RECEIVED':'EVENT_MISSING'):'INVALID_CONTROL_OR_CHANNEL';
        const history=await api('B','/messages?limit=100');assert.equal(history.status,200);let cursor,pages=0,states=[],events=[];
        do{const r=await api('B','/message-events?limit=1'+(cursor?'&cursor='+cursor:'&after_event_seq='+position.sequence));assert.equal(r.status,200);states.push(...r.data.messages);events.push(...r.data.events);cursor=r.data.next_cursor;pages++;}while(cursor&&pages<10);
        assert.equal(cursor,null);assert.equal(pages,2);assert.deepEqual(events.map(e=>e.type),['created','deleted']);
        const local=new Map(history.data.messages.map(m=>[m.id,m]));for(const m of [...states,...states,...history.data.messages]){const old=local.get(m.id);if(!old||BigInt(m.last_event_seq)>=BigInt(old.last_event_seq))local.set(m.id,m);}
        const{rows:stored}=await db.query('select id::text,body,last_event_seq::text,deleted_at is not null as deleted from public.messages where room_id=$1',[room]);assert.equal(local.size,stored.length);
        for(const m of stored){assert.equal(local.get(m.id).body,m.body);assert.equal(local.get(m.id).last_event_seq,m.last_event_seq);assert.equal(!!local.get(m.id).deleted_at,m.deleted);}
        const rt=report.receipts.filter(r=>trial.targets.includes(r.label)&&r.room_id===room&&events.some(e=>e.event_seq===r.event_seq));const ids=new Set([...events.map(e=>room+':'+e.event_seq),...rt.map(e=>room+':'+e.event_seq)]);assert.equal(ids.size,2);
        trial.recovery={status:'PASS',delta_pages:pages,deduplicated_event_count:ids.size,db_state_matches:true,actual_missing_created_receivers:trial.created.deliveries.filter(d=>!d.received).map(d=>d.label)};
      }catch(e){trial.outcome='ERROR';trial.failure=safeFailure(e);}finally{if(a)await retire(a);if(b)await retire(b);save();console.log(`COLD ${round} delay=${condition.delay} wait=${condition.wait}: ${trial.outcome}`);}
    }
  }
  assert.equal(await schemaSignature(),baselineSchema,'Schema/permissions/publication changed');assert.deepEqual(environmentSnapshot(),baselineEnv,'Preexisting environment changed during this investigation');
  report.preservation={schema_rls_grants_publication_unchanged:true,containers_volumes_and_protected_files_unchanged_from_start:true,application_changes:false};
}catch(e){report.fatal=safeFailure(e);console.log('DIAGNOSTIC STOP: '+(e.code??'VALIDATION_FAILED'));}
finally{
  for(const c of allClients){try{await c.removeAllChannels();await c.realtime.disconnect();}catch{}}
  if(child&&child.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.send('stop');setTimeout(()=>{if(child.exitCode===null)child.kill();resolve();},5000).unref();});
  if(db)await db.end();report.finished_at=now();report.summary={trials:report.trials.length,all_received:report.trials.filter(t=>t.outcome==='ALL_RECEIVED').length,missing:report.trials.filter(t=>t.outcome==='EVENT_MISSING').length,invalid:report.trials.filter(t=>!['ALL_RECEIVED','EVENT_MISSING'].includes(t.outcome)).length,sync_pass:report.sync.filter(s=>s.result?.status==='PASS').length,sync_fail:report.sync.filter(s=>s.result?.status==='FAIL').length,fatal:!!report.fatal,new_messages:created.size};save();fs.writeFileSync(path.join(runtime,'latest-realtime-investigation.json'),JSON.stringify({run,directory:path.relative(root,directory),summary:report.summary},null,2));console.log(JSON.stringify({run,summary:report.summary}));if(report.fatal||report.summary.invalid||report.summary.sync_fail)process.exitCode=1;
}
