import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createExtendClient, createFreeEndActionHandler, extractNotificationId, EXTEND_30_ACTION } from '../lib/free-end-action';
import { notifyAvailabilityChanged, subscribeAvailabilityChanged } from '../lib/availability-events';

const response = (data: unknown = { type: 'free_end', notificationId: 'claim-1', profileId: 'untrusted' }) => ({
  actionIdentifier: EXTEND_30_ACTION, notification: { request: { content: { data } } },
});
const until = '2026-11-10T12:30:00.000Z';

describe('notification 30 minute extension', () => {
  it('ignores unrelated actions and malformed payloads', () => {
    for (const value of [null, {}, response(null), response({ type: 'free_end', notificationId: '' }),
      response({ type: 'other', notificationId: 'claim-1' }), { ...response(), actionIdentifier: 'default' }]) {
      assert.equal(extractNotificationId(value), null);
    }
  });

  it('uses only the claim ID and bearer token, then signals a display refresh', async () => {
    let calls = 0;
    let refreshes = 0;
    const unsubscribe = subscribeAvailabilityChanged(() => { refreshes += 1; });
    try {
      const post = createExtendClient({
        apiUrl: 'https://api.example.test/', getAccessToken: async () => 'session-token', onChanged: notifyAvailabilityChanged,
        fetch: async (url, init) => {
          calls += 1;
          assert.equal(url, 'https://api.example.test/profiles/me/is-free/extend-from-notification');
          assert.equal(init?.method, 'POST');
          assert.deepEqual(init?.headers, { Authorization: 'Bearer session-token', 'Content-Type': 'application/json' });
          assert.deepEqual(JSON.parse(init?.body as string), { claim_id: 'claim-1' });
          return Response.json({ is_free: true, free_until: until });
        },
      });
      const handle = createFreeEndActionHandler((id) => post('/profiles/me/is-free/extend-from-notification', { claim_id: id }));
      const results = await Promise.all([handle(response()), handle(response())]);
      assert.deepEqual(results, [{ ok: true, freeUntil: until }, { ok: true, freeUntil: until }]);
      assert.equal(calls, 1);
      assert.equal(refreshes, 1);
      unsubscribe();
      notifyAvailabilityChanged();
      assert.equal(refreshes, 1);
    } finally { unsubscribe(); }
  });

  for (const [status, reason, refreshCount] of [[409, 'conflict', 1], [401, 'not-authenticated', 0], [500, 'server-error', 0]] as const) {
    it(`handles HTTP ${status} without reporting success`, async () => {
      let refreshes = 0;
      const post = createExtendClient({ apiUrl: 'https://api.example.test', getAccessToken: async () => 'token',
        onChanged: () => { refreshes += 1; }, fetch: async () => new Response(null, { status }) });
      assert.deepEqual(await post('/extend'), { ok: false, reason });
      assert.equal(refreshes, refreshCount);
    });
  }

  it('does not call the API without a session or configuration', async () => {
    const options = { getAccessToken: async () => null, onChanged: () => {}, fetch: async () => { throw new Error('must not fetch'); } };
    assert.deepEqual(await createExtendClient(options)('/extend'), { ok: false, reason: 'not-configured' });
    assert.deepEqual(await createExtendClient({ ...options, apiUrl: 'https://api.example.test' })('/extend'), { ok: false, reason: 'not-authenticated' });
  });

  it('handles auth exceptions, network failures and invalid success responses', async () => {
    for (const options of [
      { getAccessToken: async () => { throw new Error('storage'); }, fetch: async () => Response.json({}) },
      { getAccessToken: async () => 'token', fetch: async () => { throw new Error('offline'); } },
      { getAccessToken: async () => 'token', fetch: async () => Response.json({ is_free: true, free_until: null }) },
    ]) {
      const post = createExtendClient({ ...options, apiUrl: 'https://api.example.test', onChanged: () => { assert.fail('must not refresh'); } });
      assert.deepEqual(await post('/extend'), { ok: false, reason: 'server-error' });
    }
  });

  it('allows retry after a failed action and ignores ordinary notifications', async () => {
    let calls = 0;
    const handle = createFreeEndActionHandler(async () => { calls += 1; throw new Error('offline'); });
    assert.equal(await handle({}), null);
    await handle(response());
    await handle(response());
    assert.equal(calls, 2);
  });
});
