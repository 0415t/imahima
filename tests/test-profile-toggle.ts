import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { AvailabilityDependencies } from '../server/app';
import { createApp } from '../server/app';

const accessToken = 'valid-test-token';
const authenticatedUserId = 'user-123';

describe('POST /profiles/me/is-free/toggle', () => {
  let server: Server;
  let endpoint: string;
  let dependencies: AvailabilityDependencies;
  let getUserIdCalls: string[];
  let toggleCalls: string[];

  beforeEach(async () => {
    getUserIdCalls = [];
    toggleCalls = [];
    dependencies = {
      getUserId: async (token) => {
        getUserIdCalls.push(token);
        return { userId: authenticatedUserId, error: null };
      },
      toggleIsFree: async (userId) => {
        toggleCalls.push(userId);
        return { isFree: true, error: null };
      },
    };
    server = createServer(createApp(dependencies));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    endpoint = `http://127.0.0.1:${address.port}/profiles/me/is-free/toggle`;
  });

  afterEach(async () => {
    server.close();
    await once(server, 'close');
  });

  it('rejects requests without a bearer token', async () => {
    const response = await fetch(endpoint, { method: 'POST' });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Bearer token is required' });
    assert.deepEqual(getUserIdCalls, []);
    assert.deepEqual(toggleCalls, []);
  });

  it('does not toggle if the bearer token is invalid', async () => {
    dependencies.getUserId = async (token) => {
      getUserIdCalls.push(token);
      return { userId: null, error: new Error('invalid token') };
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Invalid or expired access token' });
    assert.deepEqual(getUserIdCalls, [accessToken]);
    assert.deepEqual(toggleCalls, []);
  });

  it('toggles the authenticated user and returns the new value', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { is_free: true });
    assert.deepEqual(getUserIdCalls, [accessToken]);
    assert.deepEqual(toggleCalls, [authenticatedUserId]);
  });

  it('returns 404 when the authenticated user has no profile', async () => {
    dependencies.toggleIsFree = async (userId) => {
      toggleCalls.push(userId);
      return { isFree: null, error: null };
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Profile not found' });
  });

  it('returns 500 when the profile update fails', async () => {
    dependencies.toggleIsFree = async (userId) => {
      toggleCalls.push(userId);
      return { isFree: null, error: new Error('database unavailable') };
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Unable to update availability' });
  });
});
