import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { Agent, request } from 'node:http';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { createApp } from '../server/app.ts';
import { createDeviceVerifierPool, deviceSigningBytes, deviceVerifierRouter } from '../server/device-verifier.ts';
import { createStack, waitFor } from './helpers/issue36-stack.mjs';

function makeKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const point = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-65).toString('base64url');
  return { ...pair, point };
}

function isolatedFetch(origin, agent) {
  return (input, init) => {
    const endpoint = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (endpoint.origin !== origin || endpoint.hostname !== '127.0.0.1') throw Error('Unexpected network origin');
    return new Promise((resolve, reject) => {
      const req = request(endpoint, {
        agent, method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers)), signal: init?.signal,
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          reject(new Error('Redirect from isolated HTTP endpoint'));
          return;
        }
        const parts = [];
        res.on('data', chunk => parts.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve(new Response(
          res.statusCode === 204 ? null : Buffer.concat(parts), { status: res.statusCode, headers: res.headers },
        )));
      });
      req.on('error', reject);
      req.end(init?.body);
    });
  };
}

test('isolated GoTrue, Express and PostgreSQL verify device ownership without exposing RPCs to PostgREST', {
  timeout: 180000,
}, async t => {
  const stack = createStack(t.signal, { allowSignup: true });
  const agent = new Agent({ proxyEnv: {} });
  let server, pool;
  try {
    const gateway = await stack.start();
    const password = randomBytes(24).toString('hex');
    stack.query(`CREATE ROLE imahima_device_api_login LOGIN NOINHERIT PASSWORD '${password}';
      GRANT imahima_device_verifier TO imahima_device_api_login WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;`);
    const relay = await stack.openPostgresRelay();
    pool = createDeviceVerifierPool(`postgresql://imahima_device_api_login:${password}@127.0.0.1:${relay.port}/postgres?sslmode=disable&application_name=device-proof-test`);
    const preflight = await pool.query('SELECT session_user').catch(error => {
      throw new Error(`Dedicated DB relay connection failed (${error.code ?? 'no SQLSTATE'})`);
    });
    assert.equal(preflight.rows[0].session_user, 'imahima_device_api_login');
    const localFetch = origin => isolatedFetch(origin, agent);
    const auth = createClient(gateway.url, gateway.anon, {
      global: { fetch: localFetch(gateway.url) }, auth: { persistSession: false, autoRefreshToken: false },
    });
    async function signup() {
      const email = `device-${randomUUID()}@example.com`;
      const userPassword = randomBytes(24).toString('hex');
      const { data, error } = await auth.auth.signUp({ email, password: userPassword });
      assert.equal(Boolean(error), false);
      assert.ok(data.session);
      return { email, userPassword, access: data.session.access_token };
    }
    const first = await signup();
    const second = await signup();
    const issuer = 'http://127.0.0.1/auth/v1';
    assert.equal(deviceSigningBytes(['あ', '', 'A', null]).toString('utf8'),
      '23:imahima-device-proof-v13:あ0:1:A-:');
    const router = deviceVerifierRouter(pool, issuer, token => auth.auth.getClaims(token));
    server = createApp({}, undefined, undefined, undefined, undefined, router).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    async function post(action, body, status = 200, access = first.access) {
      const response = await localFetch(origin)(origin + '/device-recovery/' + action, {
        method: 'POST', headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (status !== null) assert.equal(response.status, status, action);
      return { status: response.status, ...result };
    }
    const key = makeKey();
    const foreignKey = makeKey();
    const installationId = randomUUID();
    const base = { installationId, keyVersion: '1' };
    function signed(action, body, signingKey = key, access = first.access) {
      const jwt = JSON.parse(Buffer.from(access.split('.')[1], 'base64url'));
      const bytes = deviceSigningBytes([issuer, jwt.sub, jwt.session_id, body.installationId, action,
        action === 'challenge' ? body.purpose : action, body.keyVersion ?? '1', body.generation ?? null,
        body.operationId ?? null, body.nonce, body.token ?? null, body.platform ?? null,
        body.deviceName ?? null, body.publicKey ?? null]);
      return { ...body, signature: sign('sha256', bytes, {
        key: signingKey.privateKey, dsaEncoding: 'ieee-p1363',
      }).toString('base64url') };
    }
    const enroll = { installationId, publicKey: key.point };
    const { nonce } = await post('enrollment-challenge', enroll);
    const initial = signed('enroll-installation', { ...enroll, nonce });
    await post('enroll-installation', { ...initial, publicKey: foreignKey.point }, 403);
    await post('enroll-installation', signed('enroll-installation', { ...enroll, nonce }, key, second.access), 403, second.access);
    const consume = await Promise.all([post('enroll-installation', initial, null), post('enroll-installation', initial, null)]);
    assert.deepEqual(consume.map(value => value.status).sort(), [200, 403]);
    const retry = await post('enrollment-challenge', enroll);
    assert.equal((await post('enroll-installation', signed('enroll-installation', { ...enroll, nonce: retry.nonce }))).keyVersion, '1');
    const replace = { installationId, publicKey: foreignKey.point };
    const replacement = await post('enrollment-challenge', replace);
    await post('enroll-installation', signed('enroll-installation', { ...replace, nonce: replacement.nonce }, foreignKey), 403);
    assert.equal(stack.query(`SELECT count(*) FROM push_private.installations WHERE installation_id='${installationId}';`), '1');
    const contested = randomUUID();
    const competing = await Promise.all([key, foreignKey].map(async candidate => {
      const input = { installationId: contested, publicKey: candidate.point };
      const reply = await post('enrollment-challenge', input, 200, second.access);
      return signed('enroll-installation', { ...input, nonce: reply.nonce }, candidate, second.access);
    }));
    const winners = await Promise.all(competing.map(input => post('enroll-installation', input, null, second.access)));
    assert.deepEqual(winners.map(value => value.status).sort(), [200, 403]);

    async function challenge(purpose, access = first.access) {
      return (await post('challenge', signed('challenge', {
        ...base, purpose, nonce: randomBytes(32).toString('base64url'),
      }, key, access), 200, access)).nonce;
    }
    await post('challenge', signed('challenge', { ...base, purpose: 'register', nonce }, foreignKey), 403);
    const open = signed('enroll', { ...base, nonce: await challenge('enroll') });
    const generation = (await post('enroll', open)).result;
    await post('enroll', open, 403);
    const operationId = randomUUID();
    const register = { ...base, generation, operationId, token: 'ExpoPushToken[isolated_test]', platform: 'ios', deviceName: '端末' };
    const good = signed('register', { ...register, nonce: await challenge('register') });
    await post('register', { ...good, operationId: randomUUID() }, 403);
    await post('register', { ...good, generation: '2' }, 403);
    await post('register', { ...good, token: 'ExpoPushToken[other]' }, 403);
    await post('register', { ...good, deviceName: 'e\u0301' }, 400);
    await post('register', { ...good, signature: 'bad!' }, 400);
    await post('register', good, 403, second.access);
    await post('register', signed('register', { ...register, nonce: await challenge('lookup') }), 403);
    const secondSession = await auth.auth.signInWithPassword({ email: first.email, password: first.userPassword });
    assert.ok(secondSession.data.session);
    const unrelatedSession = secondSession.data.session.access_token;
    const otherSessionProof = signed('register', { ...register, nonce: good.nonce }, key, unrelatedSession);
    await post('register', otherSessionProof, 403, unrelatedSession);
    await post('register', good);
    const lookup = signed('lookup', { ...base, generation, operationId, nonce: await challenge('lookup') });
    assert.equal((await post('lookup', lookup)).result.registered, true);
    const fence = signed('fence', { ...base, generation, operationId: randomUUID(), nonce: await challenge('fence') });
    assert.equal((await post('fence', fence)).result.fenced, true);
    await post('register', signed('register', { ...register, operationId: randomUUID(), nonce: await challenge('register') }), 403);

    const expired = await challenge('lookup');
    const expiredDigest = createHash('sha256').update(Buffer.from(expired, 'base64url')).digest('hex');
    stack.query(`UPDATE push_private.device_challenges SET issued_at=clock_timestamp()-interval '2 seconds',
      expires_at=clock_timestamp()-interval '1 second'
      WHERE challenge_digest=decode('${expiredDigest}','hex');`);
    await post('lookup', signed('lookup', { ...base, generation, operationId, nonce: expired }), 403);

    const badKey = { ...enroll, publicKey: Buffer.alloc(65, 4).toString('base64url') };
    await post('enrollment-challenge', badKey, 400);
    await post('enrollment-challenge', { ...enroll, extra: 'x'.repeat(4500) }, 413);
    await post('enrollment-challenge', enroll, 401, 'invalid.jwt.token');
    const [jwtHeader, jwtBody] = first.access.split('.');
    const foreign = `${jwtHeader}.${jwtBody}.${createHmac('sha256', randomBytes(32))
      .update(jwtHeader + '.' + jwtBody).digest('base64url')}`;
    await post('enrollment-challenge', enroll, 401, foreign);
    const firstClaims = JSON.parse(Buffer.from(jwtBody, 'base64url'));
    const badIssuer = gateway.testJwt('authenticated', { ...firstClaims, iss: 'http://127.0.0.2/auth/v1' });
    const expiredJwt = gateway.testJwt('authenticated', { ...firstClaims, exp: Math.floor(Date.now() / 1000) - 60 });
    await post('enrollment-challenge', enroll, 401, badIssuer);
    await post('enrollment-challenge', enroll, 401, expiredJwt);
    const role = await pool.connect();
    try {
      await role.query('BEGIN; SET LOCAL ROLE imahima_device_verifier');
      await assert.rejects(role.query('SELECT * FROM push_private.enrollment_challenges'), { code: '42501' });
    } finally {
      await role.query('ROLLBACK');
      role.release();
    }
    const rawEnroll = await pool.connect();
    try {
      await rawEnroll.query('BEGIN; SET LOCAL ROLE imahima_device_verifier');
      await assert.rejects(rawEnroll.query('SELECT push_private.enroll_device_installation($1,$2)', [
        randomUUID(), Buffer.from(key.point, 'base64url'),
      ]), { code: '42501' });
    } finally {
      await rawEnroll.query('ROLLBACK');
      rawEnroll.release();
    }
    const bypass = await localFetch(gateway.url)(gateway.url + '/rest/v1/rpc/lock_device_verification_key', {
      method: 'POST', headers: { authorization: 'Bearer ' + first.access, 'content-type': 'application/json' },
      body: JSON.stringify({ p_installation: installationId }),
    });
    assert.equal(bypass.status, 404);

    const locked = stack.openSqlSession();
    let output = '';
    locked.stdout.on('data', chunk => { output += chunk; });
    const closed = once(locked, 'close');
    locked.stdin.write(`BEGIN; SELECT 1 FROM push_private.installations WHERE installation_id='${installationId}' FOR UPDATE;\n\\echo ready\n`);
    try {
      await waitFor(() => output.includes('ready'), 'installation row locked', t.signal);
      await post('challenge', signed('challenge', { ...base, purpose: 'lookup', nonce }), 503);
    } finally {
      locked.stdin.end('ROLLBACK;\n');
      await closed;
    }
    assert.ok(await challenge('lookup'));
    await post('challenge', signed('challenge', { ...base, keyVersion: '2', purpose: 'lookup', nonce }), 403);
    const lockedVersion = stack.openSqlSession();
    let versionOutput = '';
    lockedVersion.stdout.on('data', chunk => { versionOutput += chunk; });
    const versionClosed = once(lockedVersion, 'close');
    const blocked = () => stack.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE application_name='device-proof-test' AND cardinality(pg_blocking_pids(pid))>0);`) === 't';
    lockedVersion.stdin.write(`BEGIN; UPDATE push_private.installations SET key_version=2
      WHERE installation_id='${installationId}';\n\\echo changed\n`);
    let staleRequest;
    try {
      await waitFor(() => versionOutput.includes('changed'), 'key version updated in concurrent session', t.signal);
      staleRequest = post('challenge', signed('challenge', { ...base, purpose: 'lookup', nonce }), null);
      await waitFor(blocked, 'request waits for the key update', t.signal);
    } finally {
      lockedVersion.stdin.end('COMMIT;\n');
      await versionClosed;
    }
    assert.equal((await staleRequest).status, 403);
    const staleEnrollment = await post('enrollment-challenge', enroll, 200, second.access);
    await post('enroll-installation', signed('enroll-installation', {
      ...enroll, nonce: staleEnrollment.nonce,
    }, key, second.access), 403, second.access);

    // Pause after both the challenge write and installation insert, then kill
    // exactly the isolated verifier connection before it can commit.
    const interrupted = { installationId: randomUUID(), publicKey: key.point };
    const issued = await post('enrollment-challenge', interrupted, 200, second.access);
    const proof = signed('enroll-installation', { ...interrupted, nonce: issued.nonce }, key, second.access);
    stack.query(`CREATE FUNCTION push_private.test_hold_enrollment() RETURNS trigger AS $$
      BEGIN
        IF NEW.installation_id = '${interrupted.installationId}' THEN
          SET LOCAL lock_timeout='0';
          PERFORM pg_advisory_xact_lock(260026, 2);
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_hold_enrollment AFTER INSERT ON push_private.installations
      FOR EACH ROW EXECUTE FUNCTION push_private.test_hold_enrollment();`);
    const hold = stack.openSqlSession();
    let held = '';
    hold.stdout.on('data', chunk => { held += chunk; });
    const holdClosed = once(hold, 'close');
    hold.stdin.write(`BEGIN; SELECT pg_advisory_xact_lock(260026, 2);\n\\echo held\n`);
    let pending;
    try {
      await waitFor(() => held.includes('held'), 'fault-injection lock held', t.signal);
      pending = post('enroll-installation', proof, null, second.access);
      await waitFor(blocked, 'verifier has inserted the installation inside the transaction', t.signal);
      const pid = stack.query(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid()
        AND application_name='device-proof-test' AND usename='imahima_device_api_login'
        AND cardinality(pg_blocking_pids(pid))>0;`);
      assert.match(pid, /^[1-9][0-9]*$/);
      assert.equal(stack.query(`SELECT pg_terminate_backend(${pid});`), 't');
      assert.equal((await pending).status, 503);
    } finally {
      hold.stdin.end('ROLLBACK;\n');
      await holdClosed;
      await pending;
    }
    assert.equal(stack.query(`SELECT count(*) FROM push_private.installations WHERE installation_id='${interrupted.installationId}';`), '0');
    await post('enroll-installation', proof, 200, second.access);

    const timed = { installationId: randomUUID(), publicKey: key.point };
    const timedChallenge = await post('enrollment-challenge', timed, 200, second.access);
    const timedDigest = createHash('sha256').update(Buffer.from(timedChallenge.nonce, 'base64url')).digest('hex');
    const expiryLock = stack.openSqlSession();
    let expiryOutput = '';
    expiryLock.stdout.on('data', chunk => { expiryOutput += chunk; });
    const expiryClosed = once(expiryLock, 'close');
    const condition = `digest=decode('${timedDigest}','hex')`;
    expiryLock.stdin.write(`BEGIN; SELECT 1 FROM push_private.enrollment_challenges
      WHERE ${condition} FOR UPDATE;\n\\echo ready\n`);
    let timedRequest;
    try {
      await waitFor(() => expiryOutput.includes('ready'), 'enrollment challenge row locked', t.signal);
      timedRequest = post('enroll-installation', signed('enroll-installation', {
        ...timed, nonce: timedChallenge.nonce,
      }, key, second.access), null, second.access);
      await waitFor(blocked, 'enrollment waits on its challenge row', t.signal);
      expiryLock.stdin.write(`UPDATE push_private.enrollment_challenges SET expires_at=clock_timestamp()
        WHERE ${condition};\n`);
    } finally {
      expiryLock.stdin.end('COMMIT;\n');
      await expiryClosed;
    }
    assert.equal((await timedRequest).status, 403);
    assert.equal(stack.query(`SELECT count(*) FROM push_private.installations WHERE installation_id='${timed.installationId}';`), '0');
    await assert.rejects(pool.query('SET ROLE postgres'), { code: '42501' });
    stack.query(`CREATE ROLE device_proof_unexpected_role NOLOGIN;
      GRANT device_proof_unexpected_role TO imahima_device_api_login WITH INHERIT FALSE, SET TRUE;`);
    try {
      await post('enrollment-challenge', enroll, 503);
    } finally {
      stack.query('REVOKE device_proof_unexpected_role FROM imahima_device_api_login;');
    }
    for (let index = 0; index < 5; index++) await post('enrollment-challenge', enroll);
    await post('enrollment-challenge', enroll, 429);
    assert.ok(gateway.traffic.get('/auth/v1/user 200') > 0);
    assert.ok(gateway.traffic.get('/rest/v1/rpc/lock_device_verification_key 404') > 0);
  } finally {
    agent.destroy();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await pool?.end();
    await stack.stop();
  }
});
