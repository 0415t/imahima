import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PushSendError } from '../server/services/notifications';
import { createAuthorizedNotificationSender } from '../server/services/notification-delivery';

import {
  createFreeEndNotificationPoller,
  type FreeEndNotificationClaim,
  type FreeEndNotificationDependencies,
} from '../server/jobs/free-end-notifications';

const baseClaim: FreeEndNotificationClaim = {
  claimId: 'claim-1',
  userId: 'user-1',
  freeUntil: '2026-11-07T12:00:00.000Z',
  attempts: 1,
  leaseToken: 'lease-token-1',
  leaseExpiresAt: '2026-11-07T11:57:00.000Z',
};

type CallLog = {
  claims: number;
  validations: { claimId: string; leaseToken: string }[];
  tokenFetches: string[];
  sends: { tokens: string[]; message: Parameters<NonNullable<FreeEndNotificationDependencies['sendPushNotifications']>>[1] }[];
  completions: { claimId: string; leaseToken: string; status: string; error?: string }[];
};

function createMocks(overrides: Partial<FreeEndNotificationDependencies> = {}) {
  const log: CallLog = { claims: 0, validations: [], tokenFetches: [], sends: [], completions: [] };
  const dependencies: FreeEndNotificationDependencies = {
    claimNotifications: async () => {
      log.claims += 1;
      return { claims: [baseClaim], error: null };
    },
    validateNotification: async (claimId, leaseToken) => {
      log.validations.push({ claimId, leaseToken });
      return { validation: { owned: true, stillValid: true }, error: null };
    },
    getDeviceTokens: async (userId) => {
      log.tokenFetches.push(userId);
      return { tokens: ['ExponentPushToken[device-1]'], error: null };
    },
    sendPushNotifications: async (tokens, message) => {
      log.sends.push({ tokens, message });
      return { sent: tokens.length, error: null };
    },
    completeNotification: async (claimId, leaseToken, status, error) => {
      log.completions.push({ claimId, leaseToken, status, error });
      return { completed: true, error: null };
    },
    ...overrides,
  };
  return { dependencies, log };
}

describe('free-end notification poller', () => {
  for (const delayedPage of [null, '1']) {
    it(`skips the Expo request if authorization for page ${delayedPage ?? 'first'} returns at expiration`, async t => {
      const expiry = Date.parse(baseClaim.freeUntil);
      t.mock.timers.enable({ apis: ['Date'], now: expiry - 1000 });
      const transport = t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
        const [payload] = JSON.parse(init?.body as string);
        assert.equal(payload.data.expectedFreeUntil, baseClaim.freeUntil);
        return Response.json({ data: [{ status: 'ok', id: 'ticket' }] });
      });
      const sendAuthorized = createAuthorizedNotificationSender({
        async authorize(_kind, _id, _lease, after) {
          if (after === delayedPage) t.mock.timers.setTime(expiry);
          return { eligible: true, cursor: after === null ? '1' : null, targets: [{
            id: after ?? '0', token: `ExponentPushToken[device-${after ?? 'first'}]`,
            userId: 'user-1', installationId: 'install', generation: '1', revision: '1', version: 'v',
          }] };
        },
        async deleteInvalid() { assert.fail('No invalid ticket'); },
      })('free_end');
      const { dependencies, log } = createMocks({ sendAuthorized });
      await createFreeEndNotificationPoller(dependencies).runOnce();
      assert.equal(transport.mock.callCount(), delayedPage === null ? 0 : 1);
      assert.equal(log.completions[0]?.status, delayedPage === null ? 'cancelled' : 'sent');
    });
  }

  it('cancels a malformed authorized reminder deadline before sending', async () => {
    const { dependencies, log } = createMocks({
      async claimNotifications() {
        return { claims: [{ ...baseClaim, freeUntil: 'invalid' }], error: null };
      },
      async sendAuthorized() { assert.fail('Malformed deadline must not reach delivery'); },
    });
    await createFreeEndNotificationPoller(dependencies).runOnce();
    assert.equal(log.completions[0]?.status, 'cancelled');
  });

  it('retains confirmed acceptance if authorized delivery throws during cleanup', async () => {
    const { dependencies, log } = createMocks({
      async sendAuthorized(_id, _lease, _message, _signal, accepted) {
        accepted?.(1);
        throw new Error('Cleanup interrupted');
      },
    });
    await createFreeEndNotificationPoller(dependencies).runOnce();
    assert.equal(log.completions[0]?.status, 'sent');
    assert.equal(log.completions[0]?.leaseToken, baseClaim.leaseToken);
  });
  it('claims, validates, sends, and marks sent', async () => {
    const { dependencies, log } = createMocks();
    const poller = createFreeEndNotificationPoller(dependencies);

    await poller.runOnce();

    assert.equal(log.claims, 1);
    assert.deepEqual(log.validations, [{ claimId: 'claim-1', leaseToken: 'lease-token-1' }]);
    assert.deepEqual(log.tokenFetches, ['user-1']);
    assert.equal(log.sends.length, 1);
    assert.deepEqual(log.sends[0].tokens, ['ExponentPushToken[device-1]']);
    assert.equal(log.sends[0].message.categoryId, 'free_end');
    assert.equal(log.sends[0].message.data?.type, 'free_end');
    assert.equal(log.sends[0].message.data?.expectedFreeUntil, baseClaim.freeUntil);
    assert.equal(log.sends[0].message.data?.notificationId, baseClaim.claimId);
    assert.deepEqual(log.completions, [
      { claimId: 'claim-1', leaseToken: 'lease-token-1', status: 'sent', error: undefined },
    ]);
  });

  it('does not send when validation says not owned', async () => {
    const { dependencies, log } = createMocks({
      validateNotification: async () => ({
        validation: { owned: false, stillValid: true },
        error: null,
      }),
    });
    const poller = createFreeEndNotificationPoller(dependencies);

    await poller.runOnce();

    assert.equal(log.sends.length, 0);
    assert.equal(log.completions.length, 0);
  });

  it('cancels without sending when the free state is no longer valid', async () => {
    const { dependencies, log } = createMocks({
      validateNotification: async () => ({
        validation: { owned: true, stillValid: false },
        error: null,
      }),
    });
    const poller = createFreeEndNotificationPoller(dependencies);

    await poller.runOnce();

    assert.equal(log.sends.length, 0);
    assert.deepEqual(log.completions, [
      { claimId: 'claim-1', leaseToken: 'lease-token-1', status: 'cancelled', error: undefined },
    ]);
  });

  it('marks failed when validation errors', async () => {
    const { dependencies, log } = createMocks({
      validateNotification: async () => ({
        validation: null,
        error: new Error('db unavailable'),
      }),
    });
    const poller = createFreeEndNotificationPoller(dependencies);

    await poller.runOnce();

    assert.equal(log.sends.length, 0);
    assert.equal(log.completions.length, 1);
    assert.equal(log.completions[0].status, 'failed');
    assert.match(log.completions[0].error ?? '', /validate/);
  });

  it('marks failed when device token fetch errors', async () => {
    const { dependencies, log } = createMocks({
      getDeviceTokens: async () => ({ tokens: [], error: new Error('tokens error') }),
    });
    const poller = createFreeEndNotificationPoller(dependencies);

    await poller.runOnce();

    assert.equal(log.sends.length, 0);
    assert.equal(log.completions.length, 1);
    assert.equal(log.completions[0].status, 'failed');
    assert.match(log.completions[0].error ?? '', /tokens/);
  });

  it('cancels without sending when the user has no devices', async () => {
    const { dependencies, log } = createMocks({
      getDeviceTokens: async () => ({ tokens: [], error: null }),
    });
    const poller = createFreeEndNotificationPoller(dependencies);

    await poller.runOnce();

    assert.equal(log.sends.length, 0);
    assert.deepEqual(log.completions, [
      { claimId: 'claim-1', leaseToken: 'lease-token-1', status: 'cancelled', error: undefined },
    ]);
  });

  it('marks failed when push send errors (retryable by DB)', async () => {
    let sendCalls = 0;
    const { dependencies, log } = createMocks({
      sendPushNotifications: async () => {
        sendCalls += 1;
        return { sent: 0, error: new Error('expo unavailable') };
      },
    });
    const poller = createFreeEndNotificationPoller(dependencies);

    await poller.runOnce();

    assert.equal(sendCalls, 1);
    assert.equal(log.completions.length, 1);
    assert.equal(log.completions[0].status, 'failed');
    assert.match(log.completions[0].error ?? '', /send/);
  });

  for (const [label, result, status] of [
    ['permanent failures', { sent: 0, error: new PushSendError({ temporary: 0, permanent: 1, unknown: 0 }) }, 'cancelled'],
    ['temporary failures', { sent: 0, error: new PushSendError({ temporary: 1, permanent: 0, unknown: 0 }) }, 'failed'],
    ['unknown failures', { sent: 0, error: new PushSendError({ temporary: 0, permanent: 0, unknown: 1 }) }, 'failed'],
    ['unclassified zero acceptance', { sent: 0, error: null }, 'failed'],
    ['partial acceptance', { sent: 1, error: new Error('another device failed') }, 'sent'],
  ] as const) {
    it(`completes ${label} as ${status} with the original lease`, async () => {
      const { dependencies, log } = createMocks({ sendPushNotifications: async () => result });
      await createFreeEndNotificationPoller(dependencies).runOnce();
      assert.equal(log.completions.length, 1);
      assert.equal(log.completions[0].status, status);
      assert.equal(log.completions[0].claimId, baseClaim.claimId);
      assert.equal(log.completions[0].leaseToken, baseClaim.leaseToken);
    });
  }

  it('leaves retry limits to DB claims and does not resend after the DB stops returning claims', async () => {
    let attempts = 0;
    let sends = 0;
    // DBの最大3回というclaim契約を模擬。実SQLの上限検証はSQLテストにある。
    const { dependencies, log } = createMocks({
      claimNotifications: async () => ({
        claims: attempts < 3 ? [{ ...baseClaim, attempts: ++attempts, leaseToken: `lease-${attempts}` }] : [],
        error: null,
      }),
      sendPushNotifications: async () => {
        sends += 1;
        return { sent: 0, error: new PushSendError({ temporary: 1, permanent: 0, unknown: 0 }) };
      },
    });
    const poller = createFreeEndNotificationPoller(dependencies);
    for (let i = 0; i < 5; i += 1) await poller.runOnce();
    assert.equal(sends, 3);
    assert.deepEqual(log.completions.map(({ status, leaseToken }) => ({ status, leaseToken })), [
      { status: 'failed', leaseToken: 'lease-1' },
      { status: 'failed', leaseToken: 'lease-2' },
      { status: 'failed', leaseToken: 'lease-3' },
    ]);
  });

  it('does not overlap runOnce executions', async () => {
    let releaseClaim: () => void = () => {};
    const { dependencies, log } = createMocks({
      claimNotifications: async () => {
        log.claims += 1;
        await new Promise<void>((resolve) => {
          releaseClaim = resolve;
        });
        return { claims: [], error: null };
      },
    });
    const poller = createFreeEndNotificationPoller(dependencies);

    const first = poller.runOnce();
    const second = poller.runOnce();
    await second;
    assert.equal(log.claims, 1);
    releaseClaim();
    await first;
    assert.equal(log.claims, 1);
  });

  it('stop prevents further cycles and waits for the running cycle', async () => {
    let releaseClaim: () => void = () => {};
    const { dependencies, log } = createMocks({
      claimNotifications: async () => {
        log.claims += 1;
        await new Promise<void>((resolve) => {
          releaseClaim = resolve;
        });
        return { claims: [], error: null };
      },
    });
    const poller = createFreeEndNotificationPoller(dependencies, { intervalMs: 10 });

    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stopPromise = poller.stop();
    releaseClaim();
    await stopPromise;

    const claimsAtStop = log.claims;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(log.claims, claimsAtStop);
  });

  it('claim error does not throw and does not send', async () => {
    const { dependencies, log } = createMocks({
      claimNotifications: async () => ({ claims: [], error: new Error('rpc error') }),
    });
    const poller = createFreeEndNotificationPoller(dependencies);

    await poller.runOnce();

    assert.equal(log.sends.length, 0);
    assert.equal(log.completions.length, 0);
  });
});
