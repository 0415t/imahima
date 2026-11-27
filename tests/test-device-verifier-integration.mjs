import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { Agent, request } from 'node:http';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { createApp } from '../server/app.ts';
import { createManagedLogout } from '../lib/managed-logout.ts';
import { createDeviceVerifierPool, deviceSigningBytes, deviceVerifierRouter, logoutRecoveryRouter,
  logoutRecoverySigningBytes, notificationSessionAuthenticator } from '../server/device-verifier.ts';
import { createStack, waitFor } from './helpers/issue36-stack.mjs';

function makeKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const point = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-65).toString('base64url');
  return { ...pair, point };
}

function isolatedFetch(origin, agent, deadline) {
  return (input, init) => {
    const endpoint = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (endpoint.origin !== origin || endpoint.hostname !== '127.0.0.1') throw Error('Unexpected network origin');
    return new Promise((resolve, reject) => {
      const req = request(endpoint, {
        agent, method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers)),
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
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
  timeout: 480000,
}, async t => {
  const stack = createStack(t.signal, { allowSignup: true });
  const agent = new Agent({ proxyEnv: {} });
  let server, pool, recoveryPool;
  try {
    const gateway = await stack.start();
    const password = randomBytes(24).toString('hex');
    const recoveryPassword = randomBytes(24).toString('hex');
    stack.query(`CREATE ROLE imahima_device_api_login LOGIN NOINHERIT PASSWORD '${password}';
      GRANT imahima_device_verifier TO imahima_device_api_login WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
      CREATE ROLE imahima_logout_recovery_api_login LOGIN NOINHERIT PASSWORD '${recoveryPassword}';
      GRANT imahima_logout_recovery_verifier TO imahima_logout_recovery_api_login WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;`);
    const relay = await stack.openPostgresRelay();
    pool = createDeviceVerifierPool(`postgresql://imahima_device_api_login:${password}@127.0.0.1:${relay.port}/postgres?sslmode=disable&application_name=device-proof-test`);
    recoveryPool = createDeviceVerifierPool(`postgresql://imahima_logout_recovery_api_login:${recoveryPassword}@127.0.0.1:${relay.port}/postgres?sslmode=disable&application_name=logout-recovery-test`);
    const preflight = await pool.query('SELECT session_user').catch(error => {
      throw new Error(`Dedicated DB relay connection failed (${error.code ?? 'no SQLSTATE'})`);
    });
    assert.equal(preflight.rows[0].session_user, 'imahima_device_api_login');
    const localFetch = origin => isolatedFetch(origin, agent, t.signal);
    const auth = createClient(gateway.url, gateway.anon, {
      global: { fetch: localFetch(gateway.url) }, auth: { persistSession: false, autoRefreshToken: false },
    });
    async function signup() {
      const email = `device-${randomUUID()}@example.com`;
      const userPassword = randomBytes(24).toString('hex');
      const { data, error } = await auth.auth.signUp({ email, password: userPassword });
      assert.equal(Boolean(error), false);
      assert.ok(data.session);
      return { email, userPassword, access: data.session.access_token, refresh: data.session.refresh_token };
    }
    const first = await signup();
    const second = await signup();
    const issuer = 'http://127.0.0.1/auth/v1';
    assert.equal(deviceSigningBytes(['あ', '', 'A', null]).toString('utf8'),
      '23:imahima-device-proof-v13:あ0:1:A-:');
    let cachedOldClaims;
    const claimsLookup = token => token === first.access && cachedOldClaims
      ? Promise.resolve(cachedOldClaims) : auth.auth.getClaims(token);
    const router = deviceVerifierRouter(pool, issuer, claimsLookup, true);
    let notificationExtensions = 0;
    server = createApp({
      authenticateNotificationSession: notificationSessionAuthenticator(pool, issuer, claimsLookup),
      extendIsFreeFromNotification: async () => {
        notificationExtensions++;
        return { isFree: true, freeUntil: null, error: null };
      },
    }, undefined, undefined, undefined, undefined, router,
    logoutRecoveryRouter(recoveryPool, issuer, randomBytes(32))).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    async function post(action, body, status = 200, access = first.access) {
      const response = await localFetch(origin)(origin + '/device-recovery/' + action, {
        method: 'POST', headers: { ...(access ? { authorization: 'Bearer ' + access } : {}), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (status !== null) assert.equal(response.status, status, action);
      return { status: response.status, ...result };
    }
    async function discardCommittedReply(action, body, access = first.access) {
      // Express sends the headers after COMMIT. The caller never reads the
      // response body and must recover the result through the normal API.
      await new Promise((resolve, reject) => {
        const req = request(origin + '/device-recovery/' + action, {
          method: 'POST', agent, signal: t.signal,
          headers: { ...(access ? { authorization: 'Bearer ' + access } : {}), 'content-type': 'application/json' },
        }, response => {
          response.destroy();
          if (response.statusCode === 200) resolve();
          else reject(new Error(`${action} response status ${response.statusCode}`));
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });
    }
    const key = makeKey();
    const foreignKey = makeKey();
    const installationId = randomUUID();
    const base = { installationId, keyVersion: '1' };
    function signed(action, body, signingKey = key, access = first.access) {
      if (action === 'confirm-auth-revocation') action = 'confirm_auth_revocation';
      if (action === 'begin-logout') action = 'begin_logout';
      if (action === 'begin-session-logout') action = 'begin_session_logout';
      if (action === 'lookup-generation') action = 'lookup_generation';
      const jwt = JSON.parse(Buffer.from(access.split('.')[1], 'base64url'));
      const bytes = deviceSigningBytes([issuer, jwt.sub, jwt.session_id, body.installationId, action,
        action === 'challenge' ? body.purpose : action, body.keyVersion ?? '1', body.generation ?? null,
        body.operationId ?? null, body.nonce, body.token ?? null, body.platform ?? null,
        body.deviceName ?? null, body.publicKey ?? null]);
      return { ...body, signature: sign('sha256', bytes, {
        key: signingKey.privateKey, dsaEncoding: 'ieee-p1363',
      }).toString('base64url') };
    }
    if (process.env.IMAHIMA_ENROLLMENT_RACE_ONLY === '1') {
      const input = { installationId, publicKey: key.point };
      const enrollment = await post('enrollment-challenge', input);
      stack.query(`CREATE FUNCTION push_private.test_pause_first_enrollment() RETURNS trigger
        LANGUAGE plpgsql AS $$BEGIN
          IF NEW.installation_id='${installationId}' THEN
            PERFORM pg_advisory_xact_lock(61202,1);
          END IF;
          RETURN NEW;
        END$$;
        CREATE TRIGGER test_pause_first_enrollment AFTER INSERT ON push_private.installations
        FOR EACH ROW EXECUTE FUNCTION push_private.test_pause_first_enrollment();`);
      const holder = stack.openSqlSession();
      const closed = once(holder, 'close');
      let output = '', pending;
      holder.stdout.on('data', chunk => { output += chunk; });
      holder.stdin.write('BEGIN; SELECT pg_advisory_xact_lock(61202,1);\n\\echo held\n');
      const operationId = randomUUID();
      try {
        await waitFor(() => output.includes('held'), 'enrollment barrier held', t.signal);
        pending = post('enroll-installation', signed('enroll-installation', { ...input, nonce: enrollment.nonce }));
        await waitFor(() => stack.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE application_name='device-proof-test' AND cardinality(pg_blocking_pids(pid))>0);`) === 't',
        'signed enrollment waiting before commit', t.signal);
        await post('begin-session-logout', signed('begin-session-logout', {
          ...base, operationId, nonce: randomBytes(32).toString('base64url'),
        }), 403);
        assert.equal(stack.query(`SELECT count(*) FROM push_private.logout_recoveries WHERE installation_id='${installationId}';`), '0');
      } finally {
        holder.stdin.end('COMMIT;\n');
        await closed;
        await pending;
      }
      const sameKey = await post('enrollment-challenge', input);
      await post('enroll-installation', signed('enroll-installation', { ...input, nonce: sameKey.nonce }));
      const begin = async () => {
        const purpose = 'begin_session_logout';
        const issued = await post('challenge', signed('challenge', {
          ...base, purpose, nonce: randomBytes(32).toString('base64url'),
        }));
        return (await post('begin-session-logout', signed('begin-session-logout', {
          ...base, operationId, nonce: issued.nonce,
        }))).result;
      };
      const receipt = await begin();
      assert.equal(receipt.generation, null);
      assert.deepEqual(await begin(), receipt);
      assert.equal(stack.query(`SELECT count(*) FROM push_private.installation_bindings WHERE installation_id='${installationId}';`), '0');
      return;
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
    await discardCommittedReply('enroll', open);
    await post('enroll', open, 403);
    const generation = (await post('enroll', signed('enroll', { ...base, nonce: await challenge('enroll') }))).result;
    assert.match(generation, /^[1-9][0-9]*$/);
    assert.equal(stack.query(`SELECT count(*) FROM push_private.installation_bindings
      WHERE installation_id='${installationId}';`), '1');
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
    await discardCommittedReply('register', good);
    const lookup = signed('lookup', { ...base, generation, operationId, nonce: await challenge('lookup') });
    const registered = (await post('lookup', lookup)).result;
    assert.deepEqual(registered, { registered: true, generation, revision: '1' });
    assert.deepEqual((await post('register', signed('register', {
      ...register, nonce: await challenge('register'),
    }))).result, registered);
    assert.equal(stack.query(`SELECT registration_revision FROM public.user_device_tokens
      WHERE installation_id='${installationId}' AND generation=${generation};`), '1');
    const confirmation = { ...base, generation, operationId: randomUUID() };
    const confirm = async (access = unrelatedSession, fields = confirmation, status = 200) => {
      const request = signed('confirm-auth-revocation', {
        ...fields, nonce: await challenge('confirm_auth_revocation', access),
      }, key, access);
      return post('confirm-auth-revocation', request, status, access);
    };
    await confirm(unrelatedSession, confirmation, 403);
    const fenceOperation = randomUUID();
    const fenceInput = { ...base, generation, operationId: fenceOperation };
    await discardCommittedReply('fence', signed('fence', { ...fenceInput, nonce: await challenge('fence') }));
    assert.deepEqual((await post('fence', signed('fence', {
      ...fenceInput, nonce: await challenge('fence'),
    }))).result, { fenced: true, generation });
    assert.equal(stack.query(`SELECT count(*) FROM public.user_device_tokens WHERE installation_id='${installationId}';`), '0');
    assert.equal((await confirm()).result.status, 'pending');
    await confirm(second.access, confirmation, 403);
    await confirm(unrelatedSession, { ...confirmation, generation: '999999' }, 403);
    const openAs = async (access, status) => post('enroll', signed('enroll', {
      ...base, nonce: await challenge('enroll', access),
    }, key, access), status, access);
    await openAs(second.access, 403);
    await openAs(unrelatedSession, 403);
    await post('register', signed('register', { ...register, operationId: randomUUID(), nonce: await challenge('register') }), 403);

    // Subsequent independent fault cases should not depend on the 60-second quota clock.
    stack.query(`DELETE FROM push_private.device_challenges WHERE installation_id='${installationId}';`);
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
      let discard = true;
      try { await role.query('ROLLBACK'); discard = false; }
      finally { role.release(discard); }
    }
    const rawEnroll = await pool.connect();
    try {
      await rawEnroll.query('BEGIN; SET LOCAL ROLE imahima_device_verifier');
      await assert.rejects(rawEnroll.query('SELECT push_private.enroll_device_installation($1,$2)', [
        randomUUID(), Buffer.from(key.point, 'base64url'),
      ]), { code: '42501' });
    } finally {
      let discard = true;
      try { await rawEnroll.query('ROLLBACK'); discard = false; }
      finally { rawEnroll.release(discard); }
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
    const quotaUser = JSON.parse(Buffer.from(first.access.split('.')[1], 'base64url')).sub;
    // Exercise the quota in one window, independent of prior fault cases.
    stack.query(`DELETE FROM push_private.enrollment_challenges WHERE user_id='${quotaUser}';`);
    for (let index = 0; index < 8; index++) await post('enrollment-challenge', enroll);
    await post('enrollment-challenge', enroll, 429);
    stack.query(`DELETE FROM push_private.enrollment_challenges WHERE user_id='${quotaUser}';`);
    assert.ok(gateway.traffic.get('/auth/v1/user 200') > 0);
    assert.ok(gateway.traffic.get('/rest/v1/rpc/lock_device_verification_key 404') > 0);

    base.keyVersion = '2';
    confirmation.keyVersion = '2';
    // Start this independent recovery scenario below the bounded issuance quota.
    stack.query(`DELETE FROM push_private.device_challenges WHERE installation_id='${installationId}';`);
    const jwtClaims = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    const oldSession = jwtClaims(first.access).session_id;
    const survivingSession = jwtClaims(unrelatedSession).session_id;
    const boundWhere = `installation_id='${installationId}' AND generation=${generation}`;
    stack.query(`UPDATE push_private.installation_bindings SET session_id='${jwtClaims(second.access).session_id}'
      WHERE ${boundWhere};`);
    await confirm(unrelatedSession, confirmation, 503);
    assert.equal(stack.query(`SELECT auth_revocation_confirmed_at IS NULL FROM push_private.installation_bindings WHERE ${boundWhere};`), 't');
    stack.query(`UPDATE push_private.installation_bindings SET session_id='${oldSession}' WHERE ${boundWhere};`);

    const extendFromNotification = access => localFetch(origin)(origin + '/profiles/me/is-free/extend-from-notification', {
      method: 'POST', headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
      body: JSON.stringify({ claim_id: randomUUID() }),
    });
    assert.equal((await extendFromNotification(first.access)).status, 200);
    // Emulate a signature-valid JWT check that doesn't consult Auth again, as
    // with a locally verified asymmetric token after its session was removed.
    cachedOldClaims = await auth.auth.getClaims(first.access);
    assert.ok(cachedOldClaims.data?.claims && !cachedOldClaims.error);
    const localAuth = localFetch(gateway.url);
    const headers = { authorization: 'Bearer ' + first.access, 'content-type': 'application/json' };
    const [logout, refresh] = await Promise.all([
      localAuth(gateway.url + '/auth/v1/logout?scope=local', { method: 'POST', headers }),
      localAuth(gateway.url + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers, body: JSON.stringify({ refresh_token: first.refresh }),
      }),
    ]);
    assert.equal(logout.status, 204);
    assert.ok([200, 400, 401].includes(refresh.status));
    assert.equal(stack.query(`SELECT EXISTS (SELECT 1 FROM auth.sessions WHERE id='${oldSession}'),
      EXISTS (SELECT 1 FROM auth.sessions WHERE id='${survivingSession}');`), 'f|t');
    assert.equal((await extendFromNotification(first.access)).status, 401);
    assert.equal(notificationExtensions, 1);
    await post('enrollment-challenge', enroll, 401, first.access);

    stack.query(`CREATE ROLE device_proof_no_auth NOLOGIN;
      GRANT USAGE ON SCHEMA push_private TO device_proof_no_auth;
      ALTER FUNCTION push_private.auth_session_present(uuid,uuid) OWNER TO device_proof_no_auth;`);
    try {
      assert.equal((await extendFromNotification(unrelatedSession)).status, 503);
      await post('enrollment-challenge', enroll, 503, unrelatedSession);
    } finally {
      stack.query('ALTER FUNCTION push_private.auth_session_present(uuid,uuid) OWNER TO postgres;');
    }
    assert.equal(stack.query(`SELECT auth_revocation_confirmed_at IS NULL FROM push_private.installation_bindings WHERE ${boundWhere};`), 't');

    const pendingProof = signed('confirm-auth-revocation', {
      ...confirmation, nonce: await challenge('confirm_auth_revocation', unrelatedSession),
    }, key, unrelatedSession);
    const sessionFunction = Buffer.from(stack.query(`SELECT encode(convert_to(
      pg_get_functiondef('push_private.auth_session_present(uuid,uuid)'::regprocedure),'UTF8'),'hex');`), 'hex').toString();
    const injectOldSessionCheck = sql => {
      const target = 'SELECT s.user_id INTO owner_id';
      assert.ok(sessionFunction.includes(target));
      stack.query(sessionFunction.replace(target, `IF p_session='${oldSession}' THEN ${sql} END IF;\n    ${target}`));
    };
    // A separate isolated fixture induces the same RLS read error without modifying auth.sessions.
    stack.query(`CREATE TABLE push_private.test_invisible_session (id uuid PRIMARY KEY);
      INSERT INTO push_private.test_invisible_session VALUES ('${oldSession}');
      ALTER TABLE push_private.test_invisible_session ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON push_private.test_invisible_session TO device_proof_no_auth;
      CREATE FUNCTION push_private.test_rls_presence() RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path='' SET row_security=off AS $$
        SELECT EXISTS (SELECT 1 FROM push_private.test_invisible_session);
      $$;
      ALTER FUNCTION push_private.test_rls_presence() OWNER TO device_proof_no_auth;`);
    injectOldSessionCheck('PERFORM push_private.test_rls_presence();');
    try {
      await post('confirm-auth-revocation', pendingProof, 503, unrelatedSession);
    } finally {
      stack.query(sessionFunction);
    }
    assert.equal(stack.query(`SELECT auth_revocation_confirmed_at IS NULL FROM push_private.installation_bindings WHERE ${boundWhere};`), 't');

    const probeHold = stack.openSqlSession();
    let probeOutput = '';
    probeHold.stdout.on('data', chunk => { probeOutput += chunk; });
    const probeClosed = once(probeHold, 'close');
    probeHold.stdin.write('BEGIN; SELECT pg_advisory_xact_lock(260027, 1);\n\\echo probe-ready\n');
    let probeRequest;
    try {
      await waitFor(() => probeOutput.includes('probe-ready'), 'old session read fault lock held', t.signal);
      injectOldSessionCheck('PERFORM set_config(\'lock_timeout\',\'0\',true); PERFORM pg_advisory_xact_lock(260027, 1);');
      probeRequest = post('confirm-auth-revocation', pendingProof, null, unrelatedSession);
      await waitFor(blocked, 'confirmation waits during the old session check', t.signal);
      const probePid = stack.query(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid()
        AND application_name='device-proof-test' AND usename='imahima_device_api_login'
        AND cardinality(pg_blocking_pids(pid))>0;`);
      assert.match(probePid, /^[1-9][0-9]*$/);
      assert.equal(stack.query(`SELECT pg_terminate_backend(${probePid});`), 't');
      assert.equal((await probeRequest).status, 503);
    } finally {
      probeHold.stdin.end('ROLLBACK;\n');
      await probeClosed;
      await probeRequest;
      stack.query(sessionFunction);
    }
    assert.equal(stack.query(`SELECT auth_revocation_confirmed_at IS NULL FROM push_private.installation_bindings WHERE ${boundWhere};`), 't');
    stack.query(`CREATE FUNCTION push_private.test_fail_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind='confirm_auth_revocation' THEN RAISE EXCEPTION 'fixture abort'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_fail_confirmation BEFORE INSERT ON push_private.operations
      FOR EACH ROW EXECUTE FUNCTION push_private.test_fail_confirmation();`);
    await post('confirm-auth-revocation', pendingProof, 503, unrelatedSession);
    assert.equal(stack.query(`SELECT auth_revocation_confirmed_at IS NULL FROM push_private.installation_bindings WHERE ${boundWhere};`), 't');
    assert.equal(stack.query(`SELECT count(*) FROM push_private.operations WHERE operation_id='${confirmation.operationId}';`), '0');
    stack.query('DROP TRIGGER test_fail_confirmation ON push_private.operations;');
    await discardCommittedReply('confirm-auth-revocation', pendingProof, unrelatedSession);
    assert.equal((await confirm()).result.status, 'confirmed');
    assert.equal((await post('lookup', signed('lookup', {
      ...confirmation, nonce: await challenge('lookup', unrelatedSession),
    }, key, unrelatedSession), 200, unrelatedSession)).result.status, 'confirmed');
    await confirm(unrelatedSession, { ...confirmation, operationId }, 409);
    const nextGeneration = (await openAs(second.access, 200)).result;
    assert.ok(BigInt(nextGeneration) > BigInt(generation));
    const nextRegistration = { ...register, ...base, generation: nextGeneration };
    const postAs = async (action, input, access, status = 200) => post(action, signed(action, {
      ...input, nonce: await challenge(action, access),
    }, key, access), status, access);
    await postAs('register', nextRegistration, second.access, 409);
    assert.deepEqual((await postAs('register', {
      ...nextRegistration, operationId: randomUUID(),
    }, second.access)).result, { registered: true, generation: nextGeneration, revision: '1' });

    await postAs('lookup', { ...confirmation, operationId: fenceOperation }, second.access, 403);
    await postAs('fence', { ...base, generation: nextGeneration, operationId: fenceOperation }, second.access, 409);
    await postAs('fence', { ...base, generation: nextGeneration, operationId: randomUUID() }, unrelatedSession, 403);
    await post('register', good, 403, first.access);
    await post('register', signed('register', {
      ...register, ...base, nonce: await challenge('register', unrelatedSession),
    }), 401, first.access);
    const nextOwner = jwtClaims(second.access).sub;
    assert.equal(stack.query(`SELECT count(*) FROM public.user_device_tokens
      WHERE installation_id='${installationId}' AND generation=${nextGeneration}
        AND user_id='${nextOwner}' AND expo_push_token='ExpoPushToken[isolated_test]';`), '1');

    // The recovery-only path starts while B has a live JWT. Every call after
    // GoTrue local revocation deliberately sends no Authorization header.
    stack.query(`DELETE FROM push_private.device_challenges WHERE installation_id='${installationId}';`);
    const startInput = { ...base, generation: nextGeneration, operationId: randomUUID() };
    const firstStart = signed('begin-logout', {
      ...startInput, nonce: await challenge('begin_logout', second.access),
    }, key, second.access);
    await post('begin-logout', firstStart, 401, null);
    await post('begin-logout', recoveryProof('begin_logout', firstStart), 403, second.access);
    await discardCommittedReply('begin-logout', firstStart, second.access);
    const { recoveryId } = (await post('begin-logout', signed('begin-logout', {
      ...startInput, nonce: await challenge('begin_logout', second.access),
    }, key, second.access), 200, second.access)).result;
    assert.match(recoveryId, /^[0-9a-f-]{36}$/);

    function recoveryProof(action, fields, signingKey = key, encoder = logoutRecoverySigningBytes) {
      const bare = [issuer, fields.installationId, fields.keyVersion, action,
        fields.purpose ?? action, fields.recoveryId ?? null, fields.nonce, fields.issuedAt ?? null];
      if ((fields.purpose ?? action) === 'discover-binding') {
        bare.push(fields.bindingUserId, fields.bindingSessionId,
          fields.bindingGeneration ?? null, fields.bindingOperationId ?? null);
      }
      const bytes = encoder(bare);
      return { ...fields, signature: sign('sha256', bytes, {
        key: signingKey.privateKey, dsaEncoding: 'ieee-p1363',
      }).toString('base64url') };
    }
    const recoveryRequest = (purpose, id) => recoveryProof('challenge', {
      ...base, purpose, ...(id ? { recoveryId: id } : {}), nonce: randomBytes(32).toString('base64url'),
      issuedAt: String(Math.floor(Date.now() / 1000)),
    });
    const recoveryPost = (action, fields, status = 200) => post('recovery/' + action, fields, status, null);
    async function recoveryAction(action, id) {
      const issued = await recoveryPost('challenge', recoveryRequest(action, id));
      return recoveryProof(action, { ...base, ...(id ? { recoveryId: id } : {}), nonce: issued.nonce });
    }
    const issueDiscover = recoveryRequest('discover');
    const firstDiscovery = await recoveryPost('challenge', issueDiscover);
    const repeatedChallenge = await recoveryPost('challenge', issueDiscover, 403);
    const unknown = recoveryProof('challenge', { ...issueDiscover, installationId: randomUUID() });
    const wrongKey = recoveryProof('challenge', issueDiscover, foreignKey);
    assert.deepEqual(await recoveryPost('challenge', unknown, 403), repeatedChallenge);
    assert.deepEqual(await recoveryPost('challenge', wrongKey, 403), repeatedChallenge);
    await recoveryPost('challenge', recoveryProof('challenge', { ...issueDiscover, issuedAt: '1' }), 403);
    await recoveryPost('challenge', recoveryProof('challenge', {
      ...issueDiscover, purpose: 'confirm', recoveryId: randomUUID(),
    }), 403);
    const discoveryInput = { ...base, nonce: firstDiscovery.nonce };
    await recoveryPost('discover', recoveryProof('discover', discoveryInput, key, deviceSigningBytes), 403);
    const discovery = recoveryProof('discover', discoveryInput);
    await recoveryPost('discover', { ...discovery, recoveryId }, 400);
    const simultaneous = await Promise.all([recoveryPost('discover', discovery, null), recoveryPost('discover', discovery, null)]);
    assert.deepEqual(simultaneous.map(reply => reply.status).sort(), [200, 403]);
    assert.deepEqual(simultaneous.find(reply => reply.status === 200).result, { recoveryId, status: 'pending' });

    const expires = await recoveryAction('discover');
    const digest = createHash('sha256').update(Buffer.from(expires.nonce, 'base64url')).digest('hex');
    function whileRecoveryBlocks(sql) {
      return `DO $$ DECLARE target integer; deadline timestamptz := clock_timestamp()+interval '10 seconds';
        BEGIN LOOP
          PERFORM pg_stat_clear_snapshot();
          SELECT pid INTO target FROM pg_stat_activity
          WHERE application_name='logout-recovery-test' AND usename='imahima_logout_recovery_api_login'
            AND pg_backend_pid() = ANY(pg_blocking_pids(pid));
          EXIT WHEN FOUND;
          IF clock_timestamp()>deadline THEN RAISE EXCEPTION 'Recovery request did not reach lock'; END IF;
          PERFORM pg_sleep(0.02);
        END LOOP;
        ${sql}
        END $$;`;
    }
    const expiryHolder = stack.openSqlSession();
    expiryHolder.stdin.on('error', () => {});
    let expiryReady = '';
    expiryHolder.stdout.on('data', chunk => { expiryReady += chunk; });
    const expiryDone = once(expiryHolder, 'close');
    expiryHolder.stdin.end(`BEGIN; SELECT 1 FROM push_private.installations
      WHERE installation_id='${installationId}' FOR UPDATE;\n\\echo expiry-ready\n
      ${whileRecoveryBlocks(`UPDATE push_private.logout_recovery_challenges
        SET expires_at=clock_timestamp()-interval '1 microsecond' WHERE digest=decode('${digest}','hex');`)}
      COMMIT;\n`);
    await waitFor(() => expiryReady.includes('expiry-ready'), 'recovery key locked', t.signal);
    const expiringRequest = recoveryPost('discover', expires, null);
    assert.equal((await expiryDone)[0], 0);
    assert.equal((await expiringRequest).status, 403);

    const pendingRecovery = await recoveryAction('confirm', recoveryId);
    await recoveryPost('confirm', { ...pendingRecovery, recoveryId: randomUUID() }, 403);
    stack.query(`ALTER FUNCTION push_private.auth_session_present(uuid,uuid) OWNER TO device_proof_no_auth;
      GRANT EXECUTE ON FUNCTION push_private.auth_session_present(uuid,uuid) TO postgres;`);
    try {
      await recoveryPost('confirm', pendingRecovery, 503);
    } finally {
      stack.query('ALTER FUNCTION push_private.auth_session_present(uuid,uuid) OWNER TO postgres;');
    }
    const recoveryLock = stack.openSqlSession();
    recoveryLock.stdin.on('error', () => {});
    let recoveryOutput = '';
    recoveryLock.stdout.on('data', chunk => { recoveryOutput += chunk; });
    const recoveryClosed = once(recoveryLock, 'close');
    recoveryLock.stdin.end(`BEGIN; LOCK TABLE push_private.logout_recovery_challenges IN ACCESS EXCLUSIVE MODE;
      \n\\echo recovery-lock\n
      ${whileRecoveryBlocks("IF NOT pg_terminate_backend(target) THEN RAISE EXCEPTION 'Failed to end recovery connection'; END IF;")}
      ROLLBACK;\n`);
    await waitFor(() => recoveryOutput.includes('recovery-lock'), 'recovery challenge lock held', t.signal);
    const cutOff = recoveryPost('confirm', pendingRecovery, null);
    assert.equal((await recoveryClosed)[0], 0);
    assert.equal((await cutOff).status, 503);
    assert.deepEqual((await recoveryPost('confirm', pendingRecovery)).result, { recoveryId, status: 'pending' });
    assert.equal((await localAuth(gateway.url + '/auth/v1/logout?scope=local', {
      method: 'POST', headers: { authorization: 'Bearer ' + second.access },
    })).status, 204);
    const afterSignout = await recoveryAction('confirm', recoveryId);
    await discardCommittedReply('recovery/confirm', afterSignout, null);
    assert.deepEqual((await recoveryPost('discover', await recoveryAction('discover'))).result, { recoveryId, status: 'confirmed' });
    await discardCommittedReply('recovery/ack', await recoveryAction('ack', recoveryId), null);
    assert.deepEqual((await recoveryPost('ack', await recoveryAction('ack', recoveryId))).result, { recoveryId, status: 'cleared' });
    const followingGeneration = (await openAs(unrelatedSession, 200)).result;
    assert.ok(BigInt(followingGeneration) > BigInt(nextGeneration));
    assert.deepEqual((await recoveryPost('ack', await recoveryAction('ack', recoveryId))).result, { recoveryId, status: 'cleared' });
    assert.equal(stack.query(`SELECT fenced_at IS NULL FROM push_private.installation_bindings
      WHERE installation_id='${installationId}' AND generation=${followingGeneration};`), 't');
    const direct = await localFetch(gateway.url)(gateway.url + '/rest/v1/rpc/apply_logout_recovery', {
      method: 'POST', headers: { authorization: 'Bearer ' + unrelatedSession, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(direct.status, 404);
    const scopedCases = [];
    for (const opensFirst of [false, true]) {
      const target = { keyVersion: '1', installationId: randomUUID() };
      const newKey = { installationId: target.installationId, publicKey: key.point };
      const enrollment = await post('enrollment-challenge', newKey, 200, unrelatedSession);
      await discardCommittedReply('enroll-installation',
        signed('enroll-installation', { ...newKey, nonce: enrollment.nonce }, key, unrelatedSession), unrelatedSession);
      const retryKey = await post('enrollment-challenge', newKey, 200, unrelatedSession);
      await post('enroll-installation', signed('enroll-installation', {
        ...newKey, nonce: retryKey.nonce,
      }, key, unrelatedSession), 200, unrelatedSession);
      const issue = async purpose => (await post('challenge', signed('challenge', {
        ...target, purpose, nonce: randomBytes(32).toString('base64url'),
      }, key, unrelatedSession), 200, unrelatedSession)).nonce;
      const delayedOpen = signed('enroll', { ...target, nonce: await issue('enroll') }, key, unrelatedSession);
      const expectedGeneration = opensFirst ? (await post('enroll', delayedOpen, 200, unrelatedSession)).result : null;
      assert.equal((await post('lookup-generation', signed('lookup-generation', {
        ...target, nonce: await issue('lookup_generation'),
      }, key, unrelatedSession), 200, unrelatedSession)).result, expectedGeneration);
      const operationId = randomUUID();
      const beginScoped = async () => signed('begin-session-logout', {
        ...target, operationId, nonce: await issue('begin_session_logout'),
      }, key, unrelatedSession);
      await discardCommittedReply('begin-session-logout', await beginScoped(), unrelatedSession);
      const receipt = (await post('begin-session-logout', await beginScoped(), 200, unrelatedSession)).result;
      assert.equal(receipt.generation, expectedGeneration);
      const oldOpen = opensFirst ? signed('enroll', { ...target, nonce: await issue('enroll') }, key, unrelatedSession) : delayedOpen;
      await post('enroll', oldOpen, 403, unrelatedSession);
      const claims = jwtClaims(unrelatedSession);
      const scope = { bindingUserId: claims.sub, bindingSessionId: claims.session_id, bindingOperationId: operationId };
      const scopedProof = async (action, fields) => {
        const issued = await recoveryPost('challenge', recoveryProof('challenge', {
          ...target, ...fields, purpose: action, nonce: randomBytes(32).toString('base64url'),
          issuedAt: String(Math.floor(Date.now() / 1000)),
        }));
        return recoveryProof(action, { ...target, ...fields, nonce: issued.nonce });
      };
      const discovered = await scopedProof('discover-binding', scope);
      await recoveryPost('discover-binding', { ...discovered, bindingSessionId: randomUUID() }, 403);
      assert.deepEqual((await recoveryPost('discover-binding', discovered)).result,
        { recoveryId: receipt.recoveryId, status: 'pending' });
      await recoveryPost('discover-binding', discovered, 403);
      await recoveryPost('ack', await scopedProof('ack', { recoveryId: receipt.recoveryId }), 403);
      scopedCases.push({ scopedProof, recoveryId: receipt.recoveryId });
    }
    assert.equal((await localAuth(gateway.url + '/auth/v1/logout?scope=local', {
      method: 'POST', headers: { authorization: 'Bearer ' + unrelatedSession },
    })).status, 204);
    for (const { scopedProof, recoveryId: id } of scopedCases) {
      assert.deepEqual((await recoveryPost('confirm', await scopedProof('confirm', { recoveryId: id }))).result,
        { recoveryId: id, status: 'confirmed' });
      await discardCommittedReply('recovery/ack', await scopedProof('ack', { recoveryId: id }), null);
      assert.deepEqual((await recoveryPost('ack', await scopedProof('ack', { recoveryId: id }))).result,
        { recoveryId: id, status: 'cleared' });
    }

    // Exercise the actual app state machine against the isolated stack. Only
    // secure key operations and local persistence are supplied by test adapters.
    const clientAccount = await signup();
    const clientUser = jwtClaims(clientAccount.access).sub;
    let localSession = { user: { id: clientUser }, access_token: clientAccount.access };
    const clientTarget = { keyVersion: '1', installationId: randomUUID() };
    const clientChallenge = async purpose => (await post('challenge', signed('challenge', {
      ...clientTarget, purpose, nonce: randomBytes(32).toString('base64url'),
    }, key, clientAccount.access), 200, clientAccount.access)).nonce;
    const localRecords = new Map();
    let lostAck = false, openCalls = 0;
    const restartClient = () => createManagedLogout({
      prefix: 'isolated', enableNew: true,
      storage: {
        async getItem(name) { return localRecords.get(name) ?? null; },
        async setItem(name, value) { localRecords.set(name, value); },
        async removeItem(name) { localRecords.delete(name); },
      },
      session: async () => localSession,
      async revoke(session) {
        assert.equal((await localAuth(gateway.url + '/auth/v1/logout?scope=local', {
          method: 'POST', headers: { authorization: 'Bearer ' + session.access_token },
        })).status, 204);
      },
      async clean(scope) {
        if (localSession) {
          assert.equal(scope.userId, localSession.user.id);
          assert.equal(scope.sessionId, jwtClaims(localSession.access_token).session_id);
        }
        localSession = null;
      },
      api: {
        identity: async () => clientTarget.installationId,
        operationId: randomUUID,
        async ensureInstallation() {
          const input = { installationId: clientTarget.installationId, publicKey: key.point };
          const issued = await post('enrollment-challenge', input, 200, clientAccount.access);
          await post('enroll-installation', signed('enroll-installation', {
            ...input, nonce: issued.nonce,
          }, key, clientAccount.access), 200, clientAccount.access);
        },
        async open() {
          openCalls++;
          await discardCommittedReply('enroll', signed('enroll', {
            ...clientTarget, nonce: await clientChallenge('enroll'),
          }, key, clientAccount.access), clientAccount.access);
          throw Error('Lost generation response');
        },
        async register() { assert.fail('Registration must stay blocked during logout'); },
        async lookupRegistration() { assert.fail('Unexpected registration lookup'); },
        async lookupGeneration() { assert.fail('Logout must resolve the generation inside the fence transaction'); },
        async begin(session, intent) {
          assert.equal(intent.generation, undefined);
          const { result } = await post('begin-session-logout', signed('begin-session-logout', {
            ...clientTarget, operationId: intent.operationId, nonce: await clientChallenge('begin_session_logout'),
          }, key, session.access_token), 200, session.access_token);
          assert.ok(result.generation);
          return result.recoveryId;
        },
        async recovery(_installation, action, id, scope) {
          const input = { ...clientTarget, ...(id ? { recoveryId: id } : {}),
            ...(scope ? { bindingUserId: scope.userId, bindingSessionId: scope.sessionId,
              bindingOperationId: scope.operationId } : {}) };
          const issued = await recoveryPost('challenge', recoveryProof('challenge', {
            ...input, purpose: action, nonce: randomBytes(32).toString('base64url'),
            issuedAt: String(Math.floor(Date.now() / 1000)),
          }));
          const proof = recoveryProof(action, { ...input, nonce: issued.nonce });
          if (action === 'ack' && !lostAck) {
            lostAck = true;
            await discardCommittedReply('recovery/ack', proof, null);
            throw Error('Lost acknowledgement');
          }
          return (await recoveryPost(action, proof)).result;
        },
      },
    });
    localRecords.set('isolated:device-v2-clean', clientTarget.installationId);
    await assert.rejects(restartClient().save(localSession, 'ExpoPushToken[unused]', async () => true, async () => true),
      /Lost generation response/);
    await assert.rejects(restartClient().finish(false, async () => {}), /Lost acknowledgement/);
    const intentKey = 'isolated:logout-v2-intent';
    const { recoveryId: _lostId, ...intentWithoutId } = JSON.parse(localRecords.get(intentKey));
    localRecords.set(intentKey, JSON.stringify({ ...intentWithoutId, stage: 'begin' }));
    localRecords.set('isolated:logout-v2', '{broken');
    assert.equal(await restartClient().finish(false, async () => {}), true);
    assert.equal(await restartClient().availability(), 'ready');
    assert.equal(localSession, null);
    assert.equal(openCalls, 1);

    const nextClient = await signup();
    const nextNonce = (await post('challenge', signed('challenge', {
      ...clientTarget, purpose: 'enroll', nonce: randomBytes(32).toString('base64url'),
    }, key, nextClient.access), 200, nextClient.access)).nonce;
    assert.ok((await post('enroll', signed('enroll', {
      ...clientTarget, nonce: nextNonce,
    }, key, nextClient.access), 200, nextClient.access)).result);

    const limiter = createApp({}, undefined, undefined, undefined, undefined, undefined,
      logoutRecoveryRouter(recoveryPool, issuer, randomBytes(32))).listen(0, '127.0.0.1');
    try {
      await once(limiter, 'listening');
      const limiterOrigin = `http://127.0.0.1:${limiter.address().port}`;
      const body = JSON.stringify({ installationId: randomUUID(), keyVersion: '0' });
      const probe = () => localFetch(limiterOrigin)(limiterOrigin + '/device-recovery/recovery/challenge', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      for (let index = 0; index < 30; index++) assert.equal((await probe()).status, 400);
      assert.equal((await probe()).status, 429);
    } finally {
      limiter.closeAllConnections();
      await new Promise((resolve, reject) => limiter.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    agent.destroy();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await pool?.end();
    await recoveryPool?.end();
    await stack.stop();
  }
});
