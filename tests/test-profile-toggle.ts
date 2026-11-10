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
      setIsFree: async (userId, isFree, durationMinutes) => {
        return {
          isFree,
          freeUntil: isFree ? new Date(Date.now() + (durationMinutes ?? 60) * 60 * 1000).toISOString() : null,
          error: null,
        };
      },
      extendIsFree: async () => {
        return { isFree: true, freeUntil: null, error: null };
      },
      extendIsFreeFromNotification: async () => {
        return { isFree: true, freeUntil: null, error: null };
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

describe('PUT /profiles/me/is-free', () => {
  let server: Server;
  let endpoint: string;
  let dependencies: AvailabilityDependencies;
  let getUserIdCalls: string[];
  let setIsFreeCalls: { userId: string; isFree: boolean; durationMinutes?: number | null }[];

  beforeEach(async () => {
    getUserIdCalls = [];
    setIsFreeCalls = [];
    dependencies = {
      getUserId: async (token) => {
        getUserIdCalls.push(token);
        return { userId: authenticatedUserId, error: null };
      },
      toggleIsFree: async () => {
        return { isFree: true, error: null };
      },
      setIsFree: async (userId, isFree, durationMinutes) => {
        setIsFreeCalls.push({ userId, isFree, durationMinutes });
        return {
          isFree,
          freeUntil: isFree
            ? durationMinutes == null
              ? null
              : new Date(Date.now() + durationMinutes * 60 * 1000).toISOString()
            : null,
          error: null,
        };
      },
      extendIsFree: async (userId) => {
        return {
          isFree: true,
          freeUntil: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
          error: null,
        };
      },
      extendIsFreeFromNotification: async () => {
        return { isFree: true, freeUntil: null, error: null };
      },
    };
    server = createServer(createApp(dependencies));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    endpoint = `http://127.0.0.1:${address.port}/profiles/me/is-free`;
  });

  afterEach(async () => {
    server.close();
    await once(server, 'close');
  });

  it('rejects requests without a bearer token', async () => {
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_free: true }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Bearer token is required' });
    assert.deepEqual(getUserIdCalls, []);
    assert.deepEqual(setIsFreeCalls, []);
  });

  it('rejects requests with a non-boolean is_free', async () => {
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_free: 'yes' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'is_free (boolean) is required' });
    assert.deepEqual(setIsFreeCalls, []);
  });

  it('sets is_free to true with no timer when duration_minutes is omitted', async () => {
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_free: true }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.is_free, true);
    assert.equal(body.free_until, null);
    assert.deepEqual(setIsFreeCalls, [{ userId: authenticatedUserId, isFree: true, durationMinutes: null }]);
  });

  it('sets is_free to true with 30 minutes duration', async () => {
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_free: true, duration_minutes: 30 }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.is_free, true);
    assert.ok(typeof body.free_until === 'string');
    assert.deepEqual(setIsFreeCalls, [{ userId: authenticatedUserId, isFree: true, durationMinutes: 30 }]);
  });

  it('keeps existing state when already on and on is requested again', async () => {
    const existingFreeUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    dependencies.setIsFree = async (userId, isFree, durationMinutes) => {
      setIsFreeCalls.push({ userId, isFree, durationMinutes });
      return {
        isFree: true,
        freeUntil: existingFreeUntil,
        error: null,
      };
    };

    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_free: true, duration_minutes: 60 }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.is_free, true);
    assert.equal(body.free_until, existingFreeUntil);
  });

  it('allows re-on after expiration', async () => {
    dependencies.setIsFree = async (userId, isFree, durationMinutes) => {
      setIsFreeCalls.push({ userId, isFree, durationMinutes });
      return {
        isFree: true,
        freeUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        error: null,
      };
    };

    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_free: true, duration_minutes: 60 }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.is_free, true);
    assert.ok(typeof body.free_until === 'string');
  });

  it('sets is_free to false and returns null free_until', async () => {
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_free: false }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { is_free: false, free_until: null });
    assert.deepEqual(setIsFreeCalls, [{ userId: authenticatedUserId, isFree: false, durationMinutes: null }]);
  });

  it('returns is_free false when free_until is already expired', async () => {
    dependencies.setIsFree = async (userId, isFree, durationMinutes) => {
      setIsFreeCalls.push({ userId, isFree, durationMinutes });
      return {
        isFree: true,
        freeUntil: new Date(Date.now() - 1000).toISOString(),
        error: null,
      };
    };

    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_free: true }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.is_free, false);
  });

  it('returns 404 when the authenticated user has no profile', async () => {
    dependencies.setIsFree = async (userId, isFree, durationMinutes) => {
      setIsFreeCalls.push({ userId, isFree, durationMinutes });
      return { isFree: null, freeUntil: null, error: null };
    };

    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_free: true }),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Profile not found' });
  });

  it('returns 500 when the profile update fails', async () => {
    dependencies.setIsFree = async (userId, isFree, durationMinutes) => {
      setIsFreeCalls.push({ userId, isFree, durationMinutes });
      return { isFree: null, freeUntil: null, error: new Error('database unavailable') };
    };

    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_free: true }),
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Unable to update availability' });
  });

  it('rejects requests with invalid duration_minutes', async () => {
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ is_free: true, duration_minutes: 45 }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'duration_minutes must be one of: 30, 60, 120, 180, or null' });
    assert.deepEqual(setIsFreeCalls, []);
  });

  it('handles concurrent on requests without overwriting the timer', async () => {
    let storedIsFree = false;
    let storedFreeUntil: string | null = null;

    // DB側の FOR UPDATE による直列化を模倣するスチE�EトフルなモチE��
    // �E�実際の同時実行制御はDB側で行われるため、ここではON中の再ONが既存状態を維持する契紁E��検証する�E�E
    dependencies.setIsFree = async (userId, isFree, durationMinutes) => {
      setIsFreeCalls.push({ userId, isFree, durationMinutes });
      if (isFree) {
        if (storedIsFree && (storedFreeUntil === null || new Date(storedFreeUntil).getTime() > Date.now())) {
          return { isFree: true, freeUntil: storedFreeUntil, error: null };
        }
        storedIsFree = true;
        storedFreeUntil =
          durationMinutes == null
            ? null
            : new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
        return { isFree: true, freeUntil: storedFreeUntil, error: null };
      }
      storedIsFree = false;
      storedFreeUntil = null;
      return { isFree: false, freeUntil: null, error: null };
    };

    const requestHeaders = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    const [first, second] = await Promise.all([
      fetch(endpoint, {
        method: 'PUT',
        headers: requestHeaders,
        body: JSON.stringify({ is_free: true, duration_minutes: 60 }),
      }),
      fetch(endpoint, {
        method: 'PUT',
        headers: requestHeaders,
        body: JSON.stringify({ is_free: true, duration_minutes: 30 }),
      }),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.equal(firstBody.is_free, true);
    assert.equal(secondBody.is_free, true);
    // 後から届いたONリクエストでタイマ�Eが上書きされず、両方が同ぁEfree_until を返す
    assert.equal(firstBody.free_until, secondBody.free_until);
    assert.equal(setIsFreeCalls.length, 2);
  });
});

describe('POST /profiles/me/is-free/extend', () => {
  let server: Server;
  let endpoint: string;
  let dependencies: AvailabilityDependencies;
  let getUserIdCalls: string[];
  let extendIsFreeCalls: string[];

  beforeEach(async () => {
    getUserIdCalls = [];
    extendIsFreeCalls = [];
    dependencies = {
      getUserId: async (token) => {
        getUserIdCalls.push(token);
        return { userId: authenticatedUserId, error: null };
      },
      toggleIsFree: async () => {
        return { isFree: true, error: null };
      },
      setIsFree: async () => {
        return { isFree: true, freeUntil: null, error: null };
      },
      extendIsFree: async (userId) => {
        extendIsFreeCalls.push(userId);
        return {
          isFree: true,
          freeUntil: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
          error: null,
        };
      },
      extendIsFreeFromNotification: async () => {
        return { isFree: true, freeUntil: null, error: null };
      },
    };
    server = createServer(createApp(dependencies));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    endpoint = `http://127.0.0.1:${address.port}/profiles/me/is-free/extend`;
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
    assert.deepEqual(extendIsFreeCalls, []);
  });

  it('rejects requests with an invalid bearer token', async () => {
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
    assert.deepEqual(extendIsFreeCalls, []);
  });

  it('extends the timer by 30 minutes', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.is_free, true);
    assert.ok(typeof body.free_until === 'string');
    assert.deepEqual(extendIsFreeCalls, [authenticatedUserId]);
  });

  it('returns 409 when not in an active timed free state', async () => {
    dependencies.extendIsFree = async (userId) => {
      extendIsFreeCalls.push(userId);
      return {
        isFree: null,
        freeUntil: null,
        error: new Error('Cannot extend: not in an active timed free state'),
      };
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'Cannot extend: not in an active timed free state' });
  });

  it('returns 404 when the authenticated user has no profile', async () => {
    dependencies.extendIsFree = async (userId) => {
      extendIsFreeCalls.push(userId);
      return { isFree: null, freeUntil: null, error: null };
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Profile not found' });
  });

  it('returns 500 when the extend fails', async () => {
    dependencies.extendIsFree = async (userId) => {
      extendIsFreeCalls.push(userId);
      return { isFree: null, freeUntil: null, error: new Error('database unavailable') };
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Unable to extend availability' });
  });

  it('returns 409 for Supabase RAISE EXCEPTION error format', async () => {
    dependencies.extendIsFree = async (userId) => {
      extendIsFreeCalls.push(userId);
      return {
        isFree: null,
        freeUntil: null,
        error: {
          message: 'Cannot extend: not in an active timed free state',
          details: null,
          hint: null,
          code: 'P0001',
        },
      };
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'Cannot extend: not in an active timed free state' });
  });

  it('returns 500 for unexpected Supabase errors', async () => {
    dependencies.extendIsFree = async (userId) => {
      extendIsFreeCalls.push(userId);
      return {
        isFree: null,
        freeUntil: null,
        error: {
          message: 'connection to server lost',
          details: null,
          hint: null,
          code: '08006',
        },
      };
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Unable to extend availability' });
  });
});
