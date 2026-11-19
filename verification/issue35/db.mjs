import{connectAndValidate}from'./verification-control.mjs';
import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import pg from'pg';
import{fromEnvironment,root,repo,pgConfiguration,verifyDatabase,verifyApi}from'./configuration.mjs';
export{root,repo};export const plan=fromEnvironment(),run=plan.name,runtime=plan.runtime,reportDirectory=plan.reportDir,labels=plan.labels;
export const project=label=>plan.project(label);
fs.mkdirSync(runtime,{recursive:true});
export function settings(label){plan.project(label);const t=plan.target,caFile=path.join(plan.runDir,'database-ca.crt');return{API_URL:t.api_url,ANON_KEY:t.anon_key,SERVICE_ROLE_KEY:t.service_role_key,dbConfig:pgConfiguration(t,fs.readFileSync(caFile,'utf8'))};}
export async function connect(label){const s=settings(label);await verifyApi(plan.target);return connectAndValidate({createClient:c=>new pg.Client(c),config:s.dbConfig,validate:c=>verifyDatabase(c,plan.target)});}
export const files=fs.readdirSync(path.join(repo,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort(),original=files.filter(f=>f<'20261118'),hardening=files.filter(f=>f.startsWith('20261118'));assert.equal(original.length,18);assert.equal(hardening.length,4);
export const report={checks:[]};
export async function check(name,fn){try{const details=await fn();report.checks.push({name,status:'pass',...(details?{details}:{})});console.log('PASS '+name);return true;}catch(e){report.checks.push({name,status:'fail',error:e.code||e.name});fs.appendFileSync(path.join(runtime,'errors.private.log'),name+'\n'+e.stack+'\n');console.log('FAIL '+name);return false;}}
export function notRun(name,reason){report.checks.push({name,status:'not-run',reason});}
export async function asRole(c,role,actor,sql,params=[]){assert.ok(['anon','authenticated','service_role'].includes(role));await c.query('BEGIN');try{await c.query('SET LOCAL ROLE '+role);await c.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[actor||'',JSON.stringify({sub:actor||undefined,role})]);const r=await c.query(sql,params);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}}
export function save(name){fs.mkdirSync(reportDirectory,{recursive:true});fs.writeFileSync(path.join(reportDirectory,name+'.json'),JSON.stringify({run,project_ref:plan.target.ref,...report,passed:report.checks.filter(x=>x.status==='pass').length,failed:report.checks.filter(x=>x.status==='fail').length,not_run:report.checks.filter(x=>x.status==='not-run').length},null,2)+'\n',{flag:'wx'});if(report.checks.some(x=>x.status==='fail'))process.exitCode=1;}
