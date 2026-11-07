import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
  sends: { tokens: string[]; message: { title: string; body: string; data?: Record<string, unknown> } }[];
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
  it('claims, validates, sends, and marks sent', async () => {
    const { dependencies, log } = createMocks();
    const poller = createFreeEndNotificationPoller(dependencies);

    await poller.runOnce();

    assert.equal(log.claims, 1);
    assert.deepEqual(log.validations, [{ claimId: 'claim-1', leaseToken: 'lease-token-1' }]);
    assert.deepEqual(log.tokenFetches, ['user-1']);
    assert.equal(log.sends.length, 1);
    assert.deepEqual(log.sends[0].tokens, ['ExponentPushToken[device-1]']);
    assert.equal(log.sends[0].message.data?.type, 'free_end_reminder');
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

  it('marks sent without sending when the user has no devices', async () => {
    const { dependencies, log } = createMocks({
      getDeviceTokens: async () => ({ tokens: [], error: null }),
    });
    const poller = createFreeEndNotificationPoller(dependencies);

    await poller.runOnce();

    assert.equal(log.sends.length, 0);
    assert.deepEqual(log.completions, [
      { claimId: 'claim-1', leaseToken: 'lease-token-1', status: 'sent', error: undefined },
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
