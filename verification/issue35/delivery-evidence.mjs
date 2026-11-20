import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export async function liveExclusion({positive,negative,received,wait,settle}){
 const control=await positive();await wait(()=>received(control));
 const denied=await negative();await settle();assert.equal(received(denied),false,'Unauthorized Realtime delivery');
}
export function currentPushEvidence(buffer,offset,token){
 assert.ok(Number.isSafeInteger(offset)&&offset>=0&&offset<=buffer.length,'Invalid Push evidence offset');
 const records=buffer.subarray(offset).toString('utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
 const hash=createHash('sha256').update(token).digest('hex');
 assert.ok(records.some(r=>r.mode==='ok'&&Array.isArray(r.recipient_sha256)&&r.recipient_sha256.includes(hash)),'Current worker did not Push to expected recipient');
 return records;
}
