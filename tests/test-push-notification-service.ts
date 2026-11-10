import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPushNotificationService, PushSendError, type PushClient } from '../server/services/notifications';
import { createFreeEndNotificationPoller, type FreeEndNotificationDependencies } from '../server/jobs/free-end-notifications';

type Ticket = Awaited<ReturnType<PushClient['sendPushNotificationsAsync']>>[number];
const ok: Ticket = { status: 'ok', id: 'expo-ticket-id' };
const failure = (error?: Extract<Ticket, { status: 'error' }>['details']): Ticket => ({
  status: 'error', message: 'Expo rejected the message', details: error,
});
const tokens = Array.from({ length: 3 }, (_, i) => `ExponentPushToken[device-${i}]`);
const message = { title: 'imahima', body: 'あと5分です', categoryId: 'free_end', data: { notificationId: 'claim-1' } };

function setup(responses: (Ticket[] | Error)[], chunkSize = 100) {
  const deleted: string[] = [];
  const calls: Parameters<PushClient['sendPushNotificationsAsync']>[0][] = [];
  const client: PushClient = {
    chunkPushNotifications: (messages) => {
      const chunks = [];
      for (let i = 0; i < messages.length; i += chunkSize) chunks.push(messages.slice(i, i + chunkSize));
      return chunks;
    },
    sendPushNotificationsAsync: async (messages) => {
      calls.push(messages);
      const response = responses.shift();
      assert.ok(response, 'unexpected send');
      if (response instanceof Error) throw response;
      return response;
    },
  };
  const service = createPushNotificationService({
    client,
    deleteDeviceToken: async (token) => { deleted.push(token); return { error: null }; },
  });
  return { ...service, deleted, calls };
}

describe('Expo push ticket handling', () => {
  it('counts all accepted tickets and preserves the notification action payload', async () => {
    const service = setup([[ok, ok, ok]]);
    const result = await service.sendPushNotifications(tokens, message);
    assert.equal(result.sent, 3);
    assert.equal(result.error, null);
    assert.deepEqual(result.failures, { temporary: 0, permanent: 0, unknown: 0 });
    assert.equal(service.calls[0][0].categoryId, 'free_end');
    assert.deepEqual(service.calls[0][0].data, message.data);
  });

  it('classifies all rate-limit tickets as temporary failures', async () => {
    const service = setup([[failure({ error: 'MessageRateExceeded' }), failure({ error: 'MessageRateExceeded' })]]);
    const result = await service.sendPushNotifications(tokens.slice(0, 2), message);
    assert.equal(result.sent, 0);
    assert.deepEqual(result.failures, { temporary: 2, permanent: 0, unknown: 0 });
    assert.ok(result.error instanceof PushSendError);
    assert.equal(result.error.permanentOnly, false);
  });

  it('classifies permanent failures and deletes only unregistered device tokens', async () => {
    const service = setup([[failure({ error: 'DeviceNotRegistered' }), failure({ error: 'MessageTooBig' }), failure({ error: 'InvalidCredentials' })]]);
    const result = await service.sendPushNotifications(tokens, message);
    assert.equal(result.sent, 0);
    assert.deepEqual(result.failures, { temporary: 0, permanent: 3, unknown: 0 });
    assert.ok(result.error instanceof PushSendError && result.error.permanentOnly);
    assert.deepEqual(service.deleted, [tokens[0]]);
  });

  it('retains partial acceptance without asking callers to retry successful devices', async () => {
    const service = setup([[ok, failure({ error: 'MessageRateExceeded' }), failure({ error: 'DeviceNotRegistered' })]]);
    const result = await service.sendPushNotifications(tokens, message);
    assert.equal(result.sent, 1);
    assert.equal(result.error, null);
    assert.deepEqual(result.failures, { temporary: 1, permanent: 1, unknown: 0 });
    assert.deepEqual(service.deleted, [tokens[2]]);
  });

  it('keeps prior acceptance and invalid-token cleanup when a later chunk throws', async () => {
    const service = setup([[ok], [failure({ error: 'DeviceNotRegistered' })], new Error('connection reset')], 1);
    const result = await service.sendPushNotifications(tokens, message);
    assert.equal(result.sent, 1);
    assert.equal(result.error, null);
    assert.deepEqual(result.failures, { temporary: 0, permanent: 1, unknown: 1 });
    assert.deepEqual(service.deleted, [tokens[1]]);
  });

  it('retries unknown transport results when no acceptance was confirmed', async () => {
    const service = setup([new Error('connection reset')]);
    const result = await service.sendPushNotifications(tokens, message);
    assert.equal(result.sent, 0);
    assert.deepEqual(result.failures, { temporary: 0, permanent: 0, unknown: 3 });
    assert.ok(result.error instanceof PushSendError && !result.error.permanentOnly);
  });

  it('does not treat unknown or missing ticket errors as permanent', async () => {
    const service = setup([[failure({ error: 'ExpoError' }), failure()]]);
    const result = await service.sendPushNotifications(tokens, message);
    assert.equal(result.sent, 0);
    assert.deepEqual(result.failures, { temporary: 0, permanent: 0, unknown: 3 });
    assert.ok(result.error instanceof PushSendError && !result.error.permanentOnly);
  });

  it('does not send invalid tokens or treat them as successful', async () => {
    const service = setup([]);
    const result = await service.sendPushNotifications(['invalid'], message);
    assert.equal(result.sent, 0);
    assert.ok(result.error instanceof PushSendError && result.error.permanentOnly);
    assert.equal(service.calls.length, 0);
  });

  for (const [label, tickets, expected] of [
    ['all accepted', [ok, ok], 'sent'],
    ['all temporary', [failure({ error: 'MessageRateExceeded' }), failure({ error: 'MessageRateExceeded' })], 'failed'],
    ['all permanent', [failure({ error: 'DeviceNotRegistered' }), failure({ error: 'InvalidCredentials' })], 'cancelled'],
    ['partial', [ok, failure({ error: 'MessageRateExceeded' })], 'sent'],
    ['unknown', [failure(), failure()], 'failed'],
    ['mixed failures', [failure({ error: 'DeviceNotRegistered' }), failure({ error: 'MessageRateExceeded' })], 'failed'],
  ] as const) {
    it(`maps real-shaped ${label} tickets to claim ${expected}`, async () => {
      const service = setup([[...tickets]]);
      let status = 'processing';
      const dependencies: FreeEndNotificationDependencies = {
        claimNotifications: async () => ({ claims: status === 'processing' ? [{
          claimId: 'claim-1', userId: 'user-1', freeUntil: '2026-11-10T12:00:00Z',
          attempts: 1, leaseToken: 'lease-1', leaseExpiresAt: '2026-11-10T11:57:00Z',
        }] : [], error: null }),
        validateNotification: async () => ({ validation: { owned: true, stillValid: true }, error: null }),
        getDeviceTokens: async () => ({ tokens: tokens.slice(0, 2), error: null }),
        sendPushNotifications: service.sendPushNotifications,
        completeNotification: async (id, lease, next) => {
          assert.equal(id, 'claim-1');
          assert.equal(lease, 'lease-1');
          status = next;
          return { completed: true, error: null };
        },
      };
      const poller = createFreeEndNotificationPoller(dependencies);
      await poller.runOnce();
      assert.equal(status, expected);
      await poller.runOnce();
      assert.equal(service.calls.length, 1);
    });
  }
});
