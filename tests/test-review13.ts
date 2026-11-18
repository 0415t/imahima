import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { loadSource } from './helpers/load-source';
import { createExtendClient, createFreeEndActionHandler } from '../lib/free-end-action';
import { createPushNotificationService } from '../server/services/notifications';

for (const raw of [false, true]) {
  it(`handles Android task data (${raw ? 'raw JSON' : 'mapped'})`, async () => {
    let task!: (event: { data: unknown }) => Promise<string>;
    const ids: string[] = [];
    const module = loadSource('lib/notification-task.ts', {
      'expo-notifications': { BackgroundNotificationTaskResult: { NewData: 'new', NoData: 'none' },
        async registerTaskAsync() {}, async scheduleNotificationAsync() {} },
      'expo-task-manager': { defineTask(_name: string, callback: typeof task) { task = callback; } },
      'react-native': { Platform: { OS: 'android' } },
      './extend-free': { extendFreeFromNotification: async (id: string) => { ids.push(id); return { ok: true }; } },
      './free-end-action': { createFreeEndActionHandler },
    });
    const payload = { type: 'free_end', notificationId: 'claim-android' };
    const event = (content: unknown) => ({ data: { actionIdentifier: 'extend_30', notification: { request: { content } } } });
    assert.equal(await task(event(raw ? { dataString: JSON.stringify(payload) } : { data: payload })), 'new');
    assert.deepEqual(ids, ['claim-android']);
    for (const dataString of ['{broken', 'null', '[]', '123', '"text"']) {
      assert.equal(await task(event({ dataString })), 'none');
    }
    assert.deepEqual(ids, ['claim-android']);
    void module;
  });
}

for (const finishes of [true, false]) {
  it(`retries only processing claims with a bound (${finishes ? 'sent later' : 'never sent'})`, async () => {
    let calls = 0;
    let refreshes = 0;
    const delays: number[] = [];
    const post = createExtendClient({ apiUrl: 'https://example.test', getAccessToken: async () => 'token',
      onChanged: () => { refreshes++; }, sleep: async milliseconds => { delays.push(milliseconds); },
      fetch: async () => {
        calls++;
        if (!finishes || calls === 1) return Response.json({ code: 'notification-processing' }, { status: 409 });
        return Response.json({ is_free: true, free_until: '2026-11-17T12:00:00Z' });
      } });
    const result = await post('/profiles/me/is-free/extend-from-notification', { claim_id: 'same-id' });
    assert.equal(result.ok, finishes);
    assert.equal(calls, finishes ? 2 : 4);
    assert.equal(refreshes, finishes ? 1 : 0);
    assert.deepEqual(delays, finishes ? [250] : [250, 500, 1000]);
    if (!result.ok) assert.equal(result.reason, 'server-error');
  });
}

it('bounds total Push waiting time and retains earlier accepted chunks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let sends = 0;
  const service = createPushNotificationService({ deleteDeviceToken: async () => ({ error: null }),
    client: {
      chunkPushNotifications: messages => messages.map(message => [message]),
      sendPushNotificationsAsync: async () => {
        sends++;
        return sends === 1 ? [{ status: 'ok', id: 'accepted' }] : new Promise(() => {});
      },
    } });
  const pending = service.sendPushNotifications(['ExponentPushToken[a]', 'ExponentPushToken[b]', 'ExponentPushToken[c]'], { title: 'test', body: 'test' });
  await setImmediate();
  t.mock.timers.tick(30_000);
  const result = await pending;
  assert.equal(result.sent, 1);
  assert.deepEqual(result.failures, { temporary: 0, permanent: 0, unknown: 2 });
  assert.equal(result.error, null);
  assert.equal(sends, 2, 'do not start remaining chunks after the send deadline');
});

it('normalizes unsafe notification polling intervals at the poller boundary', async () => {
  const intervals: number[] = [];
  const { createFreeEndNotificationPoller } = loadSource<typeof import('../server/jobs/free-end-notifications')>(
    'server/jobs/free-end-notifications.ts', { '../services/notifications': {} }, {
      setInterval(_callback: unknown, milliseconds: number) { intervals.push(milliseconds); return 1; }, clearInterval() {},
    });
  for (const intervalMs of [undefined, NaN, Infinity, -1, 0, 999, 2 ** 31, 1000, 60_000]) {
    const poller = createFreeEndNotificationPoller({ claimNotifications: async () => ({ claims: [], error: null }) } as never, { intervalMs });
    poller.start();
    await setImmediate();
    await poller.stop();
  }
  assert.deepEqual(intervals, [60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 1000, 60_000]);
});

it('reports an entirely timed-out send as unknown and consumes a late SDK rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sdk = Promise.withResolvers<never>();
  const service = createPushNotificationService({ deleteDeviceToken: async () => ({ error: null }),
    client: { chunkPushNotifications: messages => [messages], sendPushNotificationsAsync: () => sdk.promise } });
  const pending = service.sendPushNotifications(['ExponentPushToken[test]'], { title: 'test', body: 'test' });
  t.mock.timers.tick(30_000);
  const result = await pending;
  assert.equal(result.sent, 0);
  assert.deepEqual(result.failures, { temporary: 0, permanent: 0, unknown: 1 });
  assert.ok(result.error);
  sdk.reject(new Error('late transport failure'));
  await setImmediate();
});

for (const body of [{ sent: 0, message: 'No registered devices' }, { sent: 1 }, null, { sent: '1' }]) {
  it(`checks actual Expo acceptance in the live Push test: ${JSON.stringify(body)}`, async () => {
    const errors: unknown[] = [];
    const logs: string[] = [];
    const fakeProcess = { env: { TEST_EMAIL: 'test@example.test', TEST_PASSWORD: 'dummy' }, exitCode: 0 };
    loadSource('integration/test-push-send.ts', {
      'dotenv/config': {}, '../lib/auth': { signInUser: async () => ({ session: { access_token: 'test', user: { id: 'self' } } }) },
      '../lib/supabase': { hasSupabaseConfig: true },
    }, { process: fakeProcess, fetch: async () => Response.json(body), console: { log: (...args: unknown[]) => logs.push(args.join(' ')), error: (error: unknown) => errors.push(error) } });
    await setImmediate();
    assert.equal(fakeProcess.exitCode, body?.sent === 1 ? 0 : 1);
    assert.equal(errors.length, body?.sent === 1 ? 0 : 1);
  });
}
