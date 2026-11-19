import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
export const root=path.dirname(fileURLToPath(import.meta.url));
export const repo=path.resolve(root,'../..');
export const baseCommit='aff689da63c04e3a48e5b8f541d9a1573ad1b382';
export const sharedRef='wkghgmjennvlcrnuthtd';
export function assertNode(v=process.versions.node){assert.ok(/^\d+\.\d+\.\d+/.test(v)&&Number(v.split('.')[0])>=22,'Node >=22 required');}
export function validateTarget(t){
 try{assertNode();assert.equal(t.approved_for_testing,true,'Explicit temporary-project approval required');
 assert.ok(Number.isInteger(t.postgres_major)&&t.postgres_major>=17&&t.postgres_major<=18,'Explicit reviewed Postgres major required');
 assert.match(t.run,/^[a-z0-9][a-z0-9-]{3,39}$/);assert.ok(['a','b'].includes(t.label));
 assert.match(t.ref,/^[a-z]{20}$/);assert.notEqual(t.ref,sharedRef,'Shared project forbidden');
 assert.equal(t.api_url,'https://'+t.ref+'.supabase.co','Exact HTTPS project origin required');
 assert.match(t.nonce,/^[a-f0-9]{64}$/,'Use a random 32-byte hexadecimal nonce');
 assert.equal(t.email_sending_disabled,true,'Confirm email and security notification suppression first');
 assert.ok(Number.isInteger(t.backend_port)&&t.backend_port>=1024&&t.backend_port<65536);
 const c=t.database;assert.ok(c&&typeof c.password==='string'&&c.password.length>=8);
 assert.equal(c.port,5432,'Direct or session pooler only');assert.equal(c.database,'postgres');
 if(c.host==='db.'+t.ref+'.supabase.co')assert.equal(c.user,'postgres');
 else{assert.match(c.host,/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/);assert.equal(c.user,'postgres.'+t.ref,'Session pooler username must identify project');}
 for(const k of ['anon_key','service_role_key']){assert.ok(typeof t[k]==='string'&&t[k].length>=20);if(t[k].split('.').length===3){const p=JSON.parse(Buffer.from(t[k].split('.')[1],'base64url'));assert.equal(p.ref,t.ref);assert.equal(p.role,k==='anon_key'?'anon':'service_role');}}
 return t;
 }catch{throw Error('Invalid or unapproved temporary project configuration');}
}
export function fromEnvironment(env=process.env){
 assert.ok(env.ISSUE35_TARGET_FILE,'ISSUE35_TARGET_FILE required; no legacy/local fallback');
 const file=path.resolve(env.ISSUE35_TARGET_FILE),cloud=path.join(root,'.runtime','cloud');
 const rel=path.relative(cloud,file);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'Target must be in private cloud runtime');
 let parsed;try{parsed=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('Cannot read private target JSON');}const t=validateTarget(parsed);Object.freeze(t.database);
 const runDir=path.join(cloud,t.run);assert.equal(file,path.join(runDir,t.label+'.target.json'),'Target filename/run mismatch');
 const runtime=path.join(runDir,t.label);
 return Object.freeze({name:t.run,labels:Object.freeze([t.label]),label:t.label,target:Object.freeze(t),targetFile:file,runDir,runtime,reportDir:path.join(root,'reports','cloud',t.run,t.label),backendPort:t.backend_port,project:label=>{assert.equal(label,t.label,'Inactive target forbidden');return t.ref;}});
}
export function pgConfiguration(t,ca){validateTarget(t);assert.ok(ca&&ca.includes('BEGIN CERTIFICATE'),'Reviewed database CA required');return{host:t.database.host,port:5432,user:t.database.user,database:'postgres',password:t.database.password,ssl:{rejectUnauthorized:true,ca},connectionTimeoutMillis:10000};}
export async function verifyDatabase(c,t){const r=(await c.query("select current_user role,current_database() db,current_setting('server_version_num') version")).rows[0];assert.equal(r.role,'postgres');assert.equal(r.db,'postgres');assert.equal(Math.floor(Number(r.version)/10000),t.postgres_major,'Postgres major differs from reviewed baseline');const rows=(await c.query('select project_ref,nonce from issue35_verification.target_identity')).rows;assert.equal(rows.length,1);assert.equal(rows[0].project_ref,t.ref);assert.ok(rows[0].nonce===t.nonce,'Database identity mismatch');}
export async function verifyApi(t,request=fetch){const r=await request(t.api_url+'/auth/v1/settings',{headers:{apikey:t.anon_key},redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);assert.equal(r.headers.get('sb-project-ref'),t.ref);const v=await r.json();assert.equal(v.mailer_autoconfirm,true,'Email confirmation must be disabled');}
