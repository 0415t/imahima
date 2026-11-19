import{createHash}from'node:crypto';
import fs from 'node:fs';import {gunzipSync}from'node:zlib';
import{fromEnvironment}from'./configuration.mjs';
import{restrictedFetch}from'./boundaries.mjs';
const plan=fromEnvironment();const allowed=new URL(process.env.SUPABASE_URL);if(allowed.origin!==plan.target.api_url)throw Error('Unapproved cloud origin');
const mockPush=async(input,options={})=>{

  let body=options.body; if(options.headers?.['Content-Encoding']==='gzip'||options.headers?.['content-encoding']==='gzip')body=gunzipSync(body).toString();
  if(body instanceof Uint8Array)body=Buffer.from(body).toString();const messages=JSON.parse(body);const list=Array.isArray(messages)?messages:[messages];
  const modeFile=process.env.ISSUE35_PUSH_MODE;const mode=modeFile&&fs.existsSync(modeFile)?fs.readFileSync(modeFile,'utf8').trim():'ok';
  if(process.env.ISSUE35_PUSH_LOG)fs.appendFileSync(process.env.ISSUE35_PUSH_LOG,JSON.stringify({count:list.length,mode,recipient_sha256:list.map(m=>createHash('sha256').update(m.to).digest('hex'))})+'\n');
  return new Response(JSON.stringify({data:list.map(()=>mode==='permanent'?{status:'error',message:'Synthetic invalid device',details:{error:'DeviceNotRegistered'}}:mode==='temporary'?{status:'error',message:'Synthetic temporary failure',details:{error:'MessageRateExceeded'}}:{status:'ok',id:'issue35-local-ticket'})}),{status:200,headers:{'content-type':'application/json'}});
};
globalThis.fetch=restrictedFetch(globalThis.fetch,allowed.origin,mockPush);
