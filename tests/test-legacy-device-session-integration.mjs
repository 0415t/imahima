import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { request, Agent } from 'node:http';
import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import { Client } from 'pg';
import { createStack, waitFor } from './helpers/issue36-stack.mjs';
import { test } from 'node:test';

test('migration 32 legacy session controls and atomic upgrade to migration 33', { timeout: 240000 }, async t => {
  const stack=createStack(t.signal,{migrationThrough:"20261203000000"});
  const agent=new Agent({proxyEnv:{}});
  try {
    const cfg=await stack.start(); stack.verifyIdentity();
    async function call(path, auth, body, method=body?'POST':'GET') {
      const dst=new URL(path,cfg.url); assert.equal(dst.origin,cfg.url); assert.equal(dst.hostname,'127.0.0.1');
      const result=await new Promise((resolve,reject)=>{
        const req=request(dst,{agent,method,signal:AbortSignal.timeout(10000),
          headers:{apikey:cfg.anon,authorization:'Bearer '+auth,'content-type':'application/json'}},res=>{
          assert.ok(res.statusCode<300||res.statusCode>=400);
          let raw='';res.setEncoding('utf8');res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,data:raw?JSON.parse(raw):null}));
        });
        req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
      });
      return result;
    }
    const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('hex');
    const created=await call('/auth/v1/admin/users',cfg.service,{email,password,email_confirm:true});
    assert.ok([200,201].includes(created.status));
    async function login(){const response=await call('/auth/v1/token?grant_type=password',cfg.anon,{email,password}); assert.equal(response.status,200);return response.data.access_token;}
    const old=await login(), other=await login(), legacyClient=await login();
    const claims=JSON.parse(Buffer.from(old.split('.')[1],'base64url'));
    const next=JSON.parse(Buffer.from(other.split('.')[1],'base64url'));
    assert.notEqual(claims.session_id,next.session_id);
    const installation=randomUUID(), sibling=randomUUID(), digest=randomBytes(32).toString('hex');
    const siblingToken='ExpoPushToken[test_'+randomUUID().replaceAll('-','')+']';
    stack.query(`BEGIN; SET LOCAL ROLE postgres;
      INSERT INTO push_private.installations (installation_id,public_key) VALUES ('${installation}',decode('04','hex')),('${sibling}',decode('04','hex'));
      INSERT INTO push_private.installation_bindings(installation_id,user_id,session_id) VALUES ('${sibling}','${next.sub}','${next.session_id}');
      INSERT INTO public.user_device_tokens(user_id,expo_push_token,platform,installation_id,generation,registration_revision)
      SELECT user_id,'${siblingToken}','android',installation_id,generation,1 FROM push_private.installation_bindings WHERE installation_id='${sibling}';
      SELECT push_private.issue_device_challenge('${installation}',1,'begin_session_logout',decode('${digest}','hex'));
      SELECT push_private.begin_device_session_logout('${installation}','${claims.sub}','${claims.session_id}','${randomUUID()}',1,decode('${digest}','hex')); COMMIT;`);
    const legacy=async()=>call('/rest/v1/rpc/upsert_device_token',old,{p_token:'ExpoPushToken[test_'+randomUUID().replaceAll('-','')+']',p_platform:'android'});
    const before=await legacy();
    assert.equal(before.status,403);
    assert.equal((await call('/auth/v1/logout?scope=local',old,{})).status,204);
    assert.equal(stack.query(`SELECT count(*) FROM auth.sessions WHERE id='${claims.session_id}';`),'0');
    assert.equal(stack.query(`SELECT count(*) FROM auth.sessions WHERE id='${next.session_id}';`),'1');
    const after=await legacy();
    assert.equal(after.status,403);
    const visible=await call('/rest/v1/user_device_tokens?select=expo_push_token',old);
    assert.equal(visible.status,200);
    assert.deepEqual(visible.data,[]);
    const token='ExpoPushToken[test_'+randomUUID().replaceAll('-','')+']';
    const registered=await call('/rest/v1/rpc/upsert_device_token',legacyClient,{p_token:token,p_platform:'android'});
    assert.equal(registered.status,204);
    const readPath='/rest/v1/user_device_tokens?select=expo_push_token';
    assert.deepEqual((await call(readPath,legacyClient)).data,[{expo_push_token:token}]);
    assert.equal((await call('/rest/v1/rpc/extend_profile_is_free_from_notification',cfg.service,
      {target_profile_id:claims.sub,claim_id:randomUUID()})).status,403);
    const legacyClaims=JSON.parse(Buffer.from(legacyClient.split('.')[1],'base64url'));
    const newDevice=randomUUID(), nonce=randomBytes(32).toString('hex');
    stack.query(`INSERT INTO push_private.installations(installation_id,public_key) VALUES ('${newDevice}',decode('04','hex'));
      SELECT push_private.issue_device_challenge('${newDevice}',1,'enroll',decode('${nonce}','hex'));`);
    assert.throws(()=>stack.query(`SELECT push_private.open_device_generation('${newDevice}','${legacyClaims.sub}',
      '${legacyClaims.session_id}',1,decode('${nonce}','hex'));`),/Legacy registration must be cleared first/);
    const retirement = readFileSync(new URL('../supabase/migrations/20261204000000_retire_legacy_device_registration.sql',import.meta.url),'utf8');
    assert.throws(()=>stack.query(retirement),/legacy/i);
    assert.deepEqual((await call(readPath,legacyClient)).data,[{expo_push_token:token}]);
    const tokenPath='/rest/v1/user_device_tokens?expo_push_token=eq.'+encodeURIComponent(token);
    assert.equal((await call(tokenPath,old,undefined,'DELETE')).status,204);
    assert.deepEqual((await call(readPath,legacyClient)).data,[{expo_push_token:token}]);
    assert.equal((await call(tokenPath,legacyClient,undefined,'DELETE')).status,204);
    assert.deepEqual((await call(readPath,legacyClient)).data,[]);
    assert.equal(stack.query(`SELECT count(*) FROM public.user_device_tokens WHERE expo_push_token='${siblingToken}';`),'1');
    const claim=randomUUID();
    stack.query(`UPDATE public.profiles SET is_free=true,free_until=clock_timestamp()+interval '4 min' WHERE id='${claims.sub}';
      INSERT INTO public.free_end_notification_claims(id,user_id,free_until,status)
      SELECT '${claim}',id,free_until,'sent' FROM public.profiles WHERE id='${claims.sub}';`);
    assert.throws(()=>stack.query(`SELECT * FROM push_private.extend_free_for_live_notification_session(
      '${claims.sub}','${claims.session_id}','${claim}');`),/Session is unavailable/);
    const holder=stack.openSqlSession();
    const closed=once(holder,'close');
    let output='', logout;
    holder.stdout.on('data',chunk=>{ output+=chunk; });
    holder.stdin.write(`BEGIN; SET LOCAL ROLE imahima_device_verifier;
      SELECT pg_backend_pid();
      SELECT * FROM push_private.extend_free_for_live_notification_session(
        '${legacyClaims.sub}','${legacyClaims.session_id}','${claim}');
      \n\\echo extension-held\n`);
    try {
      await waitFor(()=>output.includes('extension-held'),'notification extension holds the Auth session lock',t.signal);
      const pid=Number(output.match(/^\d+$/m)?.[0]);
      assert.ok(Number.isSafeInteger(pid)&&pid>0);
      logout=call('/auth/v1/logout?scope=local',legacyClient,{});
      await waitFor(()=>stack.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity p
        WHERE ${pid}=ANY(pg_blocking_pids(p.pid))); `)==='t','GoTrue waits for the extension transaction',t.signal);
    } finally {
      holder.stdin.end('COMMIT;\n');
      assert.equal((await closed)[0],0);
      if (logout) assert.equal((await logout).status,204);
    }
    assert.equal(stack.query(`SELECT p.free_until=c.free_until+interval '30 minutes'
      FROM public.profiles p JOIN public.free_end_notification_claims c ON c.user_id=p.id WHERE c.id='${claim}';`),'t');
    assert.throws(()=>stack.query(`SELECT * FROM push_private.extend_free_for_live_notification_session(
      '${legacyClaims.sub}','${legacyClaims.session_id}','${claim}');`),/Session is unavailable/);

    const enrollingActor=JSON.parse(Buffer.from((await login()).split('.')[1],'base64url'));
    const enrollingInstallation=randomUUID(), enrollmentNonce=randomBytes(32).toString('hex');
    const challengeSql=`SELECT push_private.issue_device_enrollment(decode('${enrollmentNonce}','hex'),
      '${enrollingActor.sub}','${enrollingActor.session_id}','${enrollingInstallation}',sha256(decode('04','hex')));`;
    stack.query(challengeSql);
    const enrolling=stack.openSqlSession();
    const enrolled=once(enrolling,'close');
    let enrollmentOutput='';
    enrolling.stdout.on('data',chunk=>{ enrollmentOutput+=chunk; });
    enrolling.stdin.write(`BEGIN; SET LOCAL ROLE imahima_device_verifier;
      SELECT push_private.finish_device_enrollment(decode('${enrollmentNonce}','hex'),
        '${enrollingActor.sub}','${enrollingActor.session_id}','${enrollingInstallation}',decode('04','hex'));
      \n\\echo enrollment-held\n`);
    const fenceNonce=randomBytes(32).toString('hex');
    const issueFence=`SET lock_timeout='1500ms'; SELECT push_private.issue_device_challenge('${enrollingInstallation}',1,
      'begin_session_logout',decode('${fenceNonce}','hex'));`;
    try {
      await waitFor(()=>enrollmentOutput.includes('enrollment-held'),'first registration is still uncommitted',t.signal);
      assert.throws(()=>stack.query(issueFence),/Installation is unavailable|lock timeout/);
      assert.equal(stack.query(`SELECT count(*) FROM push_private.logout_recoveries WHERE installation_id='${enrollingInstallation}';`),'0');
    } finally {
      enrolling.stdin.end('COMMIT;\n');
      assert.equal((await enrolled)[0],0);
    }
    stack.query(issueFence);
    assert.equal(JSON.parse(stack.query(`SELECT push_private.begin_device_session_logout(
      '${enrollingInstallation}','${enrollingActor.sub}','${enrollingActor.session_id}','${randomUUID()}',1,
      decode('${fenceNonce}','hex'));`)).generation,null);
    assert.equal(stack.query(`SELECT count(*) FROM push_private.installation_bindings WHERE installation_id='${enrollingInstallation}';`),'0');

    const commitActor=JSON.parse(Buffer.from((await login()).split('.')[1],'base64url'));
    const commitInstallation=randomUUID(), operation=randomUUID(), passwordForProbe=randomBytes(24).toString('hex');
    const prepare=() => {
      const digest=randomBytes(32).toString('hex');
      stack.query(`SELECT push_private.issue_device_challenge('${commitInstallation}',1,
        'begin_session_logout',decode('${digest}','hex'));`);
      return `SELECT push_private.begin_device_session_logout('${commitInstallation}','${commitActor.sub}',
        '${commitActor.session_id}','${operation}',1,decode('${digest}','hex')) AS receipt`;
    };
    stack.query(`CREATE ROLE session_commit_probe LOGIN NOINHERIT PASSWORD '${passwordForProbe}';
      GRANT imahima_device_verifier TO session_commit_probe WITH INHERIT FALSE, SET TRUE;
      INSERT INTO push_private.installations(installation_id,public_key) VALUES ('${commitInstallation}',decode('04','hex'));`);
    const upstream=await stack.openPostgresRelay();
    let armed=false, discarded=false, sockets=[];
    const proxy=createServer(downstream=>{
      const db=connect(upstream.port,'127.0.0.1');
      sockets=[downstream,db];
      downstream.pipe(db);
      downstream.on('error',()=>db.destroy());
      downstream.on('close',()=>db.destroy());
      db.on('error',()=>downstream.destroy());
      let pending=Buffer.alloc(0);
      db.on('data',chunk=>{
        if (!armed) { downstream.write(chunk); return; }
        pending=Buffer.concat([pending,chunk]);
        if (pending.length<5) return;
        const length=pending.readUInt32BE(1);
        if (pending.length<length+1) return;
        discarded=pending[0]===0x43&&pending.subarray(5,length).toString()==='COMMIT';
        downstream.destroy();
      });
    }).listen(0,'127.0.0.1');
    await once(proxy,'listening');
    const client=new Client({host:'127.0.0.1',port:proxy.address().port,user:'session_commit_probe',
      password:passwordForProbe,database:'postgres',ssl:false,query_timeout:5000});
    client.on('error',()=>{});
    try {
      await client.connect();
      await client.query('BEGIN; SET LOCAL ROLE imahima_device_verifier;');
      const { rows }=await client.query(prepare());
      armed=true;
      await assert.rejects(client.query('COMMIT'));
      assert.equal(discarded,true,'the server sent CommandComplete for COMMIT before transport was cut');
      const replay=JSON.parse(stack.query(prepare()));
      assert.deepEqual(replay,rows[0].receipt);
    } finally {
      for (const socket of sockets) socket.destroy();
      await client.end();
      await new Promise((resolve,reject)=>proxy.close(error=>error?reject(error):resolve()));
      await upstream.close();
    }
    stack.query(retirement);
    assert.equal(stack.query("SELECT to_regprocedure('public.upsert_device_token(text,text,text)') IS NULL;"),'t');
    assert.equal(stack.query("SELECT to_regclass('push_private.legacy_registration_sessions') IS NULL;"),'t');
    for(const role of ['anon','authenticated','service_role']) {
      assert.equal(stack.query(`SELECT has_any_column_privilege('${role}','public.user_device_tokens','SELECT')
        OR has_any_column_privilege('${role}','public.user_device_tokens','INSERT')
        OR has_any_column_privilege('${role}','public.user_device_tokens','UPDATE')
        OR has_table_privilege('${role}','public.user_device_tokens','DELETE');`),'f');
    }
    assert.equal(stack.query(`SELECT count(*) FROM public.user_device_tokens WHERE expo_push_token='${siblingToken}';`),'1');
  } finally { agent.destroy(); await stack.stop(); }
});
