import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createStack, waitFor } from './helpers/issue36-stack.mjs';

const quoted = value => "'" + value.replaceAll("'", "''") + "'";
const nonce = () => `decode('${randomBytes(32).toString('hex')}','hex')`;
const verifier = sql => `BEGIN; SET LOCAL ROLE imahima_device_verifier; ${sql}; COMMIT;`;

test('registration and fencing serialize in either order on the installation lock', {timeout:180000}, async t => {
  const stack = createStack(t.signal);
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
    await stack.start();
    for(const first of ['register','fence']){
      const installation = quoted(randomUUID());
      const user = quoted(randomUUID());
      const authSession = quoted(randomUUID());
      const registerOp = quoted(randomUUID());
      const fenceOp = quoted(randomUUID());
      const token = quoted('test-device-'+randomUUID());
      const enroll = nonce(), register = nonce(), fence = nonce(), lookup = nonce();
      stack.query(`INSERT INTO auth.users(id) VALUES(${user});`);
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
      const recovered = JSON.parse(stack.query(verifier(`SELECT push_private.get_device_operation(
        ${installation},${user},${generation},${op},1,${lookup})`)));
      assert.equal(recovered.generation,generation);
      assert.equal(first==='register' ? recovered.registered : recovered.fenced,true);
      assert.equal(stack.query(`SELECT count(*) FROM public.user_device_tokens WHERE expo_push_token=${token};`),'0');
    }
  } finally {
    for(const {child} of sessions) if(child.exitCode===null) child.kill();
    await Promise.allSettled(sessions.map(({done})=>done));
    await stack.stop();
  }
});
