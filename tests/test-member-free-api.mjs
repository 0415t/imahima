// Real Auth -> Express -> PostgREST -> dedicated PostgreSQL. No external HTTP.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';

test('dedicated local Auth and availability API integration', { timeout: 60000 }, async () => {
  const config = JSON.parse(readFileSync('.env.member-free-api.local', 'utf8'));
  assert.equal(config.url, 'http://127.0.0.1:55440');
  assert.equal(config.api, 'http://127.0.0.1:55441');
  const report = { at: new Date().toISOString(), checks: [], users: {}, responses: {}, db: {} };
  async function request(base, path, method = 'GET', body, token, key = config.service) {
    const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(10000),
      headers: { apikey: key, Authorization: `Bearer ${token ?? key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null };
  }
  async function rest(table, query = '') {
    const response = await request(config.url, `/rest/v1/${table}${query}`);
    assert.equal(response.status, 200, `Dedicated REST read failed for ${table}`);
    return response.body;
  }
  async function snapshot() {
    return { profiles: await rest('profiles', '?select=id,is_free,free_until,free_period_id'),
      events: await rest('member_free_events', '?select=*'),
      outbox: await rest('member_free_notifications', '?select=*') };
  }
  try {
    const before = await snapshot();
    assert.equal(before.events.length, 0, 'Use an empty dedicated fixture environment');
    assert.equal(before.profiles.length, 0, 'Use an empty dedicated fixture environment');
    const sessions = {};
    for (const name of ['A', 'B']) {
      const email = `api-${name.toLowerCase()}-${randomUUID()}@example.test`;
      const created = await request(config.url, '/auth/v1/admin/users', 'POST', {
        email, password: config.password, email_confirm: true, user_metadata: { username: `API ${name}` },
      });
      assert.equal(created.status, 200, 'Dedicated Auth user creation failed');
      const login = await request(config.url, '/auth/v1/token?grant_type=password', 'POST', {
        email, password: config.password,
      }, config.anon, config.anon);
      assert.equal(login.status, 200, 'Dedicated Auth login failed');
      assert.equal(login.body.user.id, created.body.id);
      sessions[name] = login.body.access_token;
      report.users[name] = created.body.id;
      report.checks.push(`${name}: real Auth password login 200`);
      if (name === 'A') {
        const failed = await request(config.url, '/auth/v1/token?grant_type=password', 'POST', {
          email, password: `${config.password}-wrong`,
        }, config.anon, config.anon);
        assert.equal(failed.status, 400);
        report.responses.failedLogin = { status: failed.status, code: failed.body.error_code };
      }
    }
    const room = randomUUID(); report.room = room;
    const roomResult = await request(config.url, '/rest/v1/rooms', 'POST', { id: room, room_name: 'Dedicated API test' });
    assert.equal(roomResult.status, 201, 'Room fixture creation failed');
    const members = await request(config.url, '/rest/v1/room_members', 'POST',
      Object.values(report.users).map((id) => ({ room_id: room, user_id: id })));
    assert.equal(members.status, 201, 'Membership fixture creation failed');

    const initial = await snapshot();
    for (const invalid of ['', 'invalid-test-token']) {
      const response = await fetch(`${config.api}/profiles/me/is-free`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...(invalid ? { Authorization: `Bearer ${invalid}` } : {}) },
        body: JSON.stringify({ is_free: true, duration_minutes: 30 }), signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 401);
      report.responses[invalid ? 'invalidToken' : 'missingToken'] = { status: response.status, body: await response.json() };
    }
    assert.deepEqual(await snapshot(), initial, 'Unauthorized API calls changed DB');
    report.checks.push('missing/invalid Bearer: 401 and no DB mutation');

    for (const name of ['B', 'A']) {
      const result = await request(config.api, '/profiles/me/is-free', 'PUT', {
        is_free: true, duration_minutes: 30,
        // The route must always derive the actor from Auth, ignoring supplied identity.
        user_id: name === 'A' ? report.users.B : report.users.A,
      }, sessions[name]);
      report.responses[`${name}On`] = result;
      assert.equal(result.status, 200); assert.equal(result.body.is_free, true);
      const state = await snapshot();
      const profile = state.profiles.find((row) => row.id === report.users[name]);
      assert.equal(profile.is_free, result.body.is_free);
      assert.equal(new Date(profile.free_until).getTime(), new Date(result.body.free_until).getTime());
      assert.equal(state.events.length, name === 'B' ? 1 : 2);
      assert.equal(state.outbox.length, name === 'B' ? 0 : 1);
      report.checks.push(`${name} ON: HTTP response matches DB; event/outbox counts correct`);
    }
    const afterOn = await snapshot();
    const event = afterOn.events.find((row) => row.actor_user_id === report.users.A);
    const notification = afterOn.outbox[0];
    assert.equal(notification.event_id, event.id);
    assert.equal(notification.recipient_user_id, report.users.B);
    assert.equal(event.actor_period_id, afterOn.profiles.find((row) => row.id === report.users.A).free_period_id);
    assert.equal(notification.recipient_period_id, afterOn.profiles.find((row) => row.id === report.users.B).free_period_id);
    assert.equal(notification.status, 'pending'); assert.equal(notification.attempts, 0);
    assert.equal(notification.lease_token, null); assert.equal(notification.accepted_count, 0);
    const repeated = await request(config.api, '/profiles/me/is-free', 'PUT', { is_free: true, duration_minutes: 60 }, sessions.A);
    report.responses.AReOn = repeated; assert.equal(repeated.status, 200);
    const afterRepeat = await snapshot();
    assert.deepEqual(afterRepeat.events, afterOn.events);
    assert.deepEqual(afterRepeat.outbox, afterOn.outbox);
    assert.equal(afterRepeat.profiles.find((row) => row.id === report.users.A).free_period_id, event.actor_period_id);
    report.checks.push('A re-ON: unchanged event/outbox and ON period');
    const manual = await request(config.api, '/notifications/test', 'POST', {}, sessions.A);
    report.responses.manualPush = manual;
    assert.equal(manual.status, 404);
    assert.deepEqual(await snapshot(), afterRepeat);
    report.checks.push('manual push: 404; no DB change; workers not loaded');
    report.db = afterRepeat;
    report.passed = true;
  } finally {
    // Access tokens, passwords and API keys are deliberately excluded.
    writeFileSync('tests/member-free-api-results.json', JSON.stringify(report, null, 2));
  }
});
