import { disabledTimerDependencies } from './helpers/chat-availability';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createApp } from '../server/app';
import type { ChatDependencies, ChatOperation } from '../server/chat';
import { chatService } from '../server/services/chat';
import { AuthApiError } from '@supabase/supabase-js';

const room = '11111111-1111-4111-8111-111111111111';
const message = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
describe('Chat HTTP contracts', () => {
  let server: Server; let base: string; let deps: ChatDependencies;
  let calls: { op: ChatOperation; actor: string; args: Record<string, unknown> }[];
  beforeEach(async () => {
    calls = [];
    deps = {
      getUserId: async token => ({ userId: token === 'valid' ? actor : null, error: token === 'valid' ? null : new AuthApiError('test invalid JWT', 403, 'bad_jwt') }),
      isMember: async () => true,
      execute: async (op, actor, args) => { calls.push({ op, actor, args }); return { status: op === 'send' ? 201 : 200, data: { ok: true } }; },
    };
    server = createServer(createApp({ ...disabledTimerDependencies, getUserId: deps.getUserId, toggleIsFree: async () => ({ isFree: false, error: null }) }, undefined, undefined, deps));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}/groups/${room}`;
  });
  afterEach(async () => { server.close(); server.closeAllConnections(); await once(server, 'close'); });
  const request = (path: string, method = 'GET', body?: unknown, token = 'valid') => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const send = (body: unknown = 'Hello') => request('/messages', 'POST', { body, client_message_id: message });
  it('routes all four operations and derives actor exclusively from authentication', async () => {
    assert.equal((await send()).status, 201);
    assert.equal((await request('/messages')).status, 200);
    assert.equal((await request(`/messages/${message}`, 'DELETE')).status, 200);
    assert.equal((await request('/message-events?after_event_seq=0')).status, 200);
    assert.deepEqual(calls.map(c => c.op), ['send', 'history', 'delete', 'events']);
    assert.ok(calls.every(c => c.actor === actor && c.args.p_actor === undefined));
    assert.equal((await request('/messages', 'POST', { body: 'x', client_message_id: message, sender_id: message })).status, 400);
  });
  it('rejects missing/invalid JWT on every operation without database calls', async () => {
    for (const [path, method] of [['/messages', 'POST'], ['/messages', 'GET'], [`/messages/${message}`, 'DELETE'], ['/message-events', 'GET']]) {
      assert.equal((await fetch(base + path, { method })).status, 401);
      assert.equal((await request(path, method, undefined, 'invalid')).status, 401);
    }
    assert.equal(calls.length, 0);
  });
  it('counts code points, normalizes CRLF, rejects whitespace/NUL/invalid Unicode', async () => {
    for (const n of [499, 500]) assert.equal((await send('😀'.repeat(n))).status, 201);
    for (const body of ['😀'.repeat(501), '', '\t\u0085\u3000', '\0', '\ud800', null]) assert.equal((await send(body)).status, 400);
    assert.equal((await send('a\r\nb')).status, 201);
    assert.equal(calls.at(-1)?.args.p_body, 'a\nb');
  });
  it('rejects malformed IDs, unknown/repeated params and unexpected bodies', async () => {
    assert.equal((await fetch(base.replace(room, 'bad') + '/messages', { headers: { Authorization: 'Bearer valid' } })).status, 400);
    for (const path of ['/messages?limit=0', '/messages?limit=101', '/messages?limit=1&limit=2', '/messages?offset=0', '/message-events?after_event_seq=-1', '/message-events?after_event_seq=9223372036854775808']) assert.equal((await request(path)).status, 400);
    assert.equal((await request('/messages/bad', 'DELETE')).status, 400);
    assert.equal((await request(`/messages/${message}`, 'DELETE', {})).status, 400);
    assert.equal(calls.length, 0);
  });
  it('encodes and strictly validates history and fixed-highwater event cursors', async () => {
    const cursor = { v: 1, room_id: room, direction: 'before', before_seq: '9' };
    deps.execute = async (_op, _actor, args) => { assert.deepEqual(args.p_cursor, cursor); return { status: 200, data: { next_cursor: cursor } }; };
    const response = await request(`/messages?cursor=${encode(cursor)}`);
    assert.equal(response.status, 200); assert.equal((await response.json()).next_cursor, encode(cursor));
    for (const value of ['bad!', encode({ ...cursor, room_id: message }), encode({ ...cursor, extra: true }), encode({ ...cursor, before_seq: 9 }), encode([])]) assert.equal((await request(`/messages?cursor=${value}`)).status, 400);
    const event = { v: 1, room_id: room, direction: 'after', after_seq: '9', through_seq: '12' };
    deps.execute = async (_op, _actor, args) => { assert.deepEqual(args.p_cursor, event); return { status: 200, data: { next_cursor: null } }; };
    assert.equal((await request(`/message-events?cursor=${encode(event)}`)).status, 200);
    assert.equal((await request(`/message-events?cursor=${encode(event)}&after_event_seq=0`)).status, 400);
  });
  it('rejects nonmembers/departed users and preserves RPC authorization after membership precheck', async () => {
    deps.isMember = async () => false;
    for (const path of ['/messages', '/message-events']) assert.equal((await request(path)).status, 404);
    assert.equal(calls.length, 0);
    deps.isMember = async () => true;
    deps.execute = async () => ({ status: 404, data: { code: 'GROUP_NOT_FOUND', error: 'Group not found' } });
    assert.equal((await send()).status, 404);
  });
  it('passes dedupe, ownership, conflicts and quota results through without reimplementing DB rules', async () => {
    for (const [status, code] of [[200, undefined], [403, 'MESSAGE_NOT_OWNED'], [409, 'CLIENT_MESSAGE_ID_CONFLICT'], [429, 'MESSAGE_RATE_LIMITED']] as const) {
      deps.execute = async () => ({ status, data: { code, deduplicated: status === 200, retry_after_seconds: 17 } });
      const response = await send(); assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('retry-after'), status === 429 ? '17' : null);
    }
  });
  it('fails closed on auth, membership, RPC and malformed RPC failures without leaking details', async () => {
    const check = async () => { const r = await send(); assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'Chat service unavailable', code: 'CHAT_UNAVAILABLE' }); };
    deps.execute = async () => { throw Error('secret SQL JWT body'); }; await check();
    deps.execute = async () => ({ status: 999, data: {} }); await check();
    deps.isMember = async () => { throw Error('secret'); }; await check();
    deps.getUserId = async () => { throw Error('secret'); }; await check();
  });
  for (const route of ['lowercase', 'upper-resource', 'mixed-prefix']) it(`returns safe coded JSON for invalid JSON and oversized bodies: ${route}`, async () => {
    const url = route === 'mixed-prefix' ? base.replace('/groups/', '/GrOuPs/') + '/MeSsAgEs'
      : base + (route === 'upper-resource' ? '/MESSAGES' : '/messages');
    for (const [body, status, code] of [['{bad', 400, 'INVALID_INPUT'], [JSON.stringify({ body: 'x'.repeat(110000) }), 413, 'PAYLOAD_TOO_LARGE']] as const) {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(2000) });
      assert.equal(r.status, status); assert.equal((await r.json()).code, code);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    assert.deepEqual(calls, []);
  });
});

it('chat service maps operation names and binds authenticated actor after arguments', async () => {
  const calls: unknown[] = [];
  const client = { rpc: async (name: string, args: unknown) => { calls.push([name, args]); return { data: { status: 200, data: {} }, error: null }; } };
  const service = chatService(client as unknown as Parameters<typeof chatService>[0], { getUserId: async () => ({ userId: actor, error: null }), isMember: async () => true });
  for (const op of ['send', 'delete', 'history', 'events'] as const) await service.execute(op, actor, { p_actor: 'forged', p_room_id: room });
  assert.deepEqual(calls, ['chat_send_message', 'chat_delete_message', 'chat_list_messages', 'chat_list_message_events'].map(name => [name, { p_actor: actor, p_room_id: room }]));
  client.rpc = async () => ({ data: { status: 200, data: {} }, error: { message: 'private' } }) as never;
  await assert.rejects(service.execute('send', actor, {}), /Chat operation failed/);
});
