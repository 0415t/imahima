import { disabledTimerDependencies } from './helpers/chat-availability';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';
import { createApp } from '../server/app';
import { timeoutFetch } from '../server/timeouts';
import type { ChatDependencies } from '../server/chat';

const room = '11111111-1111-4111-8111-111111111111';
const message = '22222222-2222-4222-8222-222222222222';
const pending = <T>() => new Promise<T>(() => {});

it('mixed-case group paths receive the deadline and cancel stalled authentication', async () => {
  const deps: ChatDependencies = {
    getUserId: async () => pending(), isMember: async () => { throw Error('Must not reach membership'); },
    execute: async () => { throw Error('Must not reach RPC'); },
  };
  const server = createServer(createApp({ ...disabledTimerDependencies, getUserId: deps.getUserId, toggleIsFree: async () => ({ isFree: false, error: null }) }, undefined, undefined, deps, 30));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/GROUPS/${room}/messages`, {
      headers: { Authorization: 'Bearer mock' }, signal: AbortSignal.timeout(1000),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'CHAT_UNAVAILABLE');
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); }
});

for (const path of ['/auth/v1/user', '/rest/v1/rpc/chat_send_message']) {
  for (const bodyStall of [false, true]) {
    it(`upstream timeout bounds ${path}, stalled ${bodyStall ? 'body' : 'headers'}`, async () => {
      let signal: AbortSignal | undefined;
      const fetcher: typeof fetch = async (_input, init) => {
        signal = init?.signal ?? undefined;
        return bodyStall ? new Response(new ReadableStream({ start() { /* No body bytes. */ } })) : pending<Response>();
      };
      const bounded = timeoutFetch(fetcher, { auth: 20, postgrest: 30 });
      await assert.rejects(bounded(`http://127.0.0.1${path}`), { name: 'AbortError' });
      assert.equal(signal?.aborted, true);
    });
  }
}

it('fetch preserves response and respects caller cancellation and network exceptions', async () => {
  const bounded = timeoutFetch(async () => new Response('{"ok":true}', { status: 201, headers: { 'Content-Type': 'application/json' } }));
  const r = await bounded('http://127.0.0.1/rest/v1/rpc/test');
  assert.equal(r.status, 201); assert.deepEqual(await r.json(), { ok: true });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bounded('http://127.0.0.1/auth/v1/user', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(timeoutFetch(async () => { throw new TypeError('network unavailable'); })('http://127.0.0.1/auth/v1/user'), TypeError);
});

it('real SDK Auth and PostgREST surface bounded fetch failures without external connections', async () => {
  const sdk = createClient('http://127.0.0.1:1', 'mock-only', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: timeoutFetch(async () => pending<Response>(), { auth: 20, postgrest: 20 }) },
  });
  const auth = await sdk.auth.getUser('mock-only'); assert.ok(auth.error);
  const rpc = await sdk.rpc('chat_send_message', {}); assert.ok(rpc.error);
});

for (const stage of ['auth', 'membership', 'rpc'] as const) {
  it(`HTTP deadline stops subsequent operations after stalled ${stage} on all chat routes and groups`, async () => {
    let lookup = 0, member = 0, rpc = 0;
    const deps: ChatDependencies = {
      getUserId: async () => { lookup++; return stage === 'auth' ? pending() : { userId: 'actor', error: null }; },
      isMember: async () => { member++; return stage === 'membership' ? pending() : true; },
      execute: async () => { rpc++; return pending(); },
    };
    const groups = { ...deps, execute: async () => deps.execute('history', 'actor', {}), rateSecret: 'mock', consumeRate: async () => true };
    const server = createServer(createApp({ ...disabledTimerDependencies, getUserId: deps.getUserId, toggleIsFree: async () => ({ isFree: false, error: null }) }, undefined, groups, deps, 40));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const routes = [['POST', `/groups/${room}/messages`], ['GET', `/groups/${room}/messages`],
      ['DELETE', `/groups/${room}/messages/${message}`], ['GET', `/groups/${room}/message-events`],
      ['GET', `/GROUPS/${room}/MeSsAgEs`], ['POST', `/GrOuPs/${room}/MESSAGES`],
      ['GET', `/GrOuPs/${room}/MESSAGE-EVENTS`], ['GET', `/groups/${room}/members`]];
    try {
      for (const [method, path] of routes) {
        const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method, headers: { Authorization: 'Bearer mock', 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(2000),
          body: method === 'POST' ? JSON.stringify({ body: 'hello', client_message_id: message }) : undefined,
        });
        assert.equal(response.status, 503);
        const result = await response.json(); assert.ok(!JSON.stringify(result).includes('AbortError'));
        assert.deepEqual(result, path.endsWith('/members')
          ? { error: 'Group service unavailable' }
          : { error: 'Chat service unavailable', code: 'CHAT_UNAVAILABLE' });
      }
      assert.equal(lookup, routes.length);
      assert.equal(member, stage === 'auth' ? 0 : routes.length);
      assert.equal(rpc, stage === 'rpc' ? routes.length : 0);
    } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); }
  });
}

it('late Auth success and client disconnect cannot start membership or RPC', async () => {
  let member = 0;
  const deps: ChatDependencies = {
    getUserId: async () => { await delay(120); return { userId: 'actor', error: null }; },
    isMember: async () => { member++; return true; }, execute: async () => ({ status: 200, data: {} }),
  };
  const server = createServer(createApp({ ...disabledTimerDependencies, getUserId: deps.getUserId, toggleIsFree: async () => ({ isFree: false, error: null }) }, undefined, undefined, deps, 40));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/groups/${room}/messages`;
  try {
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer mock' } })).status, 503);
    await new Promise<void>(resolve => {
      const req = httpRequest(url, { headers: { Authorization: 'Bearer mock' } });
      req.on('error', () => resolve()); req.end(); setTimeout(() => req.destroy(), 15);
    });
    await delay(150); assert.equal(member, 0);
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); }
});

it('late RPC completion cannot send twice or cancel another request', async () => {
  const deps: ChatDependencies = {
    getUserId: async () => ({ userId: 'actor', error: null }), isMember: async () => true,
    execute: async operation => {
      if (operation === 'send') { await delay(120); return { status: 201, data: { ok: true } }; }
      return { status: 200, data: { ok: true } };
    },
  };
  const server = createServer(createApp({ ...disabledTimerDependencies, getUserId: deps.getUserId, toggleIsFree: async () => ({ isFree: false, error: null }) }, undefined, undefined, deps, 40));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/groups/${room}/messages`;
  const headers = { Authorization: 'Bearer mock', 'Content-Type': 'application/json' };
  try {
    const late = fetch(url, { method: 'POST', headers, body: JSON.stringify({ body: 'hello', client_message_id: message }) });
    assert.equal((await fetch(url, { headers })).status, 200);
    assert.equal((await late).status, 503);
    await delay(150);
    assert.equal((await fetch(url, { headers })).status, 200);
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); }
});
