import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { Agent, request } from 'node:http';
import { test } from 'node:test';
import { createStack, waitFor } from './helpers/issue36-stack.mjs';

const quoted = value => "'" + value.replaceAll("'", "''") + "'";
const nonce = () => `decode('${randomBytes(32).toString('hex')}','hex')`;
const deviceRole = 'imahima_device_verifier';
const recoveryRole = 'imahima_logout_recovery_verifier';
const asRole = (role, sql) => `BEGIN; SET LOCAL ROLE ${role}; ${sql}; COMMIT;`;

test('durable logout recovery survives lost results and serializes account switching', { timeout: 180000 }, async t => {
  const stack = createStack(t.signal, { allowSignup: true, migrationThrough: '20261207000000' });
  const agent = new Agent({ proxyEnv: {} });
  const sessions = [];
  try {
    const gateway = await stack.start();
    const goTrue = (path, body, access = gateway.anon) => new Promise((resolve, reject) => {
      const url = new URL('/auth/v1/' + path, gateway.url);
      assert.equal(url.origin, gateway.url);
      assert.equal(url.hostname, '127.0.0.1');
      const req = request(url, {
        method: 'POST', agent, signal: t.signal,
        headers: { authorization: 'Bearer ' + access, apikey: gateway.anon, 'content-type': 'application/json' },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    function identity(body) {
      const { access_token: access } = JSON.parse(body);
      const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url'));
      return { access, user: quoted(claims.sub), session: quoted(claims.session_id) };
    }
    async function signup() {
      const credentials = { email: `recovery-${randomUUID()}@example.com`, password: randomBytes(24).toString('hex') };
      const reply = await goTrue('signup', credentials);
      assert.equal(reply.status, 200);
      return { ...identity(reply.body), credentials };
    }
    const a = await signup();
    const b = await signup();
    const passwordReply = await goTrue('token?grant_type=password', a.credentials);
    assert.equal(passwordReply.status, 200);
    const otherSession = identity(passwordReply.body);
    assert.notEqual(a.session, otherSession.session);
    const installation = quoted(randomUUID());
    const otherInstallation = quoted(randomUUID());
    stack.query(`SELECT push_private.enroll_device_installation(${installation},decode('04','hex')),
      push_private.enroll_device_installation(${otherInstallation},decode('04','hex'));`);
    const execute = (role, sql) => stack.query(asRole(role, sql));
    function issueDevice(purpose, target = installation) {
      const digest = nonce();
      execute(deviceRole, `SELECT push_private.issue_bounded_device_challenge(${target},1,'${purpose}',${digest})`);
      return digest;
    }
    const open = (actor, digest, target = installation) =>
      `SELECT push_private.open_device_generation(${target},${actor.user},${actor.session},1,${digest})`;
    const generation = execute(deviceRole, open(a, issueDevice('enroll')));
    assert.match(generation, /^[1-9]\d*$/);
    const token = quoted(`ExpoPushToken[isolated_${randomUUID()}]`);
    const registerOperation = quoted(randomUUID());
    execute(deviceRole, `SELECT push_private.register_device_v2(${installation},${a.user},${a.session},
      ${generation},${registerOperation},1,${issueDevice('register')},${token},'ios')`);
    const operation = quoted(randomUUID());
    const begin = (actor, op, digest, target = installation, selected = generation) =>
      `SELECT push_private.begin_device_logout(${target},${actor.user},${actor.session},${selected},${op},1,${digest})`;
    const denied = /is unavailable|is pending/;
    assert.throws(() => execute(deviceRole, begin(otherSession, operation, issueDevice('begin_logout'))), denied);
    assert.throws(() => execute(deviceRole, begin(b, operation, issueDevice('begin_logout'))), denied);

    const beginNonce = issueDevice('begin_logout');
    stack.query(`CREATE FUNCTION push_private.test_begin_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind='begin_logout' THEN RAISE EXCEPTION 'fixture abort'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_begin_rollback BEFORE INSERT ON push_private.operations
      FOR EACH ROW EXECUTE FUNCTION push_private.test_begin_rollback();`);
    assert.throws(() => execute(deviceRole, begin(a, operation, beginNonce)), /fixture abort/);
    assert.equal(stack.query(`SELECT fenced_at IS NULL,(SELECT count(*) FROM public.user_device_tokens
      WHERE installation_id=${installation}),(SELECT count(*) FROM push_private.logout_recoveries
      WHERE installation_id=${installation}) FROM push_private.installation_bindings
      WHERE installation_id=${installation} AND generation=${generation};`), 't|1|0');
    stack.query('DROP TRIGGER test_begin_rollback ON push_private.operations;');

    function sqlSession() {
      const child = stack.openSqlSession();
      const result = { child, output: '', error: '' };
      child.stdout.on('data', chunk => { result.output += chunk; });
      child.stderr.on('data', chunk => { result.error += chunk; });
      child.stdin.on('error', () => {});
      result.closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      sessions.push(result);
      return result;
    }
    const switchProof = issueDevice('enroll');
    const holder = sqlSession();
    holder.child.stdin.write(`BEGIN; SET LOCAL ROLE ${deviceRole}; ${begin(a, operation, beginNonce)};\n\\echo fenced\n`);
    await waitFor(() => holder.output.includes('fenced'), 'logout locked the installation', t.signal);
    const waiter = sqlSession();
    const waiterName = quoted('logout-race-' + randomUUID());
    waiter.child.stdin.end(`SET application_name=${waiterName}; ${asRole(deviceRole, open(b, switchProof))}\n`);
    await waitFor(() => stack.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE application_name=${waiterName} AND cardinality(pg_blocking_pids(pid))>0);`) === 't',
    'new account waits for the installation lock', t.signal);
    holder.child.stdin.end('COMMIT;\n');
    assert.equal(await holder.closed, 0);
    assert.equal(await waiter.closed, 3);
    assert.match(waiter.error, denied);

    // Read before retry: a post-retry row count cannot prove receipt identity.
    const committedId = stack.query(`SELECT recovery_id FROM push_private.logout_recoveries
      WHERE installation_id=${installation};`);
    assert.match(committedId, /^[0-9a-f-]{36}$/);
    // The committed first reply was ignored. Reacquire the same opaque ID.
    const started = JSON.parse(execute(deviceRole, begin(a, operation, issueDevice('begin_logout'))));
    assert.equal(started.recoveryId, committedId);
    const recovery = quoted(started.recoveryId);
    assert.equal(stack.query(`SELECT count(*) FROM public.user_device_tokens WHERE installation_id=${installation};`), '0');
    assert.equal(stack.query(`SELECT count(*) FROM push_private.logout_recoveries WHERE installation_id=${installation};`), '1');
    assert.throws(() => execute(deviceRole, begin(a, registerOperation, issueDevice('begin_logout'))), /Operation ID reused/);

    const issueRecovery = (purpose, target = recovery, install = installation, version = 1) => {
      const digest = nonce();
      execute(recoveryRole, `SELECT push_private.issue_logout_recovery_challenge(${install},${version},'${purpose}',${target},${digest})`);
      return digest;
    };
    const apply = (purpose, target, digest) =>
      `SELECT push_private.apply_logout_recovery(${installation},1,'${purpose}',${target},${digest})`;
    const run = (purpose, target = recovery, digest = issueRecovery(purpose, target)) =>
      JSON.parse(execute(recoveryRole, apply(purpose, target, digest)));
    const assertState = (result, status) => assert.deepEqual(result, { recoveryId: started.recoveryId, status });
    assertState(run('discover', 'NULL'), 'pending');
    const discoveryProof = issueRecovery('discover', 'NULL');
    assert.throws(() => run('discover', recovery, discoveryProof), denied);
    assertState(run('discover', 'NULL', discoveryProof), 'pending');
    assert.throws(() => issueRecovery('confirm', recovery, otherInstallation), denied);
    assert.throws(() => issueRecovery('confirm', recovery, installation, 2), denied);
    const singleUse = issueRecovery('confirm');
    assert.throws(() => run('ack', recovery, singleUse), denied);
    stack.query(`UPDATE push_private.logout_recoveries SET issued_at=clock_timestamp()-interval '3 years'
      WHERE recovery_id=${recovery};`);
    assertState(run('confirm', recovery, singleUse), 'pending');
    assert.throws(() => run('confirm', recovery, singleUse), denied);
    assert.throws(() => run('ack'), denied);
    const expired = issueRecovery('discover', 'NULL');
    stack.query(`UPDATE push_private.logout_recovery_challenges SET expires_at=clock_timestamp()-interval '1 second'
      WHERE digest=${expired};`);
    assert.throws(() => run('discover', 'NULL', expired), denied);

    const activeRead = issueRecovery('confirm');
    stack.query(`CREATE ROLE logout_no_auth_reader NOLOGIN;
      GRANT USAGE ON SCHEMA push_private TO logout_no_auth_reader;
      ALTER FUNCTION push_private.auth_session_present(uuid,uuid) OWNER TO logout_no_auth_reader;
      GRANT EXECUTE ON FUNCTION push_private.auth_session_present(uuid,uuid) TO postgres;`);
    try {
      assert.throws(() => run('confirm', recovery, activeRead), /Session cannot be verified/);
      assertState(run('discover', 'NULL'), 'pending');
    } finally {
      stack.query('ALTER FUNCTION push_private.auth_session_present(uuid,uuid) OWNER TO postgres;');
    }
    assertState(run('confirm', recovery, activeRead), 'pending'); // rollback kept the nonce valid
    assert.equal((await goTrue('logout?scope=local', undefined, a.access)).status, 204);
    assert.equal(stack.query(`SELECT EXISTS(SELECT 1 FROM auth.sessions WHERE id=${otherSession.session});`), 't');
    execute(recoveryRole, apply('confirm', recovery, issueRecovery('confirm'))); // discard committed result
    assertState(run('discover', 'NULL'), 'confirmed');
    assert.throws(() => execute(deviceRole, open(b, switchProof)), /Previous logout is pending/);
    execute(recoveryRole, apply('ack', recovery, issueRecovery('ack'))); // discard committed acknowledgement
    assertState(run('ack'), 'cleared');
    const staleDiscovery = issueRecovery('discover', 'NULL');
    const newGeneration = execute(deviceRole, open(b, switchProof));
    assert.ok(BigInt(newGeneration) > BigInt(generation));
    assert.throws(() => issueRecovery('discover', 'NULL'), denied);
    assert.throws(() => run('discover', 'NULL', staleDiscovery), denied);
    execute(deviceRole, `SELECT push_private.register_device_v2(${installation},${b.user},${b.session},
      ${newGeneration},${quoted(randomUUID())},1,${issueDevice('register')},${token},'ios')`);
    assertState(run('confirm'), 'cleared');
    assertState(run('ack'), 'cleared');
    assert.equal(stack.query(`SELECT count(*) FROM public.user_device_tokens
      WHERE installation_id=${installation} AND generation=${newGeneration} AND user_id=${b.user} AND expo_push_token=${token};`), '1');
    assert.throws(() => execute(deviceRole, begin(otherSession, quoted(randomUUID()), issueDevice('begin_logout'))), denied);

    const legacyGeneration = execute(deviceRole, open(otherSession, issueDevice('enroll', otherInstallation), otherInstallation));
    execute(deviceRole, `SELECT push_private.fence_device_registration(${otherInstallation},${a.user},${otherSession.session},
      ${legacyGeneration},${quoted(randomUUID())},1,${issueDevice('fence', otherInstallation)})`);
    assert.throws(() => execute(deviceRole, begin(b, quoted(randomUUID()), issueDevice('begin_logout', otherInstallation),
      otherInstallation, legacyGeneration)), denied);
    const reauthReply = await goTrue('token?grant_type=password', a.credentials);
    assert.equal(reauthReply.status, 200);
    const reauth = identity(reauthReply.body);
    const legacy = JSON.parse(execute(deviceRole, begin(reauth, quoted(randomUUID()), issueDevice('begin_logout', otherInstallation),
      otherInstallation, legacyGeneration)));
    assert.match(legacy.recoveryId, /^[0-9a-f-]{36}$/);

    assert.equal(stack.query(`SELECT
      has_function_privilege('${recoveryRole}','push_private.lock_device_verification_key(uuid)','EXECUTE'),
      has_function_privilege('${recoveryRole}','push_private.auth_session_present(uuid,uuid)','EXECUTE'),
      has_function_privilege('${recoveryRole}','push_private.open_device_generation(uuid,uuid,uuid,bigint,bytea)','EXECUTE'),
      has_table_privilege('${recoveryRole}','auth.sessions','SELECT'),
      has_table_privilege('${recoveryRole}','push_private.logout_recoveries','SELECT'),
      has_function_privilege('${deviceRole}','push_private.apply_logout_recovery(uuid,bigint,text,uuid,bytea)','EXECUTE'),
      has_function_privilege('authenticated','push_private.apply_logout_recovery(uuid,bigint,text,uuid,bytea)','EXECUTE'),
      has_function_privilege('anon','push_private.apply_logout_recovery(uuid,bigint,text,uuid,bytea)','EXECUTE'),
      EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid='${recoveryRole}'::regrole
        AND (member<>'postgres'::regrole OR NOT admin_option OR set_option OR inherit_option));`),
    't|f|f|f|f|f|f|f|f');
  } finally {
    agent.destroy();
    for (const { child } of sessions) if (child.exitCode === null) child.kill();
    await Promise.allSettled(sessions.map(({ closed }) => closed));
    await stack.stop();
  }
});
