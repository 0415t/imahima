import fs from 'node:fs';import {gunzipSync}from'node:zlib';
const allowed=new URL(process.env.SUPABASE_URL);if(allowed.hostname!=='127.0.0.1'||!['57321','58321','59321','60321','61321','62321','63321','48321','49321','50321'].includes(allowed.port))throw Error('Only dedicated Issue35 API allowed');
const original=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin===allowed.origin)return original(input,options);
 if(url.origin==='https://exp.host'&&url.pathname==='/--/api/v2/push/send'){
  let body=options.body; if(options.headers?.['Content-Encoding']==='gzip'||options.headers?.['content-encoding']==='gzip')body=gunzipSync(body).toString();
  if(body instanceof Uint8Array)body=Buffer.from(body).toString();const messages=JSON.parse(body);const list=Array.isArray(messages)?messages:[messages];
  const modeFile=process.env.ISSUE35_PUSH_MODE;const mode=modeFile&&fs.existsSync(modeFile)?fs.readFileSync(modeFile,'utf8').trim():'ok';
  if(process.env.ISSUE35_PUSH_LOG)fs.appendFileSync(process.env.ISSUE35_PUSH_LOG,JSON.stringify({count:list.length,mode})+'\n');
  return new Response(JSON.stringify({data:list.map(()=>mode==='permanent'?{status:'error',message:'Synthetic invalid device',details:{error:'DeviceNotRegistered'}}:mode==='temporary'?{status:'error',message:'Synthetic temporary failure',details:{error:'MessageRateExceeded'}}:{status:'ok',id:'issue35-local-ticket'})}),{status:200,headers:{'content-type':'application/json'}});
 }
 throw Error('External HTTP blocked by Issue35 verification');};
