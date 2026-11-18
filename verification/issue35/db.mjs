import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
export const root=path.dirname(fileURLToPath(import.meta.url));
export const repo=path.resolve(root,'../..');
export const run=process.env.ISSUE35_RUN||'initial';assert.ok(['initial','final','review','verified'].includes(run));
export const project=label=>'imahima-issue35-'+(run==='initial'?'':run+'-')+label;
export const runtime=path.join(root,'.runtime',run==='initial'?'':run);
export const labels=(process.env.ISSUE35_LABELS||'a,b').split(',');assert.ok(labels.length&&labels.every(x=>['a','b','c'].includes(x)));
export const apiPort=label=>run==='verified'?({a:48321,b:49321,c:50321}[label]):run==='review'?({a:61321,b:62321,c:63321}[label]):label==='a'?(run==='final'?59321:57321):(run==='final'?60321:58321);
export const settings=label=>{assert.ok(['a','b','c'].includes(label));const s=JSON.parse(fs.readFileSync(path.join(runtime,label+'.private.json')));for(const [field,port]of [['API_URL',apiPort(label)],['DB_URL',apiPort(label)+1]]){const u=new URL(s[field]);assert.equal(u.hostname,'127.0.0.1');assert.equal(Number(u.port),port);}return s;};
export async function connect(label){const info=JSON.parse(execFileSync('docker',['--host','tcp://127.0.0.1:27335','info','--format','{{json .}}'],{encoding:'utf8'}));assert.ok(info.Labels.includes('imahima.issue=35'));assert.equal(info.DockerRootDir,'/var/lib/imahima35-docker');const s=settings(label);const container=JSON.parse(execFileSync('docker',['--host','tcp://127.0.0.1:27335','inspect','supabase_db_'+project(label)],{encoding:'utf8'}))[0];assert.equal(container.State.Running,true);assert.ok(container.NetworkSettings.Ports['5432/tcp'].some(p=>p.HostPort===String(apiPort(label)+1)&&['127.0.0.1','0.0.0.0'].includes(p.HostIp)));const c=new pg.Client({connectionString:s.DB_URL,connectionTimeoutMillis:10000});await c.connect();const r=(await c.query("select current_user as role,current_database() as db,(select system_identifier::text from pg_control_system()) as id")).rows[0];assert.equal(r.role,'postgres');assert.equal(r.db,'postgres');const f=path.join(runtime,label+'.identity.json');if(fs.existsSync(f))assert.equal(JSON.parse(fs.readFileSync(f)).id,r.id);else fs.writeFileSync(f,JSON.stringify(r));return c;}
export const files=fs.readdirSync(path.join(repo,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
export const original=files.filter(f=>f<'20261118');export const hardening=files.filter(f=>f.startsWith('20261118'));
assert.equal(original.length,18);assert.equal(hardening.length,4);
export const report={checks:[]};
export async function check(name,fn){try{const details=await fn();report.checks.push({name,status:'pass',...(details?{details}:{})});console.log('PASS '+name);}catch(e){report.checks.push({name,status:'fail',error:e.code||e.name});fs.appendFileSync(path.join(runtime,'errors.private.log'),name+'\n'+e.stack+'\n');console.log('FAIL '+name+' ['+(e.code||e.name)+']');}}
export async function asRole(c,role,actor,sql,params=[]){assert.ok(['anon','authenticated','service_role'].includes(role));await c.query('BEGIN');try{await c.query('SET LOCAL ROLE '+role);await c.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[actor||'',JSON.stringify({sub:actor||undefined,role})]);const r=await c.query(sql,params);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}}
export function save(name){fs.mkdirSync(path.join(root,'reports'),{recursive:true});fs.writeFileSync(path.join(root,'reports',name+'.json'),JSON.stringify({run,...report,passed:report.checks.filter(x=>x.status==='pass').length,failed:report.checks.filter(x=>x.status==='fail').length},null,2)+'\n');if(report.checks.some(x=>x.status==='fail'))process.exitCode=1;}
