import{snapshot}from'./catalog.mjs';import{digest}from'./verification-control.mjs';
import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';
import{connect,plan,runtime,repo,settings,files,check,save}from'./db.mjs';import{cloudCli}from'./cloud-cli.mjs';import{assertListing,assertUpToDate}from'./cli-assertions.mjs';
const c=await connect(plan.label);
try{
 const compared=JSON.parse(fs.readFileSync(path.join(plan.runDir,'comparison.json'),'utf8'));assert.deepEqual(compared.differences,[],'Compare A/B before forward probe');assert.equal(compared.b_ref,plan.target.ref);assert.equal(compared.b_digest,digest(await snapshot(c)),'B drift after comparison; refusing CLI');
 const dir=path.join(runtime,'cli-forward');assert.ok(!fs.existsSync(dir),'CLI probe already attempted');fs.mkdirSync(path.join(dir,'supabase/migrations'),{recursive:true});
 fs.writeFileSync(path.join(dir,'supabase/config.toml'),'project_id = "issue35-temporary"\n[db.migrations]\nenabled = true\n');
 for(const f of files)fs.copyFileSync(path.join(repo,'supabase/migrations',f),path.join(dir,'supabase/migrations',f));
 const cli=args=>cloudCli(plan,settings(plan.label),dir,args);
 const listingOk=await check('C recognizes all 22 migrations',async()=>{assert.deepEqual((await c.query('select version from supabase_migrations.schema_migrations order by version')).rows.map(r=>r.version),files.map(f=>f.slice(0,14)));assertListing(cli(['migration','list']),files.map(f=>f.slice(0,14)));assertUpToDate(cli(['db','push','--dry-run']));});
 assert.equal(listingOk,true,'CLI listing/dry-run failed; refusing application');
 assert.equal((await c.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n,22);
 fs.writeFileSync(path.join(dir,'supabase/migrations/20990101000000_issue35_forward_probe.sql'),"BEGIN;CREATE TABLE public.issue35_forward_probe(id integer primary key);REVOKE ALL ON public.issue35_forward_probe FROM PUBLIC,anon,authenticated,service_role;COMMIT;\n");
 assert.match(cli(['db','push','--dry-run']),/20990101000000/);cli(['db','push','--yes']);
 await check('C forward migration and history',async()=>{assert.equal((await c.query("select to_regclass('public.issue35_forward_probe') is not null present")).rows[0].present,true);assert.equal((await c.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n,23);assert.equal((await c.query("select count(*)::int n from pg_class c cross join lateral aclexplode(c.relacl)a where c.oid='public.issue35_forward_probe'::regclass and (a.grantee=0 or pg_get_userbyid(a.grantee)in('anon','authenticated','service_role'))")).rows[0].n,0);assertUpToDate(cli(['db','push','--dry-run']));});
}finally{await c.end();}save('normal-management-results');
