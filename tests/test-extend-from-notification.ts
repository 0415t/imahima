import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { AvailabilityDependencies } from '../server/app';
import { createApp } from '../server/app';

const accessToken = 'valid-test-token';
const authenticatedUserId = 'user-123';
const claimId = 'claim-abc';

describe('POST /profiles/me/is-free/extend-from-notification', () => {
  let server: Server;
  let endpoint: string;
  let dependencies: AvailabilityDependencies;
  let getUserIdCalls: string[];
  let extendCalls: { userId: string; claimId: string }[];

  beforeEach(async () => {
    getUserIdCalls = [];
    extendCalls = [];
    dependencies = {
      getUserId: async (token) => {
        getUserIdCalls.push(token);
        return { userId: token === accessToken ? authenticatedUserId : null, error: null };
      },
      toggleIsFree: async () => ({ isFree: true, error: null }),
      setIsFree: async () => ({ isFree: true, freeUntil: null, error: null }),
      extendIsFree: async () => ({ isFree: true, freeUntil: null, error: null }),
      extendIsFreeFromNotification: async (userId, claimId) => {
        extendCalls.push({ userId, claimId });
        return {
          isFree: true,
          freeUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          error: null,
        };
      },
    };
    server = createServer(createApp(dependencies));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    endpoint = `http://127.0.0.1:${address.port}/profiles/me/is-free/extend-from-notification`;
  });

  afterEach(async () => {
    server.close();
    await once(server, 'close');
  });

  const post = (body?: unknown) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('rejects requests without a bearer token', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim_id: claimId }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(extendCalls, []);
  });

  it('rejects requests with an invalid bearer token', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim_id: claimId }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(extendCalls, []);
  });

  it('rejects requests without claim_id', async () => {
    const response = await post({});

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'claim_id (string) is required' });
    assert.deepEqual(extendCalls, []);
  });

  it('rejects requests with a non-string claim_id', async () => {
    const response = await post({ claim_id: 123 });

    assert.equal(response.status, 400);
    assert.deepEqual(extendCalls, []);
  });

  it('extends the timer by 30 minutes from a notification', async () => {
    const response = await post({ claim_id: claimId });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.is_free, true);
    assert.ok(typeof body.free_until === 'string');
    assert.deepEqual(extendCalls, [{ userId: authenticatedUserId, claimId }]);
  });

  it('ignores a forged profile ID and derives the user from the bearer token', async () => {
    const response = await post({ claim_id: claimId, profile_id: 'another-user', user_id: 'another-user' });
    assert.equal(response.status, 200);
    assert.deepEqual(getUserIdCalls, [accessToken]);
    assert.deepEqual(extendCalls, [{ userId: authenticatedUserId, claimId }]);
  });

  it('returns 409 when not in an active timed free state', async () => {
    dependencies.extendIsFreeFromNotification = async () => ({
      isFree: null,
      freeUntil: null,
      error: new Error('Cannot extend: not in an active timed free state'),
    });

    const response = await post({ claim_id: claimId });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'Cannot extend: not in an active timed free state' });
  });

  it('returns 409 when the notification claim is not found', async () => {
    dependencies.extendIsFreeFromNotification = async () => ({
      isFree: null,
      freeUntil: null,
      error: new Error('Cannot extend: notification claim not found'),
    });

    const response = await post({ claim_id: claimId });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'Cannot extend: notification claim not found' });
  });

  it('returns 409 when the notification claim is not sent', async () => {
    dependencies.extendIsFreeFromNotification = async () => ({
      isFree: null,
      freeUntil: null,
      error: new Error('Cannot extend: notification claim is not sent'),
    });

    const response = await post({ claim_id: claimId });

    assert.equal(response.status, 409);
  });

  it('returns 409 when free_until has changed since notification (double extension)', async () => {
    dependencies.extendIsFreeFromNotification = async () => ({
      isFree: null,
      freeUntil: null,
      error: new Error('Cannot extend: free_until has changed since notification'),
    });

    const response = await post({ claim_id: claimId });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'Cannot extend: free_until has changed since notification',
    });
  });

  it('returns 409 for Supabase RAISE EXCEPTION error format', async () => {
    dependencies.extendIsFreeFromNotification = async () => ({
      isFree: null,
      freeUntil: null,
      error: {
        message: 'Cannot extend: free_until has changed since notification',
        details: null,
        hint: null,
        code: 'P0001',
      },
    });

    const response = await post({ claim_id: claimId });

    assert.equal(response.status, 409);
  });

  it('returns 404 when the authenticated user has no profile', async () => {
    dependencies.extendIsFreeFromNotification = async () => ({
      isFree: null,
      freeUntil: null,
      error: null,
    });

    const response = await post({ claim_id: claimId });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Profile not found' });
  });

  it('returns 500 for unexpected errors', async () => {
    dependencies.extendIsFreeFromNotification = async () => ({
      isFree: null,
      freeUntil: null,
      error: new Error('database unavailable'),
    });

    const response = await post({ claim_id: claimId });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Unable to extend availability' });
  });
});
