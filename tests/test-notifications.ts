import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { AvailabilityDependencies, NotificationDependencies } from '../server/app';
import { createApp } from '../server/app';

const accessToken = 'valid-test-token';
const authenticatedUserId = 'user-123';
const ownTokens = ['ExponentPushToken[own-device-1]', 'ExponentPushToken[own-device-2]'];

describe('POST /notifications/test', () => {
  let server: Server;
  let endpoint: string;
  let availability: AvailabilityDependencies;
  let notifications: NotificationDependencies;
  let getDeviceTokensCalls: string[];
  let sendCalls: { tokens: string[]; message: { title: string; body: string } }[];
  let sendResult: { sent: number; error: unknown | null };
  let fetchedTokens: string[];

  beforeEach(async () => {
    getDeviceTokensCalls = [];
    sendCalls = [];
    sendResult = { sent: ownTokens.length, error: null };
    fetchedTokens = ownTokens;

    availability = {
      getUserId: async (token) => ({
        userId: token === accessToken ? authenticatedUserId : null,
        error: token === accessToken ? null : new Error('invalid token'),
      }),
      toggleIsFree: async () => ({ isFree: true, error: null }),
      setIsFree: async (_userId, isFree) => ({ isFree, freeUntil: null, error: null }),
      extendIsFree: async () => ({ isFree: true, freeUntil: null, error: null }),
    };
    notifications = {
      getDeviceTokens: async (userId) => {
        getDeviceTokensCalls.push(userId);
        return { tokens: fetchedTokens, error: null };
      },
      sendPushNotifications: async (tokens, message) => {
        sendCalls.push({ tokens, message });
        return sendResult;
      },
    };

    server = createServer(createApp(availability, notifications));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    endpoint = `http://127.0.0.1:${address.port}/notifications/test`;
  });

  afterEach(async () => {
    server.close();
    await once(server, 'close');
  });

  const post = () =>
    fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } });

  it('rejects requests without a bearer token', async () => {
    const response = await fetch(endpoint, { method: 'POST' });

    assert.equal(response.status, 401);
    assert.equal(sendCalls.length, 0);
  });

  it('rejects requests with an invalid token', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    });

    assert.equal(response.status, 401);
    assert.equal(sendCalls.length, 0);
  });

  it('returns sent: 0 when the user has no registered tokens', async () => {
    fetchedTokens = [];

    const response = await post();

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sent: 0, message: 'No registered devices' });
    assert.equal(sendCalls.length, 0);
  });

  it('does not consume the rate limit when the user has no registered tokens', async () => {
    fetchedTokens = [];

    const first = await post();
    assert.equal(first.status, 200);

    fetchedTokens = ownTokens;
    const second = await post();
    assert.equal(second.status, 200);
    assert.equal(sendCalls.length, 1);
  });

  it('sends a fixed notification to the authenticated user devices', async () => {
    const response = await post();

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sent: ownTokens.length });
    assert.deepEqual(getDeviceTokensCalls, [authenticatedUserId]);
    assert.equal(sendCalls.length, 1);
    assert.deepEqual(sendCalls[0].tokens, ownTokens);
    assert.equal(typeof sendCalls[0].message.title, 'string');
    assert.equal(typeof sendCalls[0].message.body, 'string');
  });

  it('ignores destination fields in the request body', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: 'another-user',
        expo_push_token: 'ExponentPushToken[another-device]',
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(getDeviceTokensCalls, [authenticatedUserId]);
    assert.deepEqual(sendCalls[0].tokens, ownTokens);
  });

  it('returns 502 when the push service fails', async () => {
    sendResult = { sent: 0, error: new Error('expo unavailable') };

    const response = await post();

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Unable to send notification' });
  });

  it('rate limits consecutive successful requests from the same user', async () => {
    const first = await post();
    const second = await post();

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(sendCalls.length, 1);
  });

  it('does not rate limit a retry after a failed send', async () => {
    sendResult = { sent: 0, error: new Error('expo unavailable') };
    const first = await post();
    assert.equal(first.status, 502);

    sendResult = { sent: ownTokens.length, error: null };
    const second = await post();
    assert.equal(second.status, 200);
    assert.equal(sendCalls.length, 2);
  });
});
