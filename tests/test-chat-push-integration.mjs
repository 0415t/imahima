import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { stopIssue36Server } from './helpers/issue36-process.mjs';
import { cleanEnv, createStack, waitFor } from './helpers/issue36-stack.mjs';

const cwd = new URL('../', import.meta.url);
const sqlLiteral = text => "'" + text.replaceAll("'", "''") + "'";
const failureStatuses = [401,403];
const faultsOnly = process.env.IMAHIMA_WORKER_FAULTS_ONLY === '1';

test('Real Supabase and Express notification workers to mocked Expo', {timeout:420000}, async t => {
  const interrupt=new AbortController();
  const signal=AbortSignal.any([t.signal,interrupt.signal]);
  const stack = createStack(signal);
  const directAgent = new Agent({ proxyEnv: {} });
  const servers = [];
  const observed = [];
  let interrupted = false;
  const terminate = () => {
    interrupted = true;
    interrupt.abort();
  };
  process.once('SIGINT',terminate);
  process.once('SIGTERM',terminate);
  const runCase = async (name, fn) => {
    if (faultsOnly && !name.endsWith('remaining delivery fault cases')) return;
    let passed = false;
    await t.test(name,async()=>{
      assert.equal(interrupted,false,'The test was interrupted');
      await fn();
      passed = true;
    });
    assert.ok(passed, `Stopping after failed case: ${name}`);
  };
  const makeToken = () => `ExpoPushToken[issue36_${randomUUID().replaceAll('-','')}]`;
  const auth = {};
  const fakeTokens = [];

  try {
    const config = await stack.start();
    const localOrigins=new Set([config.url]);
    async function request(base, path, {method='GET', jwt=config.anon, body, rawBody, status}={}) {
      assert.ok(localOrigins.has(base) && /^\/(?!\/)/.test(path));
      const url=new URL(path,base);
      assert.equal(url.origin,base);
      assert.equal(url.hostname,'127.0.0.1');
      assert.equal(url.protocol,'http:');
      const payload=rawBody ?? (body===undefined?undefined:JSON.stringify(body));
      const {statusCode,text}=await new Promise((resolve,reject)=>{
        const req=httpRequest(url,{
          agent:directAgent,method,signal:AbortSignal.any([signal,AbortSignal.timeout(8000)]),
          headers:{apikey:config.anon,authorization:`Bearer ${jwt}`,'content-type':'application/json'},
        },res=>{
          res.setEncoding('utf8');
          let text='';
          res.on('data',chunk=>{text+=chunk;});
          res.on('error',reject);
          res.on('end',()=>resolve({statusCode:res.statusCode,text}));
        });
        req.on('error',reject);
        req.end(payload);
      });
      assert.ok(statusCode<300 || statusCode>=400,'Redirects are forbidden');
      if(status!==undefined) assert.ok([status].flat().includes(statusCode),
        `${method} ${path.split('?')[0]}: expected ${status}, received ${statusCode}`);
      return {status:statusCode,data:text?JSON.parse(text):null};
    }
    async function actor(name) {
      const email=`issue36-${randomUUID()}@example.invalid`;
      const password=randomBytes(24).toString('hex');
      const {data:user}=await request(config.url,'/auth/v1/admin/users',
        {method:'POST',jwt:config.service,body:{email,password,email_confirm:true,user_metadata:{username:name}},status:[200,201]});
      const {data:session}=await request(config.url,'/auth/v1/token?grant_type=password',
        {method:'POST',body:{email,password},status:200});
      assert.equal(session.user.id,user.id);
      const token=makeToken();
      fakeTokens.push(token);
      await request(config.url,'/rest/v1/rpc/upsert_device_token',{
        method:'POST',jwt:session.access_token,body:{p_token:token,p_platform:'android'},status:[200,204],
      });
      auth[name]={id:user.id,jwt:session.access_token,token,
        async newSession() {
          const {data}=await request(config.url,'/auth/v1/token?grant_type=password',
            {method:'POST',body:{email,password},status:200});
          assert.equal(data.user.id,user.id);
          return data.access_token;
        },
      };
    }
    async function startServer(worker, barrierId='', deliveryKind='chat_message', authorizationId='', invalidToken='', dropAuthorization=false) {
      const messages=[];
      // Pass only OS essentials, never parent DB settings, preloads or credentials.
      const child=spawn(process.execPath,['--require','./tests/issue36-chat-push-guard.cjs','--import','tsx','server/index.ts'],{
        cwd,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],
        env:{...cleanEnv,DOTENV_CONFIG_PATH:process.platform==='win32'?'NUL':'/dev/null',DOTENV_CONFIG_QUIET:'true',
          HOST:'127.0.0.1',PORT:'0',SUPABASE_URL:config.url,SUPABASE_SERVICE_ROLE_KEY:config.service,
          ISSUE36_GATEWAY:config.url,ISSUE36_FAKE_TOKENS:JSON.stringify(fakeTokens),ISSUE36_BARRIER_ID:barrierId,
          ISSUE36_SKIP_FINAL_VALIDATE:process.env.ISSUE36_SKIP_FINAL_VALIDATE==='1'?'1':'0',
          ISSUE36_DELAY_MOCK_IPC:process.env.ISSUE36_DELAY_MOCK_IPC==='1'?'1':'0',
          ISSUE36_DELIVERY_KIND:deliveryKind,ISSUE36_AUTHORIZATION_ID:authorizationId,ISSUE36_INVALID_TOKEN:invalidToken,
          ISSUE36_DROP_AUTHORIZATION:String(Number(dropAuthorization)),
          EXPO_ACCESS_TOKEN:'',EXPO_BASE_URL:'https://exp.host',FREE_END_NOTIFICATIONS_ENABLED:String(deliveryKind==='free_end'),
          MEMBER_FREE_NOTIFICATIONS_ENABLED:String(deliveryKind==='member_free'),CHAT_MESSAGE_NOTIFICATIONS_ENABLED:String(worker&&deliveryKind==='chat_message'),
          FREE_END_NOTIFICATIONS_INTERVAL_MS:faultsOnly?'60000':'1000',MEMBER_FREE_NOTIFICATIONS_INTERVAL_MS:faultsOnly?'60000':'1000',
          CHAT_MESSAGE_NOTIFICATIONS_INTERVAL_MS:faultsOnly?'60000':'1000',GROUP_RATE_SECRET:randomBytes(24).toString('hex')},
      });
      let ended=false, error;
      let sawWorker=false;
      const done=new Promise(resolve=>child.once('close',(code,signal)=>{ended=true;resolve({code,signal});}));
      const server={child,done,messages,get ended(){return ended;}};
      servers.push(server);
      child.once('error',value=>{error=value;});
      child.on('message',message=>{
        messages.push(message);
        if(message.type==='mock-push') observed.push(...message.messages);
      });
      child.stdout.on('data',chunk=>{
        sawWorker ||= String(chunk).includes(({chat_message:'Chat message',free_end:'Free-end',member_free:'Member-free'})[deliveryKind]+' notification poller started');
      });
      child.stderr.resume();
      const bound=await waitFor(()=>{
        assert.ok(!ended && !error,'Express entrypoint exited or failed to spawn');
        if(!messages.some(message=>message.type==='guard-ready')) return false;
        return messages.find(message=>message.type==='express-bound');
      },'Express loopback binding',signal);
      assert.ok(Number.isInteger(bound.port) && bound.port>0 && bound.port<=65535);
      server.url=`http://127.0.0.1:${bound.port}`;
      assert.ok(!localOrigins.has(server.url),'Expected a distinct listener');
      localOrigins.add(server.url);
      assert.equal((await request(server.url,'/health')).status,200);
      if(worker) await waitFor(()=>sawWorker,'chat worker startup',signal);
      else assert.equal(sawWorker,false);
      return server;
    }
    const names=['sender','eligible','off','expired','outsider','rejoin','reon'];
    for(const name of names) await actor(name);
    await runCase('relay passes an at-prefixed body verbatim to PostgREST',async()=>{
      const invalid=await request(config.url,'/rest/v1/rpc/upsert_device_token',{
        method:'POST',jwt:auth.eligible.jwt,rawBody:`@/issue36-nonexistent-${randomUUID()}`,status:400,
      });
      assert.equal(invalid.data.code,'PGRST102');
    });
    // The guard and gateway are pinned to the verified local network and cluster.
    stack.verifyIdentity();
    const api=await startServer(false);
    const call=(actor,path,options={})=>request(api.url,path,{...options,jwt:auth[actor].jwt});
    const setFree=(actor,is_free)=>call(actor,'/profiles/me/is-free',
      {method:'PUT',body:is_free?{is_free,duration_minutes:30}:{is_free},status:200});
    async function room(owner, label) {
      const {data}=await call(owner,'/groups',{method:'POST',body:{name:label},status:201});
      assert.ok(data.group.id && data.invite_code);
      return {id:data.group.id,code:data.invite_code};
    }
    const join=(actor,group)=>call(actor,'/groups/join',{method:'POST',body:{invite_code:group.code},status:201});
    const leave=(actor,group)=>call(actor,`/groups/${group.id}/members/me`,{method:'DELETE',status:204});
    const send=(group,body,clientId=randomUUID(),status=201,actor='sender')=>call(actor,`/groups/${group.id}/messages`,
      {method:'POST',body:{body,client_message_id:clientId},status});
    const remove=(group,id)=>call('sender',`/groups/${group.id}/messages/${id}`,{method:'DELETE',status:200});
    const rows=()=>JSON.parse(stack.query(`SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.id),'[]')
      FROM public.chat_message_notifications n;`));
    const forMessage=id=>rows().filter(row=>row.message_id===id);
    const clockField=(actor,column)=>stack.query(`SELECT ${column} FROM public.profiles WHERE id=${sqlLiteral(auth[actor].id)};`);
    const old={};
    const good=new Map();
    const messageKey=(answer)=>answer.data.message.id;
    const expectGood=(answer,actor)=>{good.set(messageKey(answer),actor);return messageKey(answer);};
    let audience, leftRoom, reonRoom;
    if (faultsOnly) {
      audience=await room('sender','Fault test audience');
      await join('eligible',audience);
      await setFree('eligible',true);
    }
    await runCase('1–2: real send snapshots only eligible ON recipients',async()=>{
      audience=await room('sender','Synthetic audience');
      await room('outsider','Synthetic other room');
      for(const actor of ['eligible','off','expired']) await join(actor,audience);
      for(const actor of ['sender','eligible','expired','outsider']) await setFree(actor,true);
      // Move only the dedicated fixture deadline, leaving is_free true. Cron is disabled.
      stack.query(`UPDATE public.profiles SET free_until=statement_timestamp()-interval '1 second'
        WHERE id=${sqlLiteral(auth.expired.id)};`);
      assert.equal(clockField('expired','is_free'),'t');
      const id=expectGood(await send(audience,'audience'), 'eligible');
      assert.deepEqual(forMessage(id).map(n=>[n.recipient_user_id,n.status]),[[auth.eligible.id,'pending']]);
      await setFree('off',true);
      assert.deepEqual(forMessage(id).map(n=>n.recipient_user_id),[auth.eligible.id]);
      await setFree('off',false);
    });
    await runCase('3: exit and rejoin do not reactivate an old notification',async()=>{
      leftRoom=await room('sender','Synthetic rejoin');
      await join('rejoin',leftRoom); await setFree('rejoin',true);
      old.rejoin=messageKey(await send(leftRoom,'old membership'));
      const oldGeneration=forMessage(old.rejoin)[0].recipient_membership_id;
      await leave('rejoin',leftRoom); await join('rejoin',leftRoom);
      const fresh=expectGood(await send(leftRoom,'new membership'),'rejoin');
      assert.notEqual(forMessage(fresh)[0].recipient_membership_id,oldGeneration);
    });
    await runCase('4: OFF then ON does not reactivate an old notification',async()=>{
      reonRoom=await room('sender','Synthetic reON');
      await join('reon',reonRoom); await setFree('reon',true);
      old.reon=messageKey(await send(reonRoom,'old period'));
      const period=forMessage(old.reon)[0].recipient_period_id;
      await setFree('reon',false); await setFree('reon',true);
      assert.notEqual(clockField('reon','free_period_id'),period);
      expectGood(await send(reonRoom,'new period'),'reon');
    });
    await runCase('5: extension retains the same ON period',async()=>{
      const id=expectGood(await send(audience,'extended period'),'eligible');
      const period=forMessage(id)[0].recipient_period_id;
      await call('eligible','/profiles/me/is-free/extend',{method:'POST',status:200});
      assert.equal(clockField('eligible','free_period_id'),period);
    });
    await runCase('6: prepare deleted and expired notices and a final-validation race',async()=>{
      old.deleted=messageKey(await send(audience,'deleted'));
      await remove(audience,old.deleted);
      assert.equal(forMessage(old.deleted)[0].status,'cancelled');
      old.expired=messageKey(await send(audience,'expired outbox'));
      // Keep the table constraint expires_at = message_created_at + 5 minutes.
      stack.query(`UPDATE public.chat_message_notifications
        SET message_created_at=statement_timestamp()-interval '6 minutes',expires_at=statement_timestamp()-interval '1 minute'
        WHERE message_id=${sqlLiteral(old.expired)};`);
      old.race=messageKey(await send(audience,'deleted after claim'));
    });
    await runCase('7: distinct rapid sends and same-ID concurrent retry',async()=>{
      await setFree('sender',false);
      const clientId=randomUUID();
      const results=await Promise.all(['off','off'].map(actor=>send(audience,'idempotent',clientId,[200,201],actor)));
      assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
      const id=expectGood(results[0],'eligible');
      assert.equal(messageKey(results[1]),id);
      assert.equal(forMessage(id).length,1);
      assert.equal(stack.query(`SELECT count(*) FROM public.room_message_events WHERE event_type='created' AND message_id=${sqlLiteral(id)};`),'1');
      for(const text of ['rapid 1','rapid 2','rapid 3']) {
        const rapid=expectGood(await send(audience,text,undefined,201,'off'),'eligible');
        assert.equal(forMessage(rapid).length,1);
      }
    });
    await runCase('10: normal user JWT cannot read outbox or call worker RPCs',async()=>{
      await request(config.url,'/rest/v1/chat_message_notifications?select=id',{jwt:auth.eligible.jwt,status:failureStatuses});
      const paths={
        claim_chat_message_notifications:{},
        validate_chat_message_notification:{p_notification:randomUUID(),p_lease_token:randomUUID()},
        complete_chat_message_notification:{p_notification:randomUUID(),p_lease_token:randomUUID(),p_status:'cancelled'},
      };
      for(const [name,body] of Object.entries(paths)) {
        await request(config.url,'/rest/v1/rpc/'+name,{method:'POST',body,jwt:auth.eligible.jwt,status:failureStatuses});
      }
    });
    assert.equal(observed.length,0);
    const raceId=faultsOnly?'':forMessage(old.race)[0].id;
    const worker=faultsOnly?null:await startServer(true,raceId);
    let loaderIpcBlocked=0;
    await runCase('6 continued: deletion between validations leaves no send',async()=>{
      await waitFor(()=>worker.messages.some(r=>r.type==='before-final-validate'),'in-flight worker before second validation',signal);
      assert.equal(forMessage(old.race)[0].status,'processing');
      await remove(audience,old.race);
      worker.child.send({type:'release-final-validate'});
      const validation=await waitFor(()=>worker.messages.find(message=>message.type==='final-validate-response'),
        'real final validate response for deleted notification',signal);
      assert.deepEqual(validation,{type:'final-validate-response',notificationId:raceId,status:200,owned:false});
      await waitFor(()=>rows().every(row=>!['pending','processing','failed'].includes(row.status)),
        'terminal outbox',signal,65000,500);
      if(process.env.ISSUE36_DELAY_MOCK_IPC==='1') assert.equal(observed.length,0,'Mock IPC must still be held after terminal outbox');
      for(const server of servers){
        server.child.send({type:'guard-status'});
        const status=await waitFor(()=>server.messages.find(m=>m.type==='guard-status'),'outbound audit IPC',signal);
        assert.equal(status.blocked,0,`Unexpected network attempts: ${status.blockedKinds.join(', ')}`);
        loaderIpcBlocked+=status.blockedLoaderIpc;
      }
      for(const [kind,id] of Object.entries(old)) {
        assert.equal(forMessage(id)[0].status,kind==='expired'?'expired':'cancelled');
        assert.equal(observed.some(message=>message.data.messageId===id),false);
      }
    });
    await runCase('8–9: real worker closes claim, validations and completion through PostgREST',async()=>{
      const finalRows=rows();
      const sent=finalRows.filter(row=>row.status==='sent');
      assert.equal(sent.length,good.size);
      assert.equal(observed.length,good.size);
      for(const row of sent){
        assert.ok(good.has(row.message_id),'Unexpected delivered message');
        const [message,...duplicates]=observed.filter(item=>item.data.notificationId===row.id);
        assert.ok(message);
        assert.equal(duplicates.length,0);
        assert.equal(message.to,auth[good.get(row.message_id)].token);
        assert.equal(row.recipient_user_id,auth[good.get(row.message_id)].id);
        assert.equal(message.title,'imahima');
        assert.equal(message.expiration,Math.floor(Date.parse(row.expires_at)/1000));
        const stored=stack.query(`SELECT body FROM public.messages WHERE id=${sqlLiteral(row.message_id)};`);
        const actor=/^(idempotent|rapid [123])$/.test(stored)?'off':'sender';
        assert.equal(message.body,actor+': '+stored);
        assert.deepEqual(message.data,{version:1,type:'chat_message',roomId:row.room_id,messageId:row.message_id,notificationId:row.id});
        assert.equal(row.accepted_count,1);
        assert.equal(row.attempts,1);
      }
      for(const path of ['/auth/v1/token','/auth/v1/user','/rest/v1/rpc/chat_send_message',
        '/rest/v1/rpc/claim_chat_message_notifications','/rest/v1/rpc/validate_chat_message_notification',
        '/rest/v1/rpc/authorize_notification_delivery','/rest/v1/rpc/complete_chat_message_notification']){
        assert.ok(config.traffic.get(path+' 200')>0,`Missing real upstream success: ${path}`);
      }
      assert.ok(config.traffic.get('/rest/v1/rpc/validate_chat_message_notification 200') >= good.size*2+2);
      assert.equal(config.traffic.get('/rest/v1/rpc/complete_chat_message_notification 200'),good.size);
      console.log(JSON.stringify({isolatedServices:['PostgreSQL 17','GoTrue','PostgREST','Express','chat Push worker'],
        mockedExpoSends:observed.length,externalNetworkAttempts:0,loaderIpcBlocked,guardRejectionProbesPassed:true,
        sharedDatabaseConnections:0,terminalOutboxRows:finalRows.length}));
    });
    if(worker) assert.equal((await stopIssue36Server(worker.child,worker.done,worker.ended)).code,0);
    const managed = async (recipient, age) => {
      const installation=randomUUID(), id=randomUUID(), token=makeToken();
      fakeTokens.push(token);
      const jwt=await recipient.newSession();
      const session=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url')).session_id;
      const generation=stack.query(`INSERT INTO push_private.installations(installation_id,public_key)
        VALUES ('${installation}',decode('04','hex'));
        INSERT INTO push_private.installation_bindings(installation_id,user_id,session_id,created_at)
        VALUES ('${installation}','${recipient.id}','${session}',clock_timestamp()-interval '${age} minutes') RETURNING generation;`);
      assert.match(generation,/^[0-9]+$/);
      stack.query(`BEGIN; SET LOCAL ROLE postgres;
        INSERT INTO public.user_device_tokens(id,user_id,expo_push_token,platform,installation_id,generation,registration_revision)
        VALUES ('${id}','${recipient.id}',${sqlLiteral(token)},'android','${installation}',${generation},1); COMMIT;`);
      return {installation,generation,token,session,jwt};
    };
    if (faultsOnly) for (const kind of ['free_end','member_free','chat_message']) {
      await runCase(kind+': remaining delivery fault cases',async()=>{
        const recipient=auth.eligible, other=auth.outsider;
        const victim=await managed(recipient,20);
        const sibling=await managed(recipient,20);
        let id,table;
        if(kind==='free_end') {
          table='free_end_notification_claims'; id=randomUUID();
          stack.query(`UPDATE public.profiles SET free_until=clock_timestamp()+interval '4 minutes' WHERE id='${recipient.id}';
            INSERT INTO public.free_end_notification_claims(id,user_id,free_until)
            SELECT '${id}',id,free_until FROM public.profiles WHERE id='${recipient.id}';`);
        } else if(kind==='member_free') {
          table='member_free_notifications';
          stack.query(`UPDATE public.member_free_notifications SET status='cancelled' WHERE status IN ('pending','failed');`);
          await setFree('sender',true);
          id=stack.query(`SELECT id FROM public.member_free_notifications WHERE recipient_user_id='${recipient.id}' AND status='pending';`);
        } else {
          table='chat_message_notifications';
          id=forMessage(messageKey(await send(audience,'authorization fault')))[0].id;
        }
        assert.match(id,/^[0-9a-f-]{36}$/);
        const rpc=(name,body)=>request(config.url,'/rest/v1/rpc/'+name,{method:'POST',jwt:config.service,body,status:200});
        const status=()=>stack.query(`SELECT status FROM public.${table} WHERE id='${id}';`);
        const lease=()=>stack.query(`SELECT lease_token FROM public.${table} WHERE id='${id}' AND status='processing';`);
        const sync=async w=>{
          const start=w.messages.length;
          w.child.send({type:'guard-status'});
          const response=await waitFor(()=>w.messages.slice(start).find(m=>m.type==='guard-status'),'guard flushed IPC',signal);
          assert.equal(response.blocked,0);
        };
        const stop=async w=>assert.equal((await stopIssue36Server(w.child,w.done,w.ended)).code,0);
        const sent=()=>observed.filter(item=>item.data.notificationId===id).map(item=>item.to);
        const dropped=await startServer(true,'',kind,id,'',true);
        const discarded=await waitFor(()=>dropped.messages.find(m=>m.type==='authorization-reply-dropped'),
          'PostgREST authorized delivery but the worker lost the reply',signal);
        await waitFor(()=>status()==='failed','unknown authorization marked failed',signal);
        await sync(dropped);
        assert.deepEqual(sent(),[]);
        await stop(dropped);
        if(kind!=='free_end') stack.query(`UPDATE public.${table} SET next_attempt_at=clock_timestamp() WHERE id='${id}';`);
        const expired=await startServer(true,'',kind,id);
        await waitFor(()=>expired.messages.find(m=>m.type==='authorization-held'),'retry holds before authorization',signal);
        const expiredLease=lease();
        assert.match(expiredLease,/^[0-9a-f-]{36}$/);
        assert.notEqual(expiredLease,discarded.lease);
        stack.query(`UPDATE public.${table} SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='${id}';`);
        const digest=()=>randomBytes(32).toString('hex');
        const nonce=digest();
        const recovery=JSON.parse(stack.query(`SELECT push_private.issue_device_challenge('${victim.installation}',1,'begin_session_logout',decode('${nonce}','hex'));
          SELECT push_private.begin_device_session_logout('${victim.installation}','${recipient.id}','${victim.session}',
            '${randomUUID()}',1,decode('${nonce}','hex'));`).split(/\r?\n/).at(-1));
        await request(config.url,'/auth/v1/logout?scope=local',{method:'POST',jwt:victim.jwt,body:{},status:204});
        for (const purpose of ['confirm','ack']) {
          const attempt=digest();
          stack.query(`SELECT push_private.issue_scoped_logout_recovery_challenge('${victim.installation}',1,'${purpose}',
            '${recovery.recoveryId}',decode('${attempt}','hex'),NULL);
            SELECT push_private.apply_scoped_logout_recovery('${victim.installation}',1,'${purpose}',
            '${recovery.recoveryId}',decode('${attempt}','hex'),NULL);`);
        }
        const replacementJwt=await other.newSession();
        const replacementSession=JSON.parse(Buffer.from(replacementJwt.split('.')[1],'base64url')).session_id;
        const replacementToken=makeToken(), opening=digest();
        fakeTokens.push(replacementToken);
        stack.query(`BEGIN; SET LOCAL ROLE postgres;
          SELECT push_private.issue_device_challenge('${victim.installation}',1,'enroll',decode('${opening}','hex'));
          INSERT INTO public.user_device_tokens(user_id,expo_push_token,platform,installation_id,generation,registration_revision)
          VALUES ('${other.id}',${sqlLiteral(replacementToken)},'android','${victim.installation}',
            push_private.open_device_generation('${victim.installation}','${other.id}','${replacementSession}',1,
              decode('${opening}','hex')),1); COMMIT;`);
        const reclaimed=await startServer(true,'',kind,id);
        await waitFor(()=>reclaimed.messages.find(m=>m.type==='authorization-held'),'new worker reclaimed expired lease',signal);
        const newLease=lease();
        assert.match(newLease,/^[0-9a-f-]{36}$/);
        assert.notEqual(newLease,expiredLease);
        const stale=await rpc('authorize_notification_delivery',{p_kind:kind,p_notification:id,p_lease:expiredLease,p_after:null});
        assert.deepEqual(stale.data,{eligible:false,targets:[],cursor:null});
        expired.child.send({type:'release-final-validate'});
        await stop(expired);
        assert.deepEqual(sent(),[]);
        reclaimed.child.send({type:'release-final-validate'});
        await waitFor(()=>reclaimed.messages.find(m=>m.type==='expo-response-held'),'reclaimed worker reached Expo',signal);
        reclaimed.child.send({type:'release-final-validate'});
        await waitFor(()=>status()==='sent','reclaimed notification completed',signal);
        await sync(reclaimed);
        assert.deepEqual(sent().sort(),[recipient.token,sibling.token].sort());
        assert.equal(stack.query(`SELECT count(*) FROM public.user_device_tokens WHERE expo_push_token=${sqlLiteral(replacementToken)};`),'1');
        await stop(reclaimed);
        stack.query(`BEGIN; SET LOCAL ROLE postgres; DELETE FROM public.user_device_tokens
          WHERE installation_id IN ('${victim.installation}','${sibling.installation}'); COMMIT;`);
      });
    }
    for (const kind of ['free_end','member_free','chat_message']) {
      await runCase(kind+': fence between claim and authorization, then stale Expo ticket',async()=>{
        const recipient=auth.eligible;
        const victim=await managed(recipient,20);
        const other=await managed(recipient,20);
        const rotating=await managed(recipient,20);
        const extras=Array.from({length:100},makeToken);
        fakeTokens.push(...extras);
        stack.query(`INSERT INTO public.user_device_tokens(id,user_id,expo_push_token,platform) VALUES ${extras.map((token,index)=>
          `('ffffffff-ffff-4fff-8fff-${String(index).padStart(12,'0')}','${recipient.id}',${sqlLiteral(token)},'android')`).join(',')};`);
        let id,table,late;
        if(kind==='free_end') {
          table='free_end_notification_claims'; id=randomUUID();
          late=await managed(recipient,0);
          stack.query(`UPDATE public.profiles SET free_until=clock_timestamp()+interval '4 minutes' WHERE id='${recipient.id}';
            INSERT INTO public.free_end_notification_claims(id,user_id,free_until)
            SELECT '${id}',p.id,p.free_until FROM public.profiles p WHERE p.id='${recipient.id}';`);
        } else if(kind==='member_free') {
          table='member_free_notifications';
          stack.query(`UPDATE public.member_free_notifications SET status='cancelled' WHERE status IN ('pending','failed','processing');`);
          await setFree('sender',false); await setFree('sender',true);
          id=stack.query(`SELECT id FROM public.member_free_notifications WHERE recipient_user_id='${recipient.id}' AND status='pending';`);
        } else {
          table='chat_message_notifications';
          id=forMessage(messageKey(await send(audience,'authorization race'))).find(row=>row.recipient_user_id===recipient.id)?.id;
        }
        assert.match(id,/^[0-9a-f-]{36}$/);
        late ??= await managed(recipient,0);
        const w=await startServer(true,'',kind,id,[recipient.token,rotating.token].join(','));
        const has=type=>w.messages.find(message=>message.type===type);
        await waitFor(()=>has('authorization-held'),'claim reached the authorization barrier',signal);
        const lease=stack.query(`SELECT lease_token FROM public.${table} WHERE id='${id}' AND status='processing';`);
        assert.match(lease,/^[0-9a-f-]{36}$/);
        const authorization={p_kind:kind,p_notification:id,p_lease:lease,p_after:null};
        const rpc=(name,body,jwt,status)=>request(config.url,'/rest/v1/rpc/'+name,{method:'POST',jwt,body,status});
        await rpc('authorize_notification_delivery',authorization,recipient.jwt,failureStatuses);
        await request(config.url,'/rest/v1/user_device_tokens?select=expo_push_token',{jwt:config.service,status:403});
        const {data:earlier}=await rpc('authorize_notification_delivery',authorization,config.service,200);
        assert.deepEqual((await rpc('authorize_notification_delivery',{...authorization,p_lease:randomUUID()},config.service,200)).data,
          {eligible:false,targets:[],cursor:null});
        assert.ok(earlier.targets.some(target=>target.token===victim.token));
        assert.ok(!earlier.targets.some(target=>target.token===late.token));
        const digest=randomBytes(32).toString('hex');
        stack.query(`SELECT push_private.issue_device_challenge('${victim.installation}',1,'begin_session_logout',decode('${digest}','hex'));
          SELECT push_private.begin_device_session_logout('${victim.installation}','${recipient.id}','${victim.session}',
            '${randomUUID()}',1,decode('${digest}','hex'));`);
        w.child.send({type:'release-final-validate'});
        await waitFor(()=>has('expo-response-held'),'Expo mock has accepted the authorized batch',signal);
        const newVersion=async()=>stack.query(`SELECT delivery_version FROM public.user_device_tokens WHERE expo_push_token=${sqlLiteral(recipient.token)};`);
        const previous=await newVersion();
        await rpc('upsert_device_token',{p_token:recipient.token,p_platform:'android'},recipient.jwt,[200,204]);
        const updated=await newVersion();
        assert.notEqual(previous,updated);
        stack.query(`BEGIN; SET LOCAL ROLE postgres;
          UPDATE public.user_device_tokens SET registration_revision=2 WHERE installation_id='${rotating.installation}'; COMMIT;`);
        w.child.send({type:'release-final-validate'});
        await waitFor(()=>stack.query(`SELECT status FROM public.${table} WHERE id='${id}';`)==='sent','completion after Expo reply',signal);
        assert.equal(await newVersion(),updated);
        assert.equal(stack.query(`SELECT registration_revision FROM public.user_device_tokens WHERE installation_id='${rotating.installation}';`),'2');
        // The guard flushes queued mock-push records before replying on IPC.
        const auditStart=w.messages.length;
        w.child.send({type:'guard-status'});
        const audit=await waitFor(()=>w.messages.slice(auditStart).find(message=>message.type==='guard-status'),
          'delivery network audit after completion',signal);
        assert.equal(audit.blocked,0);
        const actual=observed.filter(item=>item.data.notificationId===id).map(item=>item.to);

        console.log(JSON.stringify({
          kind,
          expected:103,
          actual:actual.length,
          unique:new Set(actual).size,
          missingExtras:extras.filter(token=>!actual.includes(token)).length
        }));

        assert.ok(actual.includes(other.token));
        assert.ok(extras.every(token=>actual.includes(token)));
        assert.equal(new Set(actual).size,103);
        assert.ok(!actual.includes(victim.token)&&!actual.includes(late.token));
        assert.equal((await stopIssue36Server(w.child,w.done,w.ended)).code,0);
        stack.query(`BEGIN; SET LOCAL ROLE postgres;
          DELETE FROM public.user_device_tokens WHERE installation_id IN ('${other.installation}','${late.installation}','${rotating.installation}')
            OR id::text LIKE 'ffffffff-ffff-4fff-8fff-%'; COMMIT;`);
      });
    }
  } finally {
    directAgent.destroy();
    const results=await Promise.all(servers.map(({child,done,ended})=>stopIssue36Server(child,done,ended)));
    try {
      await stack.stop();
    } finally {
      process.removeListener('SIGINT',terminate);
      process.removeListener('SIGTERM',terminate);
    }
    console.log('Issue #36: owned test processes and Docker resources removed');
    for(const result of results) assert.equal(result.code,0,'Graceful worker/Express shutdown');
  }
});
