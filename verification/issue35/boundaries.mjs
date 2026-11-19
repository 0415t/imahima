import{sharedRef}from'./configuration.mjs';
import assert from 'node:assert/strict';
export function restrictedFetch(nativeFetch,origin,mockPush){
 const allowed=new URL(origin);assert.ok(!allowed.username&&!allowed.password,'Credentials forbidden in API URL');assert.equal(allowed.protocol,'https:');assert.notEqual(allowed.hostname,sharedRef+'.supabase.co','Shared project forbidden');assert.match(allowed.hostname,/^[a-z]{20}\.supabase\.co$/);
 return async(input,options={})=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(u.username||u.password)throw Error('Credentials forbidden in HTTP URL');if(u.origin===allowed.origin)return nativeFetch(input,{...options,redirect:'error'});if(u.origin==='https://exp.host'&&u.pathname==='/--/api/v2/push/send'&&mockPush)return mockPush(input,options);throw Error('External HTTP blocked by Issue35');};
}
export function cliDatabase(s){const c=s.dbConfig,u=new URL('postgresql://'+encodeURIComponent(c.user)+'@'+c.host+':5432/postgres');u.searchParams.set('sslmode','verify-full');return{url:u.href,password:c.password};}
