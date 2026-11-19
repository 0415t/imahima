import{compareApplicationCatalogs}from'./b-baseline.mjs';
import{closeAll,verifySuccessfulReport}from'./verification-control.mjs';
import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{createHash}from'node:crypto';
import{connect,plan,repo,files,check,save}from'./db.mjs';import{snapshot}from'./catalog.mjs';import{digest}from'./verification-control.mjs';
let c,primary;
try{
 for(const name of ['migration-results','feature-results','realtime-lifecycle-results','specification-results','regression-results','integrity-results']){
  const result=JSON.parse(fs.readFileSync(path.join(plan.reportDir,name+'.json'),'utf8'));verifySuccessfulReport(result,plan.name,plan.target.ref);
 }
 c=await connect(plan.label);
 const catalog=await snapshot(c),sql=Object.fromEntries(files.map(f=>[f,createHash('sha256').update(fs.readFileSync(path.join(repo,'supabase/migrations',f))).digest('hex')]));
 const code=Object.fromEntries(fs.readdirSync(new URL('.',import.meta.url)).filter(f=>f.endsWith('.mjs')).map(f=>[f,createHash('sha256').update(fs.readFileSync(new URL(f,import.meta.url))).digest('hex')]));
 for(const f of fs.readdirSync(new URL('./fixtures/',import.meta.url)))code['fixtures/'+f]=createHash('sha256').update(fs.readFileSync(new URL('./fixtures/'+f,import.meta.url))).digest('hex');
 const record={run:plan.name,label:plan.label,ref:plan.target.ref,catalog,sql,code,digest:digest(catalog)};
 if(plan.label==='b'){
  const a=JSON.parse(fs.readFileSync(path.join(plan.runDir,'a.snapshot.json'),'utf8'));assert.equal(a.run,plan.name);assert.notEqual(a.ref,plan.target.ref);assert.equal(a.digest,digest(a.catalog));assert.deepEqual(a.sql,sql,'A SQL changed');assert.deepEqual(a.code,code,'A test code changed');const aFailures=JSON.parse(fs.readFileSync(path.join(plan.reportDir,'../a/failure-results.json'),'utf8'));verifySuccessfulReport(aFailures,plan.name,a.ref);const retired=JSON.parse(fs.readFileSync(path.join(plan.runDir,'a-retired.json'),'utf8'));assert.equal(retired.project_ref,a.ref);assert.equal(retired.confirmed_deleted,true,'Confirm A deletion before sequential comparison');
  const compared=compareApplicationCatalogs(a.catalog,catalog),diff=compared.differences;
  assert.deepEqual(diff,[],'Catalog differs; failure suite/CLI forbidden');
  fs.writeFileSync(path.join(plan.runDir,'comparison.json'),JSON.stringify({differences:diff,known_physical_differences:compared.known_physical_differences,a_ref:a.ref,b_ref:plan.target.ref,b_digest:record.digest,sql}),{flag:'wx'});
 }
 fs.writeFileSync(path.join(plan.runDir,plan.label+'.snapshot.json'),JSON.stringify(record),{flag:'wx'});
}catch(e){primary=e;await check('Comparison incomplete or different',()=>{throw e;});}finally{await closeAll([c],primary);save('comparison-results');}
