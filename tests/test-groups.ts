import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createApp } from '../server/app';
import type { GroupDependencies, GroupOperation } from '../server/groups';

const roomId = '11111111-1111-4111-8111-111111111111';
describe('Group API authorization and contracts', () => {
  let server: Server;
  let base: string;
  let deps: GroupDependencies;
  let calls: { operation: GroupOperation; actor: string; args: Record<string, unknown> }[];
  let rateCalls: string[];
  beforeEach(async () => {
    calls = []; rateCalls = [];
    deps = {
      getUserId: async () => ({ userId: 'actor', error: null }),
      isMember: async () => true,
      consumeRate: async (key) => { rateCalls.push(key); return true; },
      rateSecret: 'test-only-secret',
      execute: async (operation, actor, args) => {
        calls.push({ operation, actor, args });
        return { status: operation === 'create' ? 201 : operation === 'leave' ? 204 : 200, data: { ok: true } };
      },
    };
    server = createServer(createApp({ getUserId: deps.getUserId, toggleIsFree: async () => ({ isFree: false, error: null }) }, deps));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}/groups`;
  });
  afterEach(async () => { server.close(); await once(server, 'close'); });
  const request = (path: string, method = 'GET', body?: unknown) => fetch(base + path, {
    method, headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  it('requires authentication on every route', async () => {
    for (const [path, method] of [['', 'GET'], ['', 'POST'], ['/join', 'POST'], [`/${roomId}/members`, 'GET'], [`/${roomId}/invite-code`, 'GET'], [`/${roomId}/members/me`, 'DELETE']]) {
      assert.equal((await fetch(base + path, { method })).status, 401);
    }
    assert.equal(calls.length, 0); assert.equal(rateCalls.length, 0);
  });
  it('rejects invalid authentication before database access', async () => {
    deps.getUserId = async () => ({ userId: null, error: new Error('invalid') });
    assert.equal((await request('')).status, 401); assert.equal(calls.length, 0);
  });
  it('derives the creator from auth and ignores forged actor fields', async () => {
    assert.equal((await request('', 'POST', { name: ' Friends ', user_id: 'victim' })).status, 201);
    assert.equal(calls[0].actor, 'actor'); assert.equal(calls[0].args.name, 'Friends');
    assert.equal(calls[0].args.user_id, undefined);
  });
  it('rejects empty and overlong names', async () => {
    for (const name of ['', '   ', 'x'.repeat(101)]) assert.equal((await request('', 'POST', { name })).status, 400);
    assert.equal(calls.length, 0);
  });
  it('returns safe JSON for malformed bodies', async () => {
    const response = await fetch(base, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid JSON body' });
    assert.equal(calls.length, 0);
  });
  it('preserves legacy invitation code case and excludes forged actor', async () => {
    assert.equal((await request('/join', 'POST', { invite_code: ' Km7Px2 ', user_id: 'victim' })).status, 200);
    assert.equal(calls[0].args.invite_code, 'Km7Px2'); assert.equal(calls[0].actor, 'actor');
    assert.equal(rateCalls.length, 2); assert.ok(rateCalls.every(key => /^[0-9a-f]{64}$/.test(key)));
  });
  it('counts malformed invitations before rejecting them', async () => {
    assert.equal((await request('/join', 'POST', { invite_code: '%' })).status, 400);
    assert.equal(rateCalls.length, 2); assert.equal(calls.length, 0);
  });
  it('blocks both IP and user rate exhaustion without executing joins', async () => {
    let count = 0; deps.consumeRate = async () => ++count % 2 === 1;
    const response = await request('/join', 'POST', { invite_code: 'Km7Px2' });
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60'); assert.equal(calls.length, 0);
  });
  it('fails closed if the shared limiter is unavailable', async () => {
    deps.consumeRate = async () => { throw new Error('secret database details'); };
    const response = await request('/join', 'POST', { invite_code: 'Km7Px2' });
    assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('secret')); assert.equal(calls.length, 0);
  });
  it('checks membership before members, invitation retrieval and leave', async () => {
    deps.isMember = async () => false;
    for (const [path, method] of [[`/${roomId}/members`, 'GET'], [`/${roomId}/invite-code`, 'GET'], [`/${roomId}/members/me`, 'DELETE']]) {
      assert.equal((await request(path, method)).status, 404);
    }
    assert.equal(calls.length, 0);
  });
  it('propagates creator-only invite authorization from the transactional RPC', async () => {
    deps.execute = async () => ({ status: 403, data: { error: 'Creator access required' } });
    assert.equal((await request(`/${roomId}/invite-code`)).status, 403);
  });
  it('serves authorized members without an environment feature flag', async () => {
    const response = await request(`/${roomId}/members`);
    assert.equal(response.status, 200);
    assert.equal(calls[0].operation, 'members');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
  it('still returns 503 when the member RPC is unavailable', async () => {
    deps.execute = async () => { throw new Error('internal database failure'); };
    const response = await request(`/${roomId}/members`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Group service unavailable' });
  });
  it('gets member availability and paginates only as the authenticated actor', async () => {
    assert.equal((await request(`/${roomId}/members?limit=10&offset=20`)).status, 200);
    assert.deepEqual(calls[0], { operation: 'members', actor: 'actor', args: { room_id: roomId, limit: 10, offset: 20 } });
  });
  it('rejects invalid IDs and unbounded pagination', async () => {
    for (const path of ['/invalid/members', '?limit=101', '?offset=-1', '?limit=1&limit=2']) assert.equal((await request(path)).status, 400);
    assert.equal(calls.length, 0);
  });
  it('lists only with auth identity and returns an empty leave response', async () => {
    assert.equal((await request('')).status, 200); assert.equal(calls[0].actor, 'actor');
    const response = await request(`/${roomId}/members/me`, 'DELETE');
    assert.equal(response.status, 204); assert.equal(await response.text(), '');
  });
});
