import{validateTarget}from'./configuration.mjs';
import fs from'node:fs';import path from'node:path';import assert from'node:assert/strict';import{spawnSync}from'node:child_process';import{cliDatabase}from'./boundaries.mjs';
export function cloudCli(plan,settings,dir,args,execute=spawnSync){
 assert.ok([['migration','list'],['db','push','--dry-run'],['db','push','--yes']].some(a=>JSON.stringify(a)===JSON.stringify(args)),'Only exact list/push operations allowed');const rel=path.relative(plan.runtime,path.resolve(dir));assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'CLI workdir must be private runtime');
 assert.ok(!fs.existsSync(path.join(dir,'supabase/.temp/project-ref')),'Linked directory forbidden');
 validateTarget(plan.target);assert.equal(settings.API_URL,plan.target.api_url);for(const k of ['host','port','user','database','password'])assert.ok(settings.dbConfig[k]===plan.target.database[k],'CLI database configuration mismatch: '+k);assert.equal(settings.dbConfig.ssl.rejectUnauthorized,true);
 const home=path.join(plan.runtime,'cli-home');fs.mkdirSync(home,{recursive:true});
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(SUPABASE|PG|DOCKER|DATABASE|DOTENV|WSLENV)/.test(k)));
 Object.assign(env,{USERPROFILE:home,HOME:home,SUPABASE_HOME:home,SUPABASE_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1',SUPABASE_NO_UPDATE_NOTIFIER:'1',PGPASSWORD:settings.dbConfig.password,PGSSLROOTCERT:path.join(plan.runDir,'database-ca.crt')});
 const actual=new URL(process.platform==='win32'?'./node_modules/@supabase/cli-windows-x64/bin/supabase.exe':'./node_modules/@supabase/cli-linux-x64/bin/supabase',import.meta.url);
 const file=process.platform==='win32'?decodeURIComponent(actual.pathname.slice(1)):decodeURIComponent(actual.pathname);
 const invoke=args=>execute(file,args,{encoding:'utf8',env,cwd:dir,timeout:90000,windowsHide:true,stdio:'pipe'});
 const version=invoke(['--version']);assert.equal(version.status,0,'Pinned CLI unavailable');assert.equal(String(version.stdout).trim(),'3.1.0');
 const target=cliDatabase(settings),result=invoke(['--workdir',dir,'--agent','no',...args,'--db-url',target.url]);
 if(result.status!==0){fs.appendFileSync(path.join(plan.runtime,'cli-error.private.log'),String(result.stdout||'')+'\n'+String(result.stderr||'')+'\n');throw Error('Temporary-project CLI failed; no fallback');}
 return String(result.stdout||'')+'\n'+String(result.stderr||'');
}
