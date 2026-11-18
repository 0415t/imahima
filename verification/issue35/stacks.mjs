import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const run=process.env.ISSUE35_RUN||'initial';assert.ok(['initial','final','review','verified'].includes(run));
const output=path.join(root,'.runtime',run==='initial'?'':run);
const action=process.argv[2];assert.ok(['start','status','stop'].includes(action));
const cli=path.resolve(root,'node_modules/supabase/dist/supabase.js');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!(/^(SUPABASE|EXPO|PG[A-Z_]|DATABASE|DOTENV|DOCKER_|OPENAI|S3_)/.test(k))));
Object.assign(env,{DOCKER_HOST:'tcp://127.0.0.1:27335',SUPABASE_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1',SUPABASE_NO_UPDATE_NOTIFIER:'1',SUPABASE_HOME:path.join(output,'cli-home')});
const docker=(...args)=>execFileSync('docker',['--host',env.DOCKER_HOST,...args],{encoding:'utf8',env,timeout:30000});
const engine=JSON.parse(docker('info','--format','{{json .}}')); assert.ok(engine.Labels.includes('imahima.issue=35')); assert.equal(engine.DockerRootDir,'/var/lib/imahima35-docker');
const labels=(process.env.ISSUE35_LABELS||'a,b').split(',');assert.ok(labels.every(x=>['a','b','c'].includes(x)));
for(const label of labels){const port=run==='verified'?({a:48321,b:49321,c:50321}[label]):run==='review'?({a:61321,b:62321,c:63321}[label]):label==='a'?(run==='final'?59321:57321):(run==='final'?60321:58321);
 const project='imahima-issue35-'+(run==='initial'?'':run+'-')+label,dir=path.join(output,project),network=project+'-net';
 if(action==='start'){
  fs.mkdirSync(path.join(dir,'supabase'),{recursive:true});
  let config=fs.readFileSync(path.resolve(root,'../group-chat-local/supabase/config.toml'),'utf8').replaceAll('imahima-chat-local',project).replace(/563(\d\d)/g,(_,x)=>String(port-21+Number(x))).replace(/^signing_keys_path.*\r?\n/m,'');
  assert.ok(!fs.existsSync(path.join(dir,'supabase/.temp/project-ref')));fs.writeFileSync(path.join(dir,'supabase/config.toml'),config);
  if(!docker('network','ls','--filter','name=^'+network+'$','--format','{{.Name}}').trim())docker('network','create','--label','imahima.issue=35','--opt','com.docker.network.bridge.host_binding_ipv4=127.0.0.1',network);
  const n=JSON.parse(docker('network','inspect',network))[0];assert.equal(n.Labels['imahima.issue'],'35');assert.equal(n.Internal,false);
  const iface='br-'+n.Id.slice(0,12);
  const rule=['DOCKER-USER','-i',iface,'-o','eth0','-m','conntrack','--ctstate','NEW','-j','DROP'];
  const wsl=(args)=>execFileSync('wsl',['-d','imahima-issue35-acl','-u','root','--','iptables','-w',...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']});
  try{wsl(['-C',...rule]);}catch{wsl(['-I',...rule]);}
  wsl(['-C',...rule]);
 }
 const args=[cli,'--workdir',dir,'--agent','no',action];
 if(action==='start')args.push('--network-id',network,'--exclude','studio,postgres-meta,storage-api,imgproxy,edge-runtime,logflare,vector,mailpit,supavisor');
 if(action==='status')args.push('--output','json');
 if(action==='stop')args.push('--project-id',project);
 try{const out=execFileSync(process.execPath,args,{env,encoding:'utf8',timeout:600000,stdio:['ignore','pipe','pipe']});
  if(action==='status'){const data=JSON.parse(out);const url=new URL(data.API_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(Number(url.port),port);fs.writeFileSync(path.join(output,label+'.private.json'),JSON.stringify(data));}
  console.log(label+': '+action+' completed (credentials omitted)');
 }catch(e){fs.writeFileSync(path.join(output,label+'.private.log'),String(e.stdout||'')+'\n'+String(e.stderr||''));console.error(label+': '+action+' failed; private diagnostic saved');process.exit(1);}
}
