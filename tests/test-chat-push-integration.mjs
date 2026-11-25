import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { cleanEnv, createStack, waitFor } from './helpers/issue36-stack.mjs';
import { stopIssue36Server } from './helpers/issue36-process.mjs';

const cwd = new URL('../', import.meta.url);
const sqlLiteral = text => "'" + text.replaceAll("'", "''") + "'";
const failureStatuses = [401,403];

test('Issue #36: real Supabase and Express to mocked Expo', {timeout:240000}, async t => {
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
      auth[name]={id:user.id,jwt:session.access_token,token};
    }
    async function startServer(worker, barrierId='') {
      const messages=[];
      // Pass only OS essentials, never parent DB settings, preloads or credentials.
      const child=spawn(process.execPath,['--require','./tests/issue36-chat-push-guard.cjs','--import','tsx','server/index.ts'],{
        cwd,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],
        env:{...cleanEnv,DOTENV_CONFIG_PATH:process.platform==='win32'?'NUL':'/dev/null',DOTENV_CONFIG_QUIET:'true',
          HOST:'127.0.0.1',PORT:'0',SUPABASE_URL:config.url,SUPABASE_SERVICE_ROLE_KEY:config.service,
          ISSUE36_GATEWAY:config.url,ISSUE36_FAKE_TOKENS:JSON.stringify(fakeTokens),ISSUE36_BARRIER_ID:barrierId,
          ISSUE36_SKIP_FINAL_VALIDATE:process.env.ISSUE36_SKIP_FINAL_VALIDATE==='1'?'1':'0',
          ISSUE36_DELAY_MOCK_IPC:process.env.ISSUE36_DELAY_MOCK_IPC==='1'?'1':'0',
          EXPO_ACCESS_TOKEN:'',EXPO_BASE_URL:'https://exp.host',FREE_END_NOTIFICATIONS_ENABLED:'false',
          MEMBER_FREE_NOTIFICATIONS_ENABLED:'false',CHAT_MESSAGE_NOTIFICATIONS_ENABLED:String(worker),
          CHAT_MESSAGE_NOTIFICATIONS_INTERVAL_MS:'1000',GROUP_RATE_SECRET:randomBytes(24).toString('hex')},
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
        sawWorker ||= String(chunk).includes('Chat message notification poller started');
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
    const raceId=forMessage(old.race)[0].id;
    const worker=await startServer(true,raceId);
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
        '/rest/v1/rpc/complete_chat_message_notification']){
        assert.ok(config.traffic.get(path+' 200')>0,`Missing real upstream success: ${path}`);
      }
      assert.ok(config.traffic.get('/rest/v1/rpc/validate_chat_message_notification 200') >= good.size*2+2);
      assert.equal(config.traffic.get('/rest/v1/rpc/complete_chat_message_notification 200'),good.size);
      console.log(JSON.stringify({isolatedServices:['PostgreSQL 17','GoTrue','PostgREST','Express','chat Push worker'],
        mockedExpoSends:observed.length,externalNetworkAttempts:0,loaderIpcBlocked,guardRejectionProbesPassed:true,
        sharedDatabaseConnections:0,terminalOutboxRows:finalRows.length}));
    });
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
