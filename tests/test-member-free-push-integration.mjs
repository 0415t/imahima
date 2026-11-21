import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

test('normal entrypoint and real DB push worker with mocked Expo transport', { timeout: 120000 }, async () => {
  const config = JSON.parse(readFileSync('.env.member-free-api.local', 'utf8'));
  const prior = JSON.parse(readFileSync('tests/member-free-entrypoint-results.json', 'utf8'));
  assert.equal(config.url, 'http://127.0.0.1:55440');
  const { A, B } = prior.users;
  const report = { at: new Date().toISOString(), identity: null, users: { A, B }, scenarios: [], passed: false };
  const processes = new Set();
  let identityVerified = false;
  const token = `ExpoPushToken[local_mock_${randomUUID().replaceAll('-', '')}]`;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function wait(check, label, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(100); }
    throw new Error(`Timed out: ${label}`);
  }
  async function request(base, path, method = 'GET', body, bearer = config.service) {
    assert.ok([config.url, 'http://127.0.0.1:55442', 'http://127.0.0.1:55443'].includes(base));
    const response = await fetch(`${base}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { apikey: config.service, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  async function rows(table, filter = '') {
    const result = await request(config.url, `/rest/v1/${table}?select=*${filter}`);
    assert.equal(result.status, 200); return result.body;
  }
  async function notification(id) { return (await rows('member_free_notifications', `&id=eq.${id}`))[0]; }
  async function state(id, expected, timeout) {
    return wait(async () => { const row = await notification(id); return row.status === expected ? row : null; }, `${id}: ${expected}`, timeout);
  }
  async function rpc(name, args) {
    const result = await request(config.url, `/rest/v1/rpc/${name}`, 'POST', args);
    assert.equal(result.status, 200); return result.body;
  }
  async function start(mode, workers, port = 55442) {
    const env = { ...process.env, NODE_OPTIONS: '', SUPABASE_URL: config.url, SUPABASE_SERVICE_ROLE_KEY: config.service,
      HOST: '127.0.0.1', PORT: String(port), EXPO_ACCESS_TOKEN: '', EXPO_BASE_URL: 'https://exp.host',
      DOTENV_CONFIG_PATH: '.env.member-free-empty.local', FREE_END_NOTIFICATIONS_ENABLED: String(workers),
      MEMBER_FREE_NOTIFICATIONS_ENABLED: String(workers), FREE_END_NOTIFICATIONS_INTERVAL_MS: '1000',
      MEMBER_FREE_NOTIFICATIONS_INTERVAL_MS: '1000', MEMBER_FREE_NOTIFICATIONS_MAX_ATTEMPTS: '3',
      LOCAL_PUSH_MOCK_MODE: mode, LOCAL_PUSH_MOCK_TOKEN: token, LOCAL_ENTRYPOINT_AUDIT: '' };
    const child = spawn(process.execPath, ['--require', './tests/member-free-push-mock.cjs', '--import', 'tsx', 'server/index.ts'],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    processes.add(child);
    const calls = []; let stdout = ''; let stderr = '';
    child.on('message', (message) => { if (message.type === 'mock-push') calls.push(message); });
    child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    await wait(async () => {
      assert.equal(child.exitCode, null, 'Normal API exited unexpectedly');
      if (!stdout.includes('API server listening')) return false;
      return (await request(`http://127.0.0.1:${port}`, '/health')).status === 200;
    }, 'API ready');
    return { child, calls, logs: () => ({ stdout, stderr }) };
  }
  async function stop(instance, graceful = true) {
    const closed = once(instance.child, 'close');
    if (graceful) instance.child.send({ type: 'local-verification-shutdown' }); else instance.child.kill('SIGKILL');
    const timer = setTimeout(() => instance.child.kill('SIGKILL'), 6000);
    const [code] = await closed; clearTimeout(timer); processes.delete(instance.child);
    if (graceful) assert.equal(code, 0);
    return instance.logs();
  }
  const sessions = {};
  async function apiOn(name, on) {
    const result = await request('http://127.0.0.1:55442', '/profiles/me/is-free', 'PUT', { is_free: on, duration_minutes: 30 }, sessions[name]);
    assert.equal(result.status, 200); return result;
  }
  async function makePending(label) {
    const api = await start('success', false);
    try {
      const before = await rows('profiles', `&id=eq.${A}`);
      const invalid = await request('http://127.0.0.1:55442', '/profiles/me/is-free', 'PUT', { is_free: true }, 'invalid');
      assert.equal(invalid.status, 401); assert.deepEqual(await rows('profiles', `&id=eq.${A}`), before);
      await apiOn('A', false); await apiOn('B', false); await apiOn('B', true);
      const result = await apiOn('A', true);
      const profile = (await rows('profiles', `&id=eq.${A}`))[0];
      assert.equal(profile.is_free, result.body.is_free);
      assert.equal(Date.parse(profile.free_until), Date.parse(result.body.free_until));
      const event = (await rows('member_free_events', `&actor_user_id=eq.${A}&actor_period_id=eq.${profile.free_period_id}`))[0];
      const queue = await rows('member_free_notifications', `&event_id=eq.${event.id}`);
      assert.equal(queue.length, 1); assert.equal(queue[0].recipient_user_id, B);
      assert.equal(queue[0].status, 'pending'); assert.equal(queue[0].attempts, 0); assert.equal(queue[0].lease_token, null);
      await apiOn('A', true);
      assert.deepEqual(await rows('member_free_notifications', `&event_id=eq.${event.id}`), queue);
      report.scenarios.push({ label, api: result, eventId: event.id, notificationId: queue[0].id, initial: queue[0] });
      return report.scenarios.at(-1);
    } finally { await stop(api, false); }
  }
  async function expireLease(id) {
    const row = await notification(id); assert.equal(row.status, 'processing');
    assert.equal(row.recipient_user_id, B);
    const result = await request(config.url, `/rest/v1/member_free_notifications?id=eq.${id}`, 'PATCH',
      { lease_expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal(result.status, 200);
  }
  function count(instance, id) { return instance.calls.filter((call) => call.messages[0].data.notificationId === id).length; }
  try {
    // Fail closed before login, fixture writes or process startup. Compare both DB and cluster identity.
    const identity = spawnSync('docker', ['exec', 'imahima-member-free-test-db', 'psql', '-X', '-U', 'supabase_admin',
      '-d', 'imahima_member_free_test', '-Atc', 'select current_database(),system_identifier from pg_control_system()'], { encoding: 'utf8', windowsHide: true });
    assert.equal(identity.status, 0); assert.equal(identity.stdout.trim(), config.identity);
    report.identity = identity.stdout.trim();
    for (const name of ['auth', 'rest']) {
      const inspected = spawnSync('docker', ['inspect', `imahima-member-free-api-${name}`], { encoding: 'utf8', windowsHide: true });
      assert.equal(inspected.status, 0);
      const meta = JSON.parse(inspected.stdout)[0];
      const key = name === 'auth' ? 'GOTRUE_DB_DATABASE_URL=' : 'PGRST_DB_URI=';
      const url = new URL(meta.Config.Env.find((value) => value.startsWith(key)).slice(key.length));
      assert.equal(url.hostname, 'host.docker.internal'); assert.equal(url.port, '55439'); assert.equal(url.pathname, '/imahima_member_free_test');
    }
    identityVerified = true;
    report.before = (await rows('member_free_notifications')).map(({ id, status, attempts }) => ({ id, status, attempts }));
    assert.ok(report.before.every((row) => ['sent', 'cancelled', 'exhausted'].includes(row.status)), 'Unrelated active queue requires investigation');
    assert.equal((await rows('user_device_tokens')).length, 0, 'Stop if any device token already exists');
    for (const [name, id] of Object.entries({ A, B })) {
      const user = await request(config.url, `/auth/v1/admin/users/${id}`); assert.equal(user.status, 200);
      const login = await request(config.url, '/auth/v1/token?grant_type=password', 'POST', { email: user.body.email, password: config.password }, config.anon);
      assert.equal(login.status, 200); sessions[name] = login.body.access_token;
    }
    assert.equal((await rows('room_members', `&room_id=eq.${prior.room}`)).filter((row) => [A, B].includes(row.user_id)).length, 2);
    const inserted = await request(config.url, '/rest/v1/user_device_tokens', 'POST',
      { user_id: B, expo_push_token: token, platform: 'test', device_name: 'MOCK ONLY - never deliver' });
    assert.equal(inserted.status, 201);

    // Two independent normal processes while the first owns an active lease.
    const concurrent = await makePending('success and concurrent lease exclusion');
    const first = await start('hold', true);
    await wait(() => count(first, concurrent.notificationId) === 1, 'first mocked send');
    await state(concurrent.notificationId, 'processing');
    const second = await start('success', true, 55443);
    await pause(1300);
    assert.equal(count(second, concurrent.notificationId), 0);
    assert.equal((await notification(concurrent.notificationId)).attempts, 1);
    first.child.send({ type: 'mock-release', notificationId: concurrent.notificationId });
    concurrent.final = await state(concurrent.notificationId, 'sent');
    await pause(1200); assert.equal(count(first, concurrent.notificationId), 1); assert.equal(count(second, concurrent.notificationId), 0);
    assert.equal(concurrent.final.accepted_count, 1); assert.equal(concurrent.final.attempts, 1);
    concurrent.logs = await stop(first); await stop(second); concurrent.mockCalls = 1; concurrent.passed = true;

    const retry = await makePending('temporary failure and timed retry');
    const failing = await start('temporary', true);
    retry.failed = await state(retry.notificationId, 'failed');
    assert.equal(retry.failed.attempts, 1); assert.ok(Date.parse(retry.failed.next_attempt_at) > Date.parse(retry.failed.updated_at));
    assert.equal(Date.parse(retry.failed.next_attempt_at) - Date.parse(retry.failed.updated_at), 5000);
    await stop(failing);
    const recovering = await start('success', true);
    await pause(300);
    if (Date.now() < Date.parse(retry.failed.next_attempt_at)) {
      assert.equal(count(recovering, retry.notificationId), 0);
    }
    retry.final = await state(retry.notificationId, 'sent');
    assert.equal(retry.final.attempts, 2); assert.equal(retry.final.accepted_count, 1);
    assert.equal(count(recovering, retry.notificationId), 1); await stop(recovering); retry.mockCalls = 2; retry.passed = true;

    const exhausted = await makePending('max attempts and terminal exclusion');
    const alwaysFail = await start('temporary', true);
    exhausted.final = await state(exhausted.notificationId, 'exhausted', 25000);
    assert.equal(exhausted.final.attempts, 3); assert.equal(exhausted.final.accepted_count, 0);
    await pause(1200); assert.equal(count(alwaysFail, exhausted.notificationId), 3);
    await stop(alwaysFail); exhausted.mockCalls = 3; exhausted.passed = true;

    const permanent = await makePending('permanent failure is cancelled');
    const permanentWorker = await start('permanent', true);
    permanent.final = await state(permanent.notificationId, 'cancelled');
    assert.equal(permanent.final.attempts, 1); await pause(1200);
    assert.equal(count(permanentWorker, permanent.notificationId), 1); await stop(permanentWorker);
    permanent.mockCalls = 1; permanent.passed = true;

    for (const mode of ['hold', 'accepted-hold']) {
      const crash = await makePending(mode === 'hold' ? 'crash before acceptance and lease recovery' : 'crash after acceptance: at-least-once limitation');
      const doomed = await start(mode, true);
      await wait(() => count(doomed, crash.notificationId) === 1, 'in-flight mocked send');
      crash.processing = await state(crash.notificationId, 'processing');
      await stop(doomed, false); // hard process termination; leaves the real DB lease intact
      const rescue = await start('success', true);
      await pause(1200); assert.equal(count(rescue, crash.notificationId), 0);
      assert.equal((await notification(crash.notificationId)).attempts, 1);
      await expireLease(crash.notificationId); // scoped time injection, no reset or wait for default 120s
      crash.final = await state(crash.notificationId, 'sent');
      assert.equal(crash.final.attempts, 2); assert.notEqual(crash.final.lease_token, crash.processing.lease_token);
      crash.staleCompletion = await rpc('complete_member_free_notification', { p_notification: crash.notificationId,
        p_lease_token: crash.processing.lease_token, p_status: 'sent', p_accepted_count: 1 });
      assert.equal(crash.staleCompletion, false);
      assert.equal(count(rescue, crash.notificationId), 1); await stop(rescue);
      crash.mockCalls = 2; crash.simulatedAcceptances = mode === 'accepted-hold' ? 2 : 1;
      crash.leaseExpiryInjected = true; crash.passed = true;
    }
    report.passed = true;
  } finally {
    for (const child of processes) child.kill('SIGKILL');
    // Remove only this run's synthetic token. Keep prior data, users, queue and Docker resources.
    try {
      assert.ok(identityVerified, 'No DB cleanup before identity verification');
      const result = await request(config.url, `/rest/v1/user_device_tokens?expo_push_token=eq.${encodeURIComponent(token)}`, 'DELETE');
      report.fakeTokenRemoved = result.status === 200 || result.status === 204;
    } catch { report.fakeTokenRemoved = false; }
    if (identityVerified && !report.fakeTokenRemoved) report.passed = false;
    try {
      if (identityVerified) report.after = (await rows('member_free_notifications')).map(({ id, status, attempts, accepted_count }) => ({ id, status, attempts, accepted_count }));
    } catch (error) {
      report.passed = false;
      throw error;
    } finally {
      writeFileSync('tests/member-free-push-integration-results.json', JSON.stringify(report, null, 2));
      if (identityVerified) assert.equal(report.fakeTokenRemoved, true, 'Synthetic token cleanup failed');
    }
  }
});
