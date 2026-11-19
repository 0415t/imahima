import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const digest=s=>createHash('sha256').update(JSON.stringify(s)).digest('hex');
export class FreshnessRefusal extends Error{constructor(message){super(message);this.name='FreshnessRefusal';this.code='ISSUE35_NOT_FRESH';}}
export function requiredCheck(passed,name){assert.equal(passed,true,'Required check failed: '+name);}
export function comparisonGate(a,b,record){assert.deepEqual(a,b,'Current A/B catalogs differ; refusing mutation');assert.deepEqual(record.differences,[],'Recorded comparison failed');if(record.current_a_sha256){assert.equal(digest(a),record.current_a_sha256,'Comparison changed');assert.equal(digest(b),record.current_b_sha256,'Comparison changed');}return{differences:[],current_a_sha256:digest(a),current_b_sha256:digest(b)};}
export async function verifyFailureGate({clients,snapshot,record}){const a=await snapshot(clients[0]),b=await snapshot(clients[1]);comparisonGate(a,b,record);return[a,b];}
export async function enterFailureSuite({connect,snapshot,record}){const clients=[];try{clients.push(await connect('a'));clients.push(await connect('b'));const catalogs=await verifyFailureGate({clients,snapshot,record});return{clients,catalogs};}catch(error){await closeAll(clients,error);throw error;}}
export async function closeAll(clients,primary){const errors=[];for(const c of clients)if(c)try{await c.end();}catch(e){errors.push(e);}if(primary){primary.cleanupErrors=[...(primary.cleanupErrors||[]),...errors];return;}if(errors.length)throw new AggregateError(errors,'Client cleanup failed');}
export async function connectAndValidate({createClient,config,validate}){const c=createClient(config);try{await c.connect();await validate(c);return c;}catch(error){await closeAll([c],error);throw error;}}
export function exactIds(actual,expected){assert.ok(expected.length>1,'Fixture needs multiple expected IDs');assert.deepEqual(actual.map(String),expected.map(String),'Pagination omitted or substituted IDs');assert.equal(new Set(actual.map(String)).size,actual.length,'Duplicate page IDs');}
export function assertProfileStates(rows,ids,now){assert.equal(rows.length,3,'Missing ON-state fixture');assert.deepEqual(new Set(rows.map(r=>r.id)),new Set(ids));for(const r of rows)assert.equal(r.is_free,true);assert.equal(rows.find(r=>r.id===ids[0]).free_until,null);const active=rows.find(r=>r.id===ids[1]).free_until,expired=rows.find(r=>r.id===ids[2]).free_until;assert.notEqual(active,null);assert.notEqual(expired,null);assert.ok(new Date(active)>now);assert.ok(new Date(expired)<now);}
export async function roleQuery(c,sql,args=[]){await c.query('SET LOCAL ROLE service_role');const result=await c.query(sql,args);await c.query('RESET ROLE');return result.rows;}
export function invariant(id,condition){assert.ok(condition,id);}
export function expectedMutation(error,id,{table,constraint}={}){assert.ok(error,'Mutant was not detected: '+id);const specific=error.code==='ERR_ASSERTION'&&error.message===id;const duplicate=table&&error.code==='23505'&&error.table===table&&error.constraint===constraint;assert.ok(specific||duplicate,'Unrelated failure cannot kill mutant '+id);}
export function assertTimerDeadline(deadline,release,completion,tolerance=150){const d=Date.parse(deadline);assert.ok(d>=release+1800000-tolerance&&d<=completion+1800000+tolerance,'TIMER_POST_LOCK_DEADLINE');}

export async function cleanupResources(actions){const errors=[];for(const action of actions)try{await action();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Resource cleanup failed');}

export function verifySavedCatalog(record,current,ref){assert.equal(record.ref,ref,'Snapshot project mismatch');assert.equal(record.digest,digest(record.catalog),'Saved snapshot modified');assert.deepEqual(current,record.catalog,'Current catalog drift; refusing mutation');}

export function verifySuccessfulReport(record,run,ref){assert.equal(record.run,run);assert.equal(record.project_ref,ref);assert.equal(record.failed,0,'Required report contains failures');assert.ok(record.passed>0,'Empty report is not success');assert.ok(record.checks.every(c=>['pass','not-run'].includes(c.status)),'Incomplete report');}
