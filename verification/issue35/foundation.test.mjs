import { Buffer } from 'node:buffer';
import vm from 'node:vm';
import { verifySavedCatalog, digest, verifySuccessfulReport } from './verification-control.mjs';
import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{execFileSync}from'node:child_process';
import{validateTarget,pgConfiguration,verifyDatabase,verifyApi,root,sharedRef,assertNode}from'./configuration.mjs';
import{restrictedFetch,cliDatabase}from'./boundaries.mjs';
import{cloudCli}from'./cloud-cli.mjs';
const fixture=()=>({approved_for_testing:true,postgres_major:17,run:'offline-test',label:'a',ref:'abcdefghijklmnopqrst',api_url:'https://abcdefghijklmnopqrst.supabase.co',nonce:'a'.repeat(64),email_sending_disabled:true,backend_port:51331,anon_key:'sb_publishable_fixture_only_0000',service_role_key:'sb_secret_fixture_only_000000',database:{host:'db.abcdefghijklmnopqrst.supabase.co',port:5432,user:'postgres',database:'postgres',password:'fixture-only-password'}});
test('Node22 requirement remains',()=>{assertNode('22.0.0');assert.throws(()=>assertNode('20.1.0'));});
test('exact temporary target accepted',()=>{validateTarget(fixture());});
for(const [name,mutate]of [
 ['shared project',t=>{t.ref=sharedRef;t.api_url='https://'+sharedRef+'.supabase.co';t.database.host='db.'+sharedRef+'.supabase.co';}],
 ['unapproved',t=>t.approved_for_testing=false],['email setting',t=>t.email_sending_disabled=false],
 ['http',t=>t.api_url=t.api_url.replace('https:','http:')],['foreign origin',t=>t.api_url='https://other.supabase.co'],
 ['query',t=>t.api_url+='?host=evil'],['userinfo',t=>t.api_url=t.api_url.replace('https://','https://user@')],
 ['transaction pooler',t=>t.database.port=6543],['foreign DB',t=>t.database.host='db.other.supabase.co'],
 ['wrong role',t=>t.database.user='service_role'],['wrong database',t=>t.database.database='template1'],
 ['missing nonce',t=>t.nonce=''],['backend privileged port',t=>t.backend_port=10],['unknown label',t=>t.label='c'],
 ['run escape',t=>t.run='../other']])test('reject '+name,()=>{const t=fixture();mutate(t);assert.throws(()=>validateTarget(t));});
test('session pooler binds username to ref',()=>{const t=fixture();t.database.host='aws-0-ap-northeast-1.pooler.supabase.com';t.database.user='postgres.'+t.ref;validateTarget(t);t.database.user='postgres.'+sharedRef;assert.throws(()=>validateTarget(t));});
test('pg config cannot inherit URL overrides or disable TLS',()=>{const t=fixture();t.database.connectionString='postgresql://evil';t.database.ssl=false;const c=pgConfiguration(t,'-----BEGIN CERTIFICATE-----fixture');assert.equal(c.host,t.database.host);assert.equal(c.connectionString,undefined);assert.equal(c.ssl.rejectUnauthorized,true);assert.throws(()=>pgConfiguration(t,''));});
test('CLI password is absent from URL',()=>{const t=fixture(),s={dbConfig:pgConfiguration(t,'BEGIN CERTIFICATE')},c=cliDatabase(s);assert.ok(!c.url.includes(t.database.password));assert.ok(c.url.includes('verify-full'));});
test('identity read precedes any mutation; foreign/missing marker fails',async()=>{for(const mismatch of [false,true]){const t=fixture(),queries=[];const c={query:async q=>{queries.push(q);return{rows:q.includes('current_user')?[{role:'postgres',db:'postgres',version:'170000'}]:[{project_ref:t.ref,nonce:mismatch?'wrong':t.nonce}]};}};if(mismatch)await assert.rejects(verifyDatabase(c,t));else await verifyDatabase(c,t);assert.ok(queries.every(q=>q.startsWith('select ')));}});
test('API identity and autoconfirm required; redirects forbidden',async()=>{const t=fixture();for(const wrong of ['none','ref','mail']){const request=async(url,o)=>{assert.equal(o.redirect,'error');assert.equal(url,t.api_url+'/auth/v1/settings');return{status:200,headers:{get:()=>wrong==='ref'?sharedRef:t.ref},json:async()=>({mailer_autoconfirm:wrong!=='mail'})};};if(wrong==='none')await verifyApi(t,request);else await assert.rejects(verifyApi(t,request));}});
test('Push can only be mocked, never sent natively',async()=>{let native=0,mocked=0;const t=fixture(),guard=restrictedFetch(async(u,o)=>{native++;assert.equal(o.redirect,'error');},t.api_url,async()=>{mocked++;return'ok';});assert.equal(await guard('https://exp.host/--/api/v2/push/send'),'ok');assert.equal(native,0);assert.equal(mocked,1);await guard(t.api_url+'/rest/v1/',{redirect:'follow'});assert.equal(native,1);await assert.rejects(guard('https://'+sharedRef+'.supabase.co'));await assert.rejects(guard('https://example.com'));await assert.rejects(restrictedFetch(async()=>{native++;},t.api_url)('https://exp.host/--/api/v2/push/send'));assert.equal(native,1);});
test('legacy startup fails before running Docker/WSL',()=>{assert.throws(()=>execFileSync(process.execPath,[path.join(root,'stacks.mjs'),'start'],{encoding:'utf8',stdio:'pipe'}),e=>String(e.stderr).includes('Retired'));});
test('all live entries refuse absent target without network access',()=>{const env={...process.env};delete env.ISSUE35_TARGET_FILE;for(const name of ['migrate','features','normal-management','compare','failures','regressions','specifications','realtime-lifecycle','integrity'])assert.throws(()=>execFileSync(process.execPath,[path.join(root,name+'.mjs')],{env,encoding:'utf8',stdio:'pipe'}),e=>String(e.stderr).includes('ISSUE35_TARGET_FILE required'),name);});
test('retired operational modules are removed',()=>{for(const name of ['transport','network-policy','provisioning','safety'])assert.equal(fs.existsSync(path.join(root,name+'.mjs')),false);});
test('CLI rejects reset and linked workdirs before process execution',()=>{let calls=0;assert.throws(()=>cloudCli({runtime:root},{},root,['db','reset'],()=>{calls++;}));assert.equal(calls,0);});
test('C must stop before application when CLI listing fails',()=>{const s=fs.readFileSync(path.join(root,'normal-management.mjs'),'utf8');assert.ok(s.indexOf("assert.equal(listingOk,true")<s.indexOf("fs.writeFileSync(path.join(dir,'supabase/migrations/2099"));});


test('actual cloud failure gate rejects stale catalog, modified evidence and wrong ref',()=>{
 const current={acl:[{allowed:false}]},record={ref:'abcdefghijklmnopqrst',catalog:current,digest:digest(current)};
 verifySavedCatalog(record,current,record.ref);
 assert.throws(()=>verifySavedCatalog(record,{acl:[{allowed:true}]},record.ref));
 assert.throws(()=>verifySavedCatalog({...record,digest:'tampered'},current,record.ref));
 assert.throws(()=>verifySavedCatalog(record,current,sharedRef));
 const source=fs.readFileSync(path.join(root,'failures.mjs'),'utf8');assert.ok(source.includes('verifySavedCatalog(record,current,plan.target.ref)'));
});
test('native CLI preserves stderr and isolates credentials/home without shell',()=>{
 const dir=path.join(root,'.runtime','cloud','offline-cli-test');assert.ok(dir.startsWith(path.join(root,'.runtime','cloud')+path.sep));assert.ok(!fs.existsSync(dir));fs.mkdirSync(path.join(dir,'work','supabase'),{recursive:true});
 try{const t=fixture(),plan={target:t,runtime:dir,runDir:dir},s={API_URL:t.api_url,dbConfig:pgConfiguration(t,'BEGIN CERTIFICATE')},calls=[];
  const result=cloudCli(plan,s,path.join(dir,'work'),['migration','list'],(binary,args,opts)=>{calls.push({binary,args});assert.equal(opts.env.USERPROFILE,path.join(dir,'cli-home'));assert.equal(opts.env.PGPASSWORD,t.database.password);assert.ok(!args.join(' ').includes(t.database.password));return{status:0,stdout:args[0]==='--version'?'3.1.0\n':'',stderr:args[0]==='--version'?'':'20261118000000 | 20261118000000'};});
  assert.ok(result.includes('20261118000000'));assert.equal(calls.length,2);
  let called=false;assert.throws(()=>cloudCli(plan,{...s,dbConfig:{...s.dbConfig,host:'db.foreign.supabase.co'}},path.join(dir,'work'),['migration','list'],()=>{called=true;}));assert.equal(called,false);
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('placeholder nonce cannot become an approved target',()=>{const t=fixture();t.nonce='REPLACE_WITH_RANDOM_64_HEX_CHARACTERS';assert.throws(()=>validateTarget(t));});

test('empty failed wrong-project and incomplete reports cannot authorize snapshot',()=>{
 const good={run:'offline',project_ref:'abcdefghijklmnopqrst',failed:0,passed:1,checks:[{status:'pass'}]};
 verifySuccessfulReport(good,good.run,good.project_ref);
 for(const bad of [{...good,failed:1},{...good,passed:0},{...good,project_ref:sharedRef},{...good,checks:[{status:'running'}]}])assert.throws(()=>verifySuccessfulReport(bad,good.run,good.project_ref));
});
test('Push wrapper cannot accept shared origin even when miscalled',()=>{assert.throws(()=>restrictedFetch(async()=>{},'https://'+sharedRef+'.supabase.co',async()=>{}));});

test('invalid target diagnostics never echo secrets or credentialed URLs',()=>{
 const t=fixture(),secret='DO_NOT_ECHO_FIXTURE_SECRET';t.api_url='https://user:'+secret+'@abcdefghijklmnopqrst.supabase.co';
 assert.throws(()=>validateTarget(t),e=>!String(e).includes(secret)&&!JSON.stringify(e).includes(secret));
});

test('removing shared-ref denial is detected independently of other validators',()=>{
 const t=fixture();t.ref=sharedRef;t.api_url='https://'+sharedRef+'.supabase.co';t.database.host='db.'+sharedRef+'.supabase.co';
 const text=fs.readFileSync(path.join(root,'configuration.mjs'),'utf8'),start=text.indexOf('export function validateTarget'),end=text.indexOf('export function fromEnvironment');
 const body=text.slice(start,end).replace('export ','');
 const mutant=body.replace("assert.notEqual(t.ref,sharedRef,'Shared project forbidden');",'');assert.notEqual(mutant,body);
 const bad=vm.runInNewContext(mutant+';validateTarget',{assert,assertNode,sharedRef,Buffer});
 assert.doesNotThrow(()=>bad(t),'Mutant must actually accept the forbidden target');
 assert.throws(()=>validateTarget(t),'Correct implementation must reject it');
});

test('wrong PostgreSQL major stops before identity-dependent mutation',async()=>{
 const t=fixture(),c={query:async()=>({rows:[{role:'postgres',db:'postgres',version:'180000'}]})};
 await assert.rejects(verifyDatabase(c,t),/Postgres major/);
});
