import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { createApp } from '../server/app';
import type { GroupDependencies } from '../server/groups';
import { createAuthorizedNotificationSender } from '../server/services/notification-delivery';
import { loadSource } from './helpers/load-source';

for (const enabled of [false, true]) {
  it(`server entrypoint wires notification, group and chat dependencies (poller ${enabled})`, async () => {
    let args!: Parameters<typeof createApp>, starts = 0, stops = 0, closes = 0;
    const handlers = new Map<string, () => void>();
    const rpcCalls: { name: string; args: unknown }[] = [];
    const sdk = {
      auth: { getUser: async () => ({ data: { user: { id: 'actor' } }, error: null }) },
      rpc: async (name: string, values: unknown) => {
        rpcCalls.push({ name, args: values });
        return { data: [{ is_free: true, free_until: null }], error: null };
      },
    };
    const groups: GroupDependencies = {
      getUserId: async () => ({ userId: 'actor', error: null }), isMember: async () => true,
      execute: async () => ({ status: 200, data: {} }), rateSecret: 'test-only', consumeRate: async () => true,
    };
    const chat = { getUserId: groups.getUserId, isMember: groups.isMember, execute: groups.execute };
    const push = { sendPushNotifications: async () => ({ sent: 1, error: null }) };
    loadSource('server/index.ts', {
      'dotenv/config': {},
      './services/supabase': { serverSupabase: sdk },
      './device-verifier': { notificationSessionExtender: () => async () => ({ status: 503 }) },
      './services/groups': { groupService: (client: unknown, identity: unknown) => {
        assert.equal(client, sdk); assert.equal(typeof identity, 'function'); return groups;
      } },
      './services/chat': { chatService: (client: unknown, identity: unknown) => {
        assert.equal(client, sdk); assert.equal(identity, groups); return chat;
      } },
      './services/notifications': { createPushNotificationService: () => push },
      './services/notification-delivery': { createAuthorizedNotificationSender },
      './app': { createApp: (...received: Parameters<typeof createApp>) => {
        args = received;
        return { listen: (options: { port: number }) => {
          assert.equal(options.port, 3000);
          return { close: (done: () => void) => { closes++; done(); } };
        } };
      } },
      './jobs/free-end-notifications': { createFreeEndNotificationPoller: () => ({
        start: () => { starts++; }, stop: async () => { stops++; },
      }) },
      './jobs/member-free-notifications': {},
      './jobs/chat-message-notifications': {},
    }, { process: { env: { FREE_END_NOTIFICATIONS_ENABLED: enabled ? 'true' : undefined },
      on: (signal: string, callback: () => void) => handlers.set(signal, callback), exit: () => {} },
    console: { log: () => {} }, setTimeout, clearTimeout });
    assert.equal(args[2], groups); assert.equal(args[3], chat);
    assert.equal(args[5], undefined);
    const identity = await args[0].getUserId('mock');
    assert.equal(identity.userId, 'actor'); assert.equal(identity.error, null);
    await args[0].toggleIsFree('actor');
    await args[0].setIsFree('actor', true, 30);
    await args[0].extendIsFree('actor');
    assert.equal((await args[0].extendIsFreeFromNotification('actor', 'claim')).status, 503);
    assert.deepEqual(rpcCalls.map(c => c.name), ['toggle_profile_is_free', 'set_profile_is_free', 'extend_profile_is_free']);
    assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls[1].args)), { target_profile_id: 'actor', new_is_free: true, duration_minutes: 30 });
    assert.deepEqual(await args[1]?.sendPushNotifications([], { title: 'test', body: 'test' }), { sent: 1, error: null });
    assert.equal(starts, enabled ? 1 : 0);
    assert.equal(handlers.size, enabled ? 2 : 0);
    if (enabled) {
      handlers.get('SIGTERM')?.();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(stops, 1); assert.equal(closes, 1);
    }
  });
}
