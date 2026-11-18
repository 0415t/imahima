import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createMemberFreeNotificationPoller, parseMemberFreeMaxAttempts, type MemberFreeClaim, type MemberFreeDependencies } from '../server/jobs/member-free-notifications';
import { createPushNotificationService, PushSendError, type PushClient } from '../server/services/notifications';

const claim: MemberFreeClaim = { notificationId: 'n1', eventId: 'e1', recipientUserId: 'recipient', actorName: '太郎', attempts: 1, leaseToken: 'lease' };
type Completion = Parameters<MemberFreeDependencies['completeNotification']>;
function fixture(overrides: Partial<MemberFreeDependencies> = {}) {
  const completions: Completion[] = [];
  const sends: { tokens: string[]; body: string; data?: Record<string, unknown> }[] = [];
  let validations = 0;
  const dependencies: MemberFreeDependencies = {
    claimNotifications: async () => ({ claims: [claim], error: null }),
    validateNotification: async () => { validations++; return { validation: { owned: true, stillValid: true }, error: null }; },
    getDeviceTokens: async (id) => { assert.equal(id, 'recipient'); return { tokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'], error: null }; },
    sendPushNotifications: async (tokens, message) => {
      sends.push({ tokens, body: message.body, data: message.data });
      return { sent: 2, error: null, failures: { temporary: 0, permanent: 0, unknown: 0 } };
    },
    completeNotification: async (...args) => { completions.push(args); return { completed: true, error: null }; },
    ...overrides,
  };
  return { dependencies, completions, sends, validations: () => validations };
}

describe('member-free notification poller', () => {
  it('keeps the default request deadline at 10 seconds', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let signal: AbortSignal | undefined;
    const f = fixture({ claimNotifications: (incoming) => {
      signal = incoming;
      return new Promise(() => {});
    } });
    const poller = createMemberFreeNotificationPoller(f.dependencies);
    let finished = false;
    const cycle = poller.runOnce().then(() => { finished = true; });
    await setImmediate();
    t.mock.timers.tick(9999); await setImmediate();
    assert.equal(finished, false); assert.equal(signal?.aborted, false);
    t.mock.timers.tick(1); await cycle;
    assert.equal(signal?.aborted, true);
    await poller.stop();
  });

  it('accepts default and boundary max attempts and rejects invalid values', () => {
    assert.equal(parseMemberFreeMaxAttempts(undefined), 3);
    for (const value of ['1', '3', '10']) assert.equal(parseMemberFreeMaxAttempts(value), Number(value));
    for (const value of ['', ' ', '0', '11', '1.1', 'NaN', 'Infinity']) {
      assert.throws(() => parseMemberFreeMaxAttempts(value), /must be an integer from 1 to 10/);
    }
  });

  it('does not send when stopped during the final eligibility check', async () => {
    let checked!: () => void;
    let release!: () => void;
    const checking = new Promise<void>((resolve) => { checked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const f = fixture({ validateNotification: async () => {
      if (++calls === 2) { checked(); await gate; }
      return { validation: { owned: true, stillValid: true }, error: null };
    } });
    const poller = createMemberFreeNotificationPoller(f.dependencies);
    const cycle = poller.runOnce();
    await checking;
    const stopping = poller.stop(); release();
    await Promise.all([cycle, stopping]);
    assert.equal(f.sends.length, 0);
  });

  for (const stage of ['claimNotifications', 'validateNotification', 'getDeviceTokens', 'sendPushNotifications', 'completeNotification'] as const) {
    it(`bounds a stalled ${stage}, aborts it and permits the next cycle`, { timeout: 1000 }, async () => {
      let calls = 0;
      let signal: AbortSignal | undefined;
      const f = fixture();
      const original = f.dependencies[stage];
      Object.assign(f.dependencies, { [stage]: (...args: unknown[]) => {
        calls++;
        if (calls === 1) {
          signal = args.at(-1) as AbortSignal;
          return new Promise(() => {});
        }
        return (original as (...args: unknown[]) => unknown)(...args);
      } });
      const poller = createMemberFreeNotificationPoller(f.dependencies, { requestTimeoutMs: 20 });
      await poller.runOnce();
      assert.equal(signal?.aborted, true);
      await poller.runOnce();
      assert.ok(calls >= 2);
      await poller.stop();
    });
  }

  it('bounds shutdown even if an in-flight dependency ignores cancellation', { timeout: 1000 }, async () => {
    let signal: AbortSignal | undefined;
    let release!: (value: { claims: MemberFreeClaim[]; error: null }) => void;
    const f = fixture({ claimNotifications: (incoming) => {
      signal = incoming;
      return new Promise((resolve) => { release = resolve; });
    } });
    const poller = createMemberFreeNotificationPoller(f.dependencies, { requestTimeoutMs: 500, stopTimeoutMs: 20 });
    const running = poller.runOnce();
    await poller.stop();
    assert.equal(signal?.aborted, true);
    release({ claims: [claim], error: null });
    await running;
    assert.equal(f.sends.length, 0);
  });

  it('sends to every recipient device with the event ID and original lease', async () => {
    const f = fixture();
    await createMemberFreeNotificationPoller(f.dependencies).runOnce();
    assert.equal(f.validations(), 2);
    assert.equal(f.sends[0].body, '太郎さんが暇になりました！');
    assert.equal(f.sends[0].tokens.length, 2);
    assert.deepEqual(f.sends[0].data, { type: 'member_free', eventId: 'e1', notificationId: 'n1' });
    assert.deepEqual(f.completions[0].slice(0, 3), ['n1', 'lease', 'sent']);
    assert.equal(f.completions[0][4], 2);
  });

  it('uses the fallback name and deduplicates identical tokens', async () => {
    const f = fixture({
      claimNotifications: async () => ({ claims: [{ ...claim, actorName: '  ' }], error: null }),
      getDeviceTokens: async () => ({ tokens: ['ExponentPushToken[a]', 'ExponentPushToken[a]'], error: null }),
    });
    await createMemberFreeNotificationPoller(f.dependencies).runOnce();
    assert.equal(f.sends[0].body, 'メンバーが暇になりました！');
    assert.equal(f.sends[0].tokens.length, 1);
  });

  for (const [temporary, permanent, unknown, status] of [[1, 0, 0, 'failed'], [0, 1, 0, 'cancelled'], [0, 0, 1, 'failed'], [1, 1, 0, 'failed']] as const) {
    it(`classifies ${temporary}/${permanent}/${unknown} failures as ${status}`, async () => {
      const failures = { temporary, permanent, unknown };
      const f = fixture({ sendPushNotifications: async () => ({ sent: 0, error: new PushSendError(failures), failures }) });
      await createMemberFreeNotificationPoller(f.dependencies).runOnce();
      assert.equal(f.completions[0][2], status);
      assert.equal(f.completions[0][4], 0);
    });
  }

  it('records partial acceptance as sent without retrying that recipient', async () => {
    let status = 'pending';
    const f = fixture({
      claimNotifications: async () => ({ claims: status === 'pending' ? [claim] : [], error: null }),
      sendPushNotifications: async () => ({ sent: 1, error: null, failures: { temporary: 1, permanent: 0, unknown: 0 } }),
    });
    const originalComplete = f.dependencies.completeNotification;
    f.dependencies.completeNotification = async (...args) => { status = args[2]; return originalComplete(...args); };
    const poller = createMemberFreeNotificationPoller(f.dependencies);
    await poller.runOnce(); await poller.runOnce();
    assert.equal(status, 'sent');
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0][4], 1);
    assert.match(f.completions[0][3] ?? '', /temporary=1/);
  });

  for (const when of ['before device lookup', 'after device lookup']) {
    it(`cancels eligibility changes ${when}`, async () => {
      let checks = 0;
      const f = fixture({ validateNotification: async () => ({
        validation: { owned: true, stillValid: ++checks < (when === 'before device lookup' ? 1 : 2) }, error: null,
      }) });
      await createMemberFreeNotificationPoller(f.dependencies).runOnce();
      assert.equal(f.sends.length, 0);
      assert.equal(f.completions[0][2], 'cancelled');
    });
  }

  it('does not send or complete after losing lease ownership', async () => {
    const f = fixture({ validateNotification: async () => ({ validation: { owned: false, stillValid: true }, error: null }) });
    await createMemberFreeNotificationPoller(f.dependencies).runOnce();
    assert.equal(f.sends.length, 0); assert.equal(f.completions.length, 0);
  });

  it('cancels users with no registered devices', async () => {
    const f = fixture({ getDeviceTokens: async () => ({ tokens: [], error: null }) });
    await createMemberFreeNotificationPoller(f.dependencies).runOnce();
    assert.equal(f.completions[0][2], 'cancelled'); assert.equal(f.sends.length, 0);
  });

  it('keeps recipient outcomes independent and continues after a thrown transport error', async () => {
    let calls = 0;
    const f = fixture({
      claimNotifications: async () => ({ claims: [claim, { ...claim, notificationId: 'n2' }], error: null }),
      sendPushNotifications: async () => {
        if (++calls === 1) throw new Error('secret transport details');
        return { sent: 1, error: null, failures: { temporary: 0, permanent: 0, unknown: 0 } };
      },
    });
    await createMemberFreeNotificationPoller(f.dependencies).runOnce();
    assert.deepEqual(f.completions.map((c) => c[2]), ['failed', 'sent']);
    assert.ok(!f.completions[0][3]?.includes('secret'));
  });

  it('marks lookup failures retryable', async () => {
    for (const overrides of [
      { getDeviceTokens: async () => ({ tokens: [], error: new Error('db') }) },
      { validateNotification: async () => ({ validation: null, error: new Error('db') }) },
    ]) {
      const f = fixture(overrides);
      await createMemberFreeNotificationPoller(f.dependencies).runOnce();
      assert.equal(f.completions[0][2], 'failed'); assert.equal(f.sends.length, 0);
    }
  });

  it('does not overlap cycles and waits for the in-flight work on stop', async () => {
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture({ claimNotifications: async () => { calls++; await gate; return { claims: [claim], error: null }; } });
    const poller = createMemberFreeNotificationPoller(f.dependencies);
    const cycle = poller.runOnce();
    const duplicate = poller.runOnce();
    let didStop = false;
    const stop = poller.stop().then(() => { didStop = true; });
    await Promise.resolve(); assert.equal(didStop, false);
    release(); await Promise.all([cycle, duplicate, stop]);
    await poller.runOnce();
    assert.equal(calls, 1); assert.equal(f.sends.length, 0);
  });

  it('tolerates claim and completion outages without sending the next recipient twice', async () => {
    const f = fixture({ completeNotification: async () => { throw new Error('db'); } });
    await createMemberFreeNotificationPoller(f.dependencies).runOnce();
    assert.equal(f.sends.length, 1);
    const unavailable = fixture({ claimNotifications: async () => ({ claims: [], error: new Error('db') }) });
    await createMemberFreeNotificationPoller(unavailable.dependencies).runOnce();
    assert.equal(unavailable.sends.length, 0);
  });

  it('uses the existing Expo service and preserves prior chunk acceptance', async () => {
    let count = 0;
    const client: PushClient = {
      chunkPushNotifications: (messages) => messages.map((m) => [m]),
      sendPushNotificationsAsync: async () => {
        if (++count === 2) throw new Error('offline');
        return [{ status: 'ok', id: 'ticket' }];
      },
    };
    const service = createPushNotificationService({ client, deleteDeviceToken: async () => ({ error: null }) });
    const f = fixture({ sendPushNotifications: service.sendPushNotifications });
    await createMemberFreeNotificationPoller(f.dependencies).runOnce();
    assert.equal(f.completions[0][2], 'sent'); assert.equal(f.completions[0][4], 1);
    assert.match(f.completions[0][3] ?? '', /unknown=1/);
  });

  it('stops retrying when the DB no longer grants claims at its attempt limit', async () => {
    let attempts = 0;
    const f = fixture({
      claimNotifications: async () => ({ claims: attempts < 3 ? [{ ...claim, attempts: ++attempts }] : [], error: null }),
      sendPushNotifications: async () => ({ sent: 0, error: new Error('unknown'), failures: { temporary: 0, permanent: 0, unknown: 1 } }),
    });
    const poller = createMemberFreeNotificationPoller(f.dependencies);
    for (let i = 0; i < 5; i++) await poller.runOnce();
    assert.equal(f.completions.length, 3); // 実DBの回数制限はSQLテストで別途確認。
  });
});
