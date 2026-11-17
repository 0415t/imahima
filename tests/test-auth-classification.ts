import { disabledTimerDependencies } from './helpers/chat-availability';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { it } from 'node:test';
import { AuthApiError, AuthInvalidJwtError, AuthRetryableFetchError, AuthSessionMissingError, AuthUnknownError } from '@supabase/supabase-js';
import { createApp } from '../server/app';
import { authenticate } from '../server/auth';

const room = '11111111-1111-4111-8111-111111111111';
const message = '22222222-2222-4222-8222-222222222222';
const secret = 'PRIVATE_AUTH_DETAIL';
const cases: [string, unknown, 401 | 503][] = [
  ['invalid JWT', new AuthApiError(secret, 403, 'bad_jwt'), 401],
  ['expired JWT', new AuthApiError(secret, 401, 'bad_jwt'), 401],
  ['expired session', new AuthApiError(secret, 403, 'session_expired'), 401],
  ['deleted user rejected by Auth', new AuthApiError(secret, 403, 'user_not_found'), 401],
  ['revoked session rejected by Auth', new AuthApiError(secret, 403, 'session_not_found'), 401],
  ['missing session', new AuthSessionMissingError(), 401],
  ['invalid JWT class', new AuthInvalidJwtError(secret), 401],
  ['legacy unauthorized', new AuthApiError(secret, 401, undefined), 401],
  ['network failure', new AuthRetryableFetchError(secret, 0), 503],
  ['Auth unavailable', new AuthRetryableFetchError(secret, 503), 503],
  ['server failure', new AuthApiError(secret, 500, 'unexpected_failure'), 503],
  ['upstream throttled', new AuthApiError(secret, 429, 'over_request_rate_limit'), 503],
  ['unknown SDK error', new AuthUnknownError(secret, new Error(secret)), 503],
  ['unknown code', new AuthApiError(secret, 401, 'future_unknown_error'), 503],
  ['contradictory status/code', new AuthApiError(secret, 503, 'bad_jwt'), 503],
  ['ordinary error mentioning JWT', new Error('invalid JWT ' + secret), 503],
  ['untyped error', { status: 401, code: 'bad_jwt', message: secret }, 503],
];

for (const [label, error, status] of cases) {
  for (const thrown of [false, true]) {
    it(`Auth classification: ${label}, ${thrown ? 'throw' : 'returned error'}`, async () => {
      // Even an accompanying user ID must never bypass an error.
      const lookup = async () => { if (thrown) throw error; return { userId: 'actor', error }; };
      let operations = 0;
      const deps = {
        getUserId: lookup, isMember: async () => { operations++; return true; },
        execute: async () => { operations++; return { status: 200, data: {} }; },
        consumeRate: async () => { operations++; return true; }, rateSecret: 'test-only',
      };
      const server = createServer(createApp({ ...disabledTimerDependencies, getUserId: lookup, toggleIsFree: async () => ({ isFree: false, error: null }) }, undefined, deps, deps));
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const routes = [
        ['POST', `/groups/${room}/messages`], ['GET', `/groups/${room}/messages`],
        ['DELETE', `/groups/${room}/messages/${message}`], ['GET', `/groups/${room}/message-events`],
        ['POST', '/groups'], ['GET', '/groups'], ['POST', '/groups/join'],
        ['GET', `/groups/${room}/members`], ['GET', `/groups/${room}/invite-code`],
        ['DELETE', `/groups/${room}/members/me`],
      ];
      try {
        for (const [method, path] of routes) {
          const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { Authorization: 'Bearer mock-only' } });
          assert.equal(response.status, status, `${method} ${path}`);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          const chat = path.includes('/messages') || path.includes('/message-events');
          assert.deepEqual(await response.json(), chat
            ? { error: status === 401 ? 'Invalid or expired access token' : 'Chat service unavailable', code: status === 401 ? 'UNAUTHENTICATED' : 'CHAT_UNAVAILABLE' }
            : { error: status === 401 ? 'Invalid or expired access token' : 'Authentication unavailable' });
        }
        assert.equal(operations, 0);
      } finally {
        server.close(); server.closeAllConnections(); await once(server, 'close');
      }
    });
  }
}

it('Auth classification: success requires a user ID and no error', async () => {
  assert.deepEqual(await authenticate(async () => ({ userId: 'actor', error: null }), 'mock'), { userId: 'actor', status: 200 });
  for (const userId of [null, '']) {
    assert.deepEqual(await authenticate(async () => ({ userId, error: null }), 'mock'), { userId: null, status: 503 });
  }
});
