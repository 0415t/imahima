import assert from'node:assert/strict';import fs from'node:fs';
import{applyUnrecorded,applyRecorded,inTransaction,probeRejected}from'./sql-transactions.mjs';
export const captured=JSON.parse(fs.readFileSync(new URL('./fixtures/shared-20261119.json',import.meta.url),'utf8'));
export const baseVersions=Object.freeze(['20261001000000','20261006000000','20261017000000','20261104000000','20261105000000','20261105000001','20261105000002','20261106000000','20261106000001','20261111000000']);
export const missingVersions=Object.freeze(['20261111000001','H1','20261107000000','20261110000000','20261117000001','20261117000000','20261112000000','H2','20261113000000','H3','20261116000000','H4']);
export const syntheticIds=Object.freeze(Array.from({length:9},(_,i)=>'35000000-0000-4000-8000-'+String(i+1).padStart(12,'0')));
export const roomIds=Object.freeze(Array.from({length:3},(_,i)=>'35000000-0000-4000-9000-'+String(i+1).padStart(12,'0')));
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
const canon=rows=>rows.map(x=>JSON.stringify(stable(x))).sort();

export function expectedBaseline(){return structuredClone({schema:captured.schema,privileges:captured.privileges});}
export function verifyBaseline(schema,privileges){
 for(const k of ['tables','columns','indexes','constraints','triggers','policies'])assert.deepEqual(canon(schema[k]),canon(captured.schema[k]),'B baseline '+k);
 const f=rows=>rows.map(x=>{const v={...x};if(v.name==='handle_new_user'){delete v.body_md5;delete v.definition_md5;}return v;});
 assert.deepEqual(canon(f(schema.functions)),canon(f(captured.schema.functions)),'B function metadata/body differs');
 const publication=xs=>xs.filter(x=>x.name==='supabase_realtime');
 assert.deepEqual(publication(schema.publications),publication(captured.schema.publications));
 assert.deepEqual(schema.published_tables.filter(x=>x.schemaname==='public'),[],'B initial publication unexpectedly exposes public tables');
 for(const k of ['roles','memberships','tables','columns','functions','schemas','public_acl'])assert.deepEqual(canon(privileges[k]),canon(captured.privileges[k]),'B privileges '+k);
 const defaults=xs=>xs.filter(x=>['public','<global>'].includes(x.schema)&&['anon','authenticated','service_role','PUBLIC'].includes(x.grantee));
 assert.deepEqual(canon(defaults(privileges.default_acl)),canon(defaults(captured.privileges.default_acl)),'Managed/default ACL differs: do not bypass');
 return{exact_function_body_hashes:8,handle_body:'canonical OFF fixture only; shared source text not supplied',history:'version/name exact; original statements unavailable'};
}
export async function collectAndVerify(c){
 const schema=(await c.query(fs.readFileSync(new URL('./fixtures/b-schema-read.sql',import.meta.url),'utf8'))).rows[0].schema_metadata;
 const privileges=(await c.query(fs.readFileSync(new URL('./fixtures/b-privileges-read.sql',import.meta.url),'utf8'))).rows[0].effective_privileges;
 const coverage=verifyBaseline(schema,privileges);
 const history=(await c.query('select version,name from supabase_migrations.schema_migrations order by version')).rows;
 assert.deepEqual(history,captured.history.map(({version,name})=>({version,name})));
 const ext=(await c.query("select n.nspname schema,e.extversion version from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_cron'")).rows;
 assert.deepEqual(ext,[{schema:'pg_catalog',version:'1.6.4'}],'pg_cron platform differs; stop for review');
 const extensions=(await c.query("select e.extname name,n.nspname schema,e.extversion version from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname=any($1)",[captured.identity.extensions.map(e=>e.name)])).rows;
 assert.deepEqual(canon(extensions),canon(captured.identity.extensions),'Measured extension versions/placement differ; stop for review');
 const jobs=(await c.query("select schedule,active,database,username,md5(command) command_md5 from cron.job where jobname='auto-expire-free-status'")).rows;
 assert.deepEqual(jobs,[{schedule:'* * * * *',active:true,database:'postgres',username:'postgres',command_md5:captured.cron[0].command_md5}]);
 return coverage;
}
export function classification(){return roomIds.map((room_id,i)=>({room_id,mvp_managed:i===0,evidence:'Synthetic fixture design only: '+(i===0?'MVP':'legacy')+'; not shared-room provenance'}));}
export async function createBaseline(c,{file,read,applied=()=>{},verify=collectAndVerify}){
 // This is fixture DDL on an already identity-verified empty temporary project.
 // Simulate the recorded attnum hole without guessing the original column name.
 await c.query("alter default privileges for role postgres in schema public grant all on tables to anon,authenticated,service_role;alter default privileges for role postgres in schema public grant execute on functions to anon,authenticated,service_role;alter default privileges for role postgres in schema public grant all on sequences to anon,authenticated,service_role");
 await c.query("create table public.profiles(id uuid primary key references auth.users(id) on delete cascade,username text,is_free boolean default false,created_at timestamptz not null default timezone('utc',now()),_issue35_dropped_fixture_5 text,coment text,avatar_url text);alter table public.profiles drop column _issue35_dropped_fixture_5");
 for(const version of baseVersions){const name=file(version),sql=read(name);if(captured.history.some(h=>h.version===version))await applyRecorded(c,{version,name:name.slice(15,-4),sql,onCommitted:()=>applied(name)});else await applyUnrecorded(c,{sql});}
 const tables=['profiles','users','user_device_tokens','rooms','room_members','group_mvp_rate_limits'];
 await c.query('revoke all on '+tables.map(t=>'public.'+t).join(',')+' from PUBLIC,anon,authenticated,service_role');
 for(const role of ['anon','authenticated','service_role'])for(const table of tables){const allowed=captured.privileges.tables.filter(x=>x.role===role&&x.table===table&&x.allowed).map(x=>x.privilege);if(allowed.length)await c.query('grant '+allowed.join(',')+' on public.'+table+' to '+role);}
 for(const fn of captured.schema.functions){
  assert.match(fn.name,/^[a-z_]+$/);assert.match(fn.args,/^(?:(?:uuid|text|integer|boolean|jsonb)(?:, )?)*$/);
  const signature='public.'+fn.name+'('+fn.args+')';await c.query('revoke all on function '+signature+' from PUBLIC,anon,authenticated,service_role');
  if(captured.privileges.public_acl.some(x=>x.kind==='function'&&x.object===fn.name+'('+fn.args+')'&&x.privilege_type==='EXECUTE'))await c.query('grant execute on function '+signature+' to PUBLIC');
  for(const role of ['anon','authenticated','service_role'])if(captured.privileges.functions.some(x=>x.name===fn.name&&x.args===fn.args&&x.role===role&&x.execute))await c.query('grant execute on function '+signature+' to '+role);
 }
 for(const id of syntheticIds)await c.query("insert into auth.users(id,aud,role,email,raw_user_meta_data)values($1,'authenticated','authenticated',$2,'{}')",[id,id+'@issue35.invalid']);
 for(let i=0;i<3;i++)await c.query('insert into public.rooms(id,room_name,room_key,mvp_archived_at)values($1,$2,$3,$4)',[roomIds[i],'Synthetic preserved '+i,'synthetic'+i,i===0?'2026-01-01T00:00:00Z':null]);
 const coverage=await verify(c);
 const data={profiles:(await c.query('select id,username,is_free,created_at,coment,avatar_url,free_until from profiles order by id')).rows,rooms:(await c.query('select id,room_name,room_key,mvp_created_by,mvp_archived_at from rooms order by id')).rows};
 return{coverage,data};
}
export async function migrateBaseline(c,{file,read,hardening,applied=()=>{},afterH1=async()=>{}}){
 // Fixture-only adoption, not authorization for shared history repair.
 for(const version of ['20261001000000','20261105000002','20261111000000']){
  const name=file(version);await inTransaction(c,()=>c.query('insert into supabase_migrations.schema_migrations(version,name,statements)values($1,$2,$3)',[version,name.slice(15,-4),[read(name)]]));await applied('synthetic adoption '+name);
 }
 const archive=file('20261116000000');
 await probeRejected(c,{sql:read(archive),classification:[],expected:/classification/i});
 for(const key of missingVersions){const name=/^H/.test(key)?hardening[Number(key[1])-1]:file(key);await applyRecorded(c,{version:name.slice(0,14),name:name.slice(15,-4),sql:read(name),classification:key==='20261116000000'?classification():undefined,onCommitted:()=>applied(name)});if(key==='H1')await afterH1();}
}
export async function assertPreserved(c,before){
 const profiles=(await c.query('select id,username,is_free,created_at,coment,avatar_url,free_until from profiles where id=any($1)order by id',[syntheticIds])).rows;
 const rooms=(await c.query('select id,room_name,room_key,mvp_created_by,mvp_archived_at from rooms where id=any($1)order by id',[roomIds])).rows;
 assert.deepEqual(JSON.parse(JSON.stringify({profiles,rooms})),JSON.parse(JSON.stringify(before)),'B pre-existing fixture data changed');
}
export function compareApplicationCatalogs(a,b){
 const x=structuredClone(a),y=structuredClone(b),physical=[];
 // Preserve logical order, expose only the evidence-backed profiles attnum gap.
 for(const z of [x,y])for(const row of z.tables){if(row.relname==='profiles')delete row.attnum;}
 const ax=a.tables.filter(r=>r.relname==='profiles').map(r=>({column:r.attname,attnum:r.attnum})),by=b.tables.filter(r=>r.relname==='profiles').map(r=>({column:r.attname,attnum:r.attnum}));
 if(JSON.stringify(ax)!==JSON.stringify(by)){
  const expected=captured.schema.columns.filter(r=>r.table==='profiles').map(r=>({column:r.column,attnum:r.position}));
  // Later migrations append columns; only the single measured gap may differ.
  assert.deepEqual(by.slice(0,expected.length),expected,'Unexpected B profiles physical layout');
  assert.equal(ax.length,by.length,'Profile column count differs');
  for(let i=0;i<ax.length;i++){assert.equal(ax[i].column,by[i].column,'Profile logical order differs');assert.equal(ax[i].attnum,i+1,'Unexpected A profiles gap');assert.equal(by[i].attnum,ax[i].attnum+(i>=4?1:0),'Unexpected B profiles gap');}
  physical.push({table:'profiles',a:ax,b:by,reason:'Captured dropped-column gap; logical column order still compared'});
 }
 const differences=[...new Set([...Object.keys(x),...Object.keys(y)])].filter(k=>JSON.stringify(x[k])!==JSON.stringify(y[k]));
 return{differences,known_physical_differences:physical};
}
