import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { Agent, request } from 'node:http';
import { test } from 'node:test';
import { createStack, waitFor } from './helpers/issue36-stack.mjs';

const quoted = value => "'" + value.replaceAll("'", "''") + "'";
const nonce = () => `decode('${randomBytes(32).toString('hex')}','hex')`;
const verifier = sql => `BEGIN; SET LOCAL ROLE imahima_device_verifier; ${sql}; COMMIT;`;

test('managed registration serializes with fencing and Auth revocation', {timeout:240000}, async t => {
  const stack = createStack(t.signal, {allowSignup:true});
  const agent = new Agent({proxyEnv:{}});
  const sessions = [];
  function session() {
    const child = stack.openSqlSession();
    const result = {child, stdout:'', stderr:''};
    child.stdout.on('data', chunk => {result.stdout += chunk;});
    child.stderr.on('data', chunk => {result.stderr += chunk;});
    child.stdin.on('error', () => {});
    result.done = new Promise((resolve,reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    sessions.push(result);
    return result;
  }

  try {
    const gateway = await stack.start();
    stack.verifyIdentity();
    function authPost(path, body, jwt) {
      const url = new URL('/auth/v1/' + path, gateway.url);
      assert.equal(url.hostname,'127.0.0.1');
      assert.equal(url.origin,gateway.url);
      return new Promise((resolve,reject) => {
        const req = request(url,{agent,method:'POST',signal:AbortSignal.any([t.signal,AbortSignal.timeout(15000)]),
          headers:{apikey:gateway.anon,'content-type':'application/json',...(jwt ? {authorization:'Bearer '+jwt} : {})}},res => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data',chunk => {data += chunk;});
          res.on('error',reject);
          res.on('end',() => {
            try { resolve({status:res.statusCode, data:data ? JSON.parse(data) : null}); }
            catch (error) { reject(error); }
          });
        });
        req.on('error',reject);
        req.end(JSON.stringify(body));
      });
    }
    async function account() {
      const credentials = {email:randomUUID()+'@example.invalid',password:randomBytes(24).toString('hex')};
      const {status,data} = await authPost('signup',credentials);
      assert.equal(status,200);
      const sibling = await authPost('token?grant_type=password',credentials);
      assert.equal(sibling.status,200);
      return {jwt:data.access_token,siblingJwt:sibling.data.access_token};
    }
    function fixture(jwt) {
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1],'base64url'));
      const installation = quoted(randomUUID());
      const user = quoted(claims.sub);
      const authSession = quoted(claims.session_id);
      const registerOp = quoted(randomUUID());
      const fenceOp = quoted(randomUUID());
      const token = quoted('test-device-'+randomUUID());
      const enroll = nonce(), register = nonce(), fence = nonce(), lookup = nonce();
      assert.equal(stack.query(`SELECT count(*) FROM auth.sessions WHERE id=${authSession} AND user_id=${user};`),'1');
      stack.query(`BEGIN; SET LOCAL ROLE postgres; DO $$ BEGIN
        PERFORM push_private.enroll_device_installation(${installation},decode('04','hex'));
      END $$; COMMIT;`);
      const generation = stack.query(verifier(`DO $$ BEGIN
        PERFORM push_private.issue_bounded_device_challenge(${installation},1,'enroll',${enroll});
        PERFORM push_private.issue_bounded_device_challenge(${installation},1,'register',${register});
        PERFORM push_private.issue_bounded_device_challenge(${installation},1,'fence',${fence});
        PERFORM push_private.issue_bounded_device_challenge(${installation},1,'lookup',${lookup});
      END $$;
      SELECT push_private.open_device_generation(${installation},${user},${authSession},1,${enroll})`));
      assert.match(generation,/^[1-9]\d*$/);
      const common = `${installation},${user},${authSession},${generation}`;
      const requests = {
        register: `SELECT push_private.register_device_v2(${common},${registerOp},1,${register},${token},'ios');`,
        fence: `SELECT push_private.fence_device_registration(${common},${fenceOp},1,${fence});`,
      };
      const resultFor = op => JSON.parse(stack.query(verifier(`SELECT coalesce(push_private.get_device_operation(
        ${common},${op},1,${lookup}),'null'::jsonb)`)));
      return {common, installation, authSession, generation, token, registerOp, fenceOp, register, requests, resultFor};
    }

    for(const first of ['register','fence']){
      const {jwt} = await account();
      const {generation, token, registerOp, fenceOp, requests, resultFor} = fixture(jwt);
      const holder = session();
      holder.child.stdin.write(`BEGIN; SET LOCAL ROLE imahima_device_verifier; ${requests[first]}\n\\echo holder-ready\n`);
      await waitFor(()=>holder.stdout.includes('holder-ready'),'first operation holding installation lock',t.signal);

      const waiter = session();
      const app = quoted('device-race-'+randomUUID());
      const second = first === 'register' ? 'fence' : 'register';
      waiter.child.stdin.end(`SET application_name=${app}; BEGIN; SET LOCAL ROLE imahima_device_verifier; ${requests[second]} COMMIT;\n`);
      await waitFor(()=>stack.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE application_name=${app} AND cardinality(pg_blocking_pids(pid))>0);`)==='t',
      'second operation blocked by the first transaction',t.signal);

      // Do not give the first result to a caller. Re-read the durable result
      // from a different session after both transactions have settled.
      holder.child.stdin.end('COMMIT;\n');
      assert.equal(await holder.done,0);
      const status = await waiter.done;
      if(second==='register'){
        assert.equal(status,3);
        assert.match(waiter.stderr,/Generation is fenced/);
      }else assert.equal(status,0);
      const op = first==='register' ? registerOp : fenceOp;
      const recovered = resultFor(op);
      assert.equal(recovered.generation,generation);
      assert.equal(first==='register' ? recovered.registered : recovered.fenced,true);
      assert.equal(stack.query(`SELECT count(*) FROM public.user_device_tokens WHERE expo_push_token=${token};`),'0');
    }

    await t.test('Auth revocation first rejects a late registration without mutating it or a sibling device', async () => {
      const {jwt,siblingJwt} = await account();
      const actor = fixture(jwt);
      const sibling = fixture(siblingJwt);
      stack.query(verifier(sibling.requests.register));
      assert.equal((await authPost('logout?scope=local',{},jwt)).status,204);
      assert.equal(stack.query(`SELECT count(*) FROM auth.sessions WHERE id=${actor.authSession};`),'0');
      assert.throws(() => stack.query(verifier(actor.requests.register)),/Session is unavailable/);
      assert.equal(actor.resultFor(actor.registerOp),null);
      assert.equal(stack.query(`SELECT consumed_at IS NULL FROM push_private.device_challenges
        WHERE challenge_digest=${actor.register};`),'t');
      assert.equal(stack.query(`SELECT count(*) FROM public.user_device_tokens WHERE expo_push_token=${actor.token};`),'0');
      assert.equal(stack.query(`SELECT count(*) FROM auth.sessions WHERE id=${sibling.authSession};`),'1');
      assert.equal(stack.query(`SELECT count(*) FROM public.user_device_tokens WHERE expo_push_token=${sibling.token};`),'1');
    });

    await t.test('registration first holds the Auth row until commit and preserves the recorded reply', async () => {
      const {jwt,siblingJwt} = await account();
      const actor = fixture(jwt);
      const sibling = fixture(siblingJwt);
      stack.query(verifier(sibling.requests.register));
      const holder = session();
      holder.child.stdin.write(`BEGIN; SET LOCAL ROLE imahima_device_verifier; SELECT pg_backend_pid();
        ${actor.requests.register}\n\\echo registration-held\n`);
      const observing = new AbortController();
      let revocation;
      try {
        await waitFor(() => holder.stdout.includes('registration-held'),'registration holding its transaction',t.signal);
        const pid = Number(holder.stdout.match(/^\d+\s*$/m)?.[0]);
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        revocation = authPost('logout?scope=local',{},jwt);
        await Promise.race([
          waitFor(() => stack.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE usename='supabase_auth_admin' AND ${pid}=ANY(pg_blocking_pids(pg_stat_activity.pid))); `)==='t',
          'GoTrue waiting on registration',AbortSignal.any([t.signal,observing.signal])),
          revocation.then(result => assert.fail('GoTrue returned before registration committed: '+result.status)),
        ]);
      } finally {
        observing.abort();
        holder.child.stdin.end('COMMIT;\n');
        assert.equal(await holder.done,0);
        if (revocation) assert.equal((await revocation).status,204);
      }
      const committed = actor.resultFor(actor.registerOp);
      assert.deepEqual(committed,{registered:true,generation:actor.generation,revision:'1'});
      const replay = nonce();
      const repeated = JSON.parse(stack.query(verifier(`DO $$ BEGIN
        PERFORM push_private.issue_bounded_device_challenge(${actor.installation},1,'register',${replay});
      END $$;
      SELECT push_private.register_device_v2(${actor.common},${actor.registerOp},1,${replay},${actor.token},'ios')`)));
      assert.deepEqual(repeated,committed);
      assert.equal(stack.query(`SELECT registration_revision FROM public.user_device_tokens WHERE expo_push_token=${actor.token};`),'1');
      assert.equal(stack.query(`SELECT count(*) FROM auth.sessions WHERE id=${actor.authSession};`),'0');
      assert.equal(stack.query(`SELECT count(*) FROM auth.sessions WHERE id=${sibling.authSession};`),'1');
      assert.equal(stack.query(`SELECT count(*) FROM public.user_device_tokens WHERE expo_push_token=${sibling.token};`),'1');
    });
  } finally {
    agent.destroy();
    for(const {child} of sessions) if(child.exitCode===null) child.kill();
    await Promise.allSettled(sessions.map(({done})=>done));
    await stack.stop();
  }
});
