// Analyze recorded evidence; no database access or changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runtime } from './schema-tools.mjs';
const names=fs.readdirSync(runtime).filter(n=>n.startsWith('realtime-investigation-')).sort();
const runs=names.filter(n=>fs.existsSync(path.join(runtime,n,'results.json'))).map(n=>({directory:n,data:JSON.parse(fs.readFileSync(path.join(runtime,n,'results.json'),'utf8'))}));
const summary={runs:[],incomplete_runs:names.filter(n=>!fs.existsSync(path.join(runtime,n,'results.json'))),notes:[
 'Receipt comparisons require joined/connected target channels with no post-SUBSCRIBED error, plus a positive recipient for each same event.',
 'A missing receiver is not itself a reason to invalidate the comparison. Raw original outcomes are retained alongside evidence-derived classification.',
 'Setup errors before a later successful SUBSCRIBED are counted separately; failed joins and post-join errors are not normal non-receipt.',
 'WAL commit timestamps have millisecond representation; DB INSERT times have microseconds. track_commit_timestamp remained off.'
]};
for(const run of runs){
 const r=run.data;const groups=new Map();const normalized=[];
 for(const t of r.trials){
  const created=t.created?.deliveries??[],deleted=t.deleted?.deliveries??[];
  const clean=created.length===4&&deleted.length===4&&[...created,...deleted].every(d=>d.state==='joined'&&d.connected&&d.errors.length===0);
  const positive=created.some(d=>d.received)&&deleted.some(d=>d.received);
  const valid=clean&&positive&&!t.failure;
  const classification=valid?([...created,...deleted].every(d=>d.received)?'ALL_RECEIVED':'EVENT_MISSING'):'SUBSCRIPTION_ERROR_OR_NO_POSITIVE_CONTROL';
  const key=`${t.lifecycle}|delay=${t.delay_ms}|wait=${t.wait_option}`;
  if(!groups.has(key))groups.set(key,{condition:key,attempts:0,valid:0,all_received:0,event_missing:0,invalid:0,created:{filtered_received:0,filtered_missing:0,unfiltered_received:0,unfiltered_missing:0},deleted:{filtered_received:0,filtered_missing:0,unfiltered_received:0,unfiltered_missing:0},recovery_pass:0,setup_error_records:0});
  const group=groups.get(key);group.attempts++;if(valid){group.valid++;group[classification==='ALL_RECEIVED'?'all_received':'event_missing']++;}else group.invalid++;
  for(const [type,list] of [['created',created],['deleted',deleted]])if(valid)for(const d of list)group[type][`${d.filtered?'filtered':'unfiltered'}_${d.received?'received':'missing'}`]++;
  group.setup_error_records+=(t.targets??[]).flatMap(label=>r.channels.find(c=>c.label===label)?.states.filter(s=>s.error_present&&s.at<(r.channels.find(c=>c.label===label)?.subscribed_at??''))??[]).length;
  if(t.recovery?.status==='PASS')group.recovery_pass++;
  const timing=[];
  for(const label of t.targets??[]){const c=r.channels.find(c=>c.label===label);if(!c)continue;const base=label.replace(/-(filter|all)$/,'');const auth=r.auth.find(a=>a.label===base&&a.event==='EXPLICIT_JWT_SETTING_COMPLETE');
    if(auth)assert.ok(auth.at<=c.subscribe_called_at);
    if(t.created)assert.ok(c.subscribed_at<=t.created.send_started_at);
    timing.push({label,user:c.user,filtered:c.filtered,jwt_setting_complete_at:auth?.at,subscribe_called_at:c.subscribe_called_at,subscribed_at:c.subscribed_at,postgres_ready_at:c.system.find(s=>s.status==='ok'&&s.extension==='postgres_changes')?.at,first_event_received:r.receipts.find(e=>e.label===label&&e.room_id===(t.room_id??r.room)&&e.event_seq===t.created?.event_seq)?.received_at});}
  const missingTiming=[];
  if(valid)for(const[type,observation]of[['created',t.created],['deleted',t.deleted]])for(const delivery of observation.deliveries.filter(d=>!d.received)){
    const c=r.channels.find(c=>c.label===delivery.label),ready=c.system.find(s=>s.status==='ok'&&s.extension==='postgres_changes')?.at;
    const commit=observation.wal_commit_timestamps[0];
    missingTiming.push({label:delivery.label,event_type:type,event_seq:observation.event_seq,commit_timestamp:commit,postgres_ready_at:ready,ready_after_commit_ms:ready&&commit?Date.parse(ready)-Date.parse(commit):null});
  }
  normalized.push({round:t.round,condition:key,raw_outcome:t.outcome,classification,room_id:t.room_id??r.room,message_id:t.created?.message_id,event_seq:t.created?.event_seq,insert_at:t.created?.insert_at_utc,commit_timestamps:t.created?.wal_commit_timestamps,commit_upper_bound:t.created?.visible_after_ack_db_time,http_ack_at:t.created?.http_ack_at,timing,missing_delivery_timing:missingTiming,registration_rows:t.registrations_after,recovery:t.recovery});
 }
 summary.runs.push({run:r.run,directory:run.directory,mode:r.mode??'existing-room',versions:r.versions,raw_summary:r.summary,groups:[...groups.values()],normalized_trials:normalized,sync:r.sync.map(s=>({round:s.round,baseline:s.baseline,result:s.result})),preservation:r.preservation,received_records:r.receipts.length,subscription_error_records:r.channels.flatMap(c=>c.states).filter(s=>s.error_present).length});
}
const reports = path.join(runtime, 'reports'); fs.mkdirSync(reports, { recursive: true });
fs.writeFileSync(path.join(reports,`realtime-investigation-analysis-${Date.now()}.json`),JSON.stringify(summary,null,2), { flag: 'wx' });
console.log(JSON.stringify({runs:summary.runs.map(r=>({run:r.run,mode:r.mode,groups:r.groups,sync:r.sync.map(s=>({round:s.round,status:s.result.status,concurrent_side:s.baseline?.concurrent_side}))})),incomplete_runs:summary.incomplete_runs},null,2));
