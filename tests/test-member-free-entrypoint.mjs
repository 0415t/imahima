import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

test('normal server/index.ts with dedicated Auth, DB and guarded workers', { timeout: 60000 }, async () => {
  const config = JSON.parse(readFileSync('.env.member-free-api.local', 'utf8'));
  assert.equal(config.url, 'http://127.0.0.1:55440');
  const api = 'http://127.0.0.1:55442';
  const report = { at: new Date().toISOString(), responses: {}, checks: [], users: {}, passed: false };
  const processes = new Set();
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(check, label) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) { if (await check()) return; await pause(100); }
    throw new Error(`Timed out: ${label}`);
  }
  async function request(base, path, method = 'GET', body, token = config.service) {
    const response = await fetch(`${base}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { apikey: config.service, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  async function rows(table, query = '') {
    const result = await request(config.url, `/rest/v1/${table}?select=*${query}`);
    assert.equal(result.status, 200); return result.body;
  }
  async function start(workers) {
    // Explicit env overrides prevent dotenv from loading any production values.
    const env = { ...process.env, SUPABASE_URL: config.url, SUPABASE_SERVICE_ROLE_KEY: config.service,
      HOST: '127.0.0.1', PORT: '55442', EXPO_ACCESS_TOKEN: '', DOTENV_CONFIG_PATH: '.env.member-free-empty.local',
      FREE_END_NOTIFICATIONS_ENABLED: String(workers), MEMBER_FREE_NOTIFICATIONS_ENABLED: String(workers),
      FREE_END_NOTIFICATIONS_INTERVAL_MS: '1000', MEMBER_FREE_NOTIFICATIONS_INTERVAL_MS: '1000',
      LOCAL_ENTRYPOINT_AUDIT: workers ? 'workers' : 'api', NODE_OPTIONS: '' };
    const child = spawn(process.execPath, ['--require', './tests/member-free-entrypoint-guard.cjs',
      '--import', 'tsx', 'server/index.ts'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    processes.add(child);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await until(async () => {
      assert.equal(child.exitCode, null, 'Normal entrypoint exited before readiness');
      if (!stdout.includes('API server listening')) return false;
      const health = await request(api, '/health');
      return health.status === 200;
    }, 'normal entrypoint health');
    return { child, logs: () => ({ stdout, stderr }) };
  }
  async function stop(instance, graceful) {
    const closed = once(instance.child, 'close');
    if (graceful) instance.child.send({ type: 'local-verification-shutdown' });
    else instance.child.kill();
    const timeout = setTimeout(() => instance.child.kill(), 10000);
    const [code] = await closed;
    clearTimeout(timeout); processes.delete(instance.child);
    if (graceful) assert.equal(code, 0, 'Normal worker shutdown must exit cleanly');
    return instance.logs();
  }
  writeFileSync('.env.member-free-empty.local', '');
  try {
    assert.equal((await rows('user_device_tokens')).length, 0, 'No real device tokens allowed');
    report.beforeOutbox = await rows('member_free_notifications');
    // New fixture users keep earlier API evidence intact, except real worker processing of pending rows.
    const tokens = {};
    for (const name of ['A', 'B']) {
      const email = `entrypoint-${name.toLowerCase()}-${randomUUID()}@example.test`;
      const created = await request(config.url, '/auth/v1/admin/users', 'POST', {
        email, password: config.password, email_confirm: true, user_metadata: { username: `Entrypoint ${name}` },
      });
      assert.equal(created.status, 200); report.users[name] = created.body.id;
      const login = await request(config.url, '/auth/v1/token?grant_type=password', 'POST', { email, password: config.password }, config.anon);
      assert.equal(login.status, 200); tokens[name] = login.body.access_token;
    }
    report.room = randomUUID();
    assert.equal((await request(config.url, '/rest/v1/rooms', 'POST', { id: report.room, room_name: 'Normal entrypoint verification' })).status, 201);
    assert.equal((await request(config.url, '/rest/v1/room_members', 'POST', Object.values(report.users).map((user_id) => ({ room_id: report.room, user_id })))).status, 201);
    const normal = await start(false);
    const initialProfiles = await rows('profiles');
    report.responses.invalid = await request(api, '/profiles/me/is-free', 'PUT', { is_free: true, duration_minutes: 30 }, 'invalid-token');
    assert.equal(report.responses.invalid.status, 401);
    assert.deepEqual(await rows('profiles'), initialProfiles);
    report.checks.push('normal entrypoint: invalid Auth rejected without profile mutation');
    for (const name of ['B', 'A']) {
      const result = await request(api, '/profiles/me/is-free', 'PUT', { is_free: true, duration_minutes: 30 }, tokens[name]);
      assert.equal(result.status, 200); report.responses[`${name}On`] = result;
      const profile = (await rows('profiles', `&id=eq.${report.users[name]}`))[0];
      assert.equal(profile.is_free, result.body.is_free);
      assert.equal(new Date(profile.free_until).getTime(), new Date(result.body.free_until).getTime());
    }
    report.event = (await rows('member_free_events', `&actor_user_id=eq.${report.users.A}`))[0];
    const outbox = await rows('member_free_notifications', `&event_id=eq.${report.event.id}`);
    assert.equal(outbox.length, 1); assert.equal(outbox[0].recipient_user_id, report.users.B);
    assert.equal(outbox[0].status, 'pending'); report.pending = outbox[0];
    report.responses.reOn = await request(api, '/profiles/me/is-free', 'PUT', { is_free: true, duration_minutes: 60 }, tokens.A);
    assert.equal(report.responses.reOn.status, 200);
    assert.equal((await rows('member_free_events', `&actor_user_id=eq.${report.users.A}`)).length, 1);
    assert.deepEqual(await rows('member_free_notifications', `&event_id=eq.${report.event.id}`), outbox);
    report.responses.manual = await request(api, '/notifications/test', 'POST', {}, tokens.A);
    assert.equal(report.responses.manual.status, 200); assert.equal(report.responses.manual.body.sent, 0);
    report.checks.push('normal entrypoint: B then A ON produces one pending row; re-ON deduplicated; manual push sends zero with no tokens');
    report.apiLogs = await stop(normal, false);

    const worker = await start(true);
    await until(async () => {
      const notification = (await rows('member_free_notifications', `&id=eq.${report.pending.id}`))[0];
      if (notification.status !== 'cancelled') return false;
      report.completed = notification; return true;
    }, 'real worker no-device completion');
    assert.equal(report.completed.last_error, 'No registered devices');
    assert.equal(report.completed.attempts, 1); assert.equal(report.completed.accepted_count, 0);
    report.workerLogs = await stop(worker, true);
    assert.ok(report.workerLogs.stdout.includes('Free-end notification poller started'));
    assert.ok(report.workerLogs.stdout.includes('Member-free notification poller started'));
    report.audit = JSON.parse(readFileSync('tests/member-free-entrypoint-worker-audit.json', 'utf8'));
    for (const rpc of ['claim_member_free_notifications', 'claim_free_end_notifications',
      'validate_member_free_notification', 'complete_member_free_notification']) {
      assert.ok(report.audit.fetches[`/rest/v1/rpc/${rpc} 200`] >= 1, `${rpc} must reach real dedicated DB`);
    }
    assert.equal(report.audit.blockedExternal, 0); assert.equal(report.audit.guardSelfTestPassed, true);
    report.afterOutbox = await rows('member_free_notifications');
    report.checks.push('both real workers start and use real claim RPCs; member worker validates and cancels no-device notification');
    report.checks.push('normal SIGTERM shutdown handler exits 0; no external HTTP attempted');
    report.passed = true;
  } finally {
    for (const child of processes) child.kill();
    // Redact nothing here: only explicitly selected non-secret fields/logs are recorded.
    writeFileSync('tests/member-free-entrypoint-results.json', JSON.stringify(report, null, 2));
  }
});
