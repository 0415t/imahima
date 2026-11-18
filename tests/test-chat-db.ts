import { disabledTimerDependencies } from './helpers/chat-availability';
// Default: no DB connection. CHAT_LOCAL_DB=1 runs the dedicated local stack.
// CHAT_ISOLATED_DB=1 is a historical, separate fixture mode, never run implicitly.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { it } from 'node:test';
import { resolve } from 'node:path';
import { createApp } from '../server/app';
import { chatService } from '../server/services/chat';

it('isolated HTTP -> chat service -> real PostgreSQL RPC lifecycle', { skip: process.env.CHAT_ISOLATED_DB !== '1' }, async () => {
  const container = 'imahima-chat-db-verification';
  const metadata = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
  assert.equal(metadata.HostConfig.NetworkMode, 'none'); assert.equal(metadata.Config.Image, 'postgres:16');
  const sql = (query: string) => execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const literal = (value: unknown) => value === null ? 'null' : `'${(typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'`;
  const a = randomUUID(), b = randomUUID(), room = randomUUID(), clientId = randomUUID();
  sql(`insert into auth.users values ('${a}'),('${b}'); insert into public.profiles(id) values ('${a}'),('${b}');
    insert into public.rooms(id,room_name,room_key,mvp_created_by,mvp_managed) values ('${room}','HTTP chat fixture','${randomUUID()}', '${a}',true);
    insert into public.room_members(room_id,user_id) values ('${room}','${a}'),('${room}','${b}');`);
  const identity = {
    getUserId: async (token: string) => ({ userId: token === 'a' ? a : token === 'b' ? b : null, error: null }),
    isMember: async (actor: string, id: string) => sql(`select exists(select 1 from public.room_members where room_id=${literal(id)} and user_id=${literal(actor)});`) === 't',
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    assert.ok(['chat_send_message', 'chat_delete_message', 'chat_list_messages', 'chat_list_message_events'].includes(name));
    const parameters = Object.entries(args).map(([key, value]) => { assert.match(key, /^p_[a-z_]+$/); return `${key} => ${literal(value)}`; }).join(',');
    return { data: JSON.parse(sql(`begin;set local role service_role;select public.${name}(${parameters});commit;`)), error: null };
  };
  const chat = chatService({ rpc } as unknown as Parameters<typeof chatService>[0], identity);
  const server = createServer(createApp({ ...disabledTimerDependencies, getUserId: identity.getUserId, toggleIsFree: async () => ({ isFree: false, error: null }) }, undefined, undefined, chat));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/groups/${room}`;
  const request = async (path: string, method = 'GET', body?: unknown, token = 'a') => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), retry: response.headers.get('retry-after') };
  };
  try {
    const payload = { body: "Real RPC '😀'", client_message_id: clientId };
    const sent = await request('/messages', 'POST', payload); assert.equal(sent.status, 201);
    const id = sent.data.message.id;
    const replay = await request('/messages', 'POST', payload); assert.equal(replay.status, 200); assert.equal(replay.data.message.id, id);
    assert.equal((await request('/messages', 'POST', { ...payload, body: 'conflict' })).status, 409);
    assert.equal((await request(`/messages/${id}`, 'DELETE', undefined, 'b')).status, 403);
    assert.equal((await request('/messages', 'GET', undefined, 'b')).data.messages[0].body, payload.body);
    const deleted = await request(`/messages/${id}`, 'DELETE'); assert.equal(deleted.status, 200); assert.equal(deleted.data.message.body, null);
    const retryDeleted = await request('/messages', 'POST', payload); assert.equal(retryDeleted.status, 200); assert.equal(retryDeleted.data.message.body, null);
    const first = await request('/message-events?after_event_seq=0&limit=1'); assert.equal(first.status, 200); assert.equal(typeof first.data.next_cursor, 'string');
    const second = await request(`/message-events?cursor=${first.data.next_cursor}`); assert.equal(second.data.events[0].type, 'deleted'); assert.equal(second.data.messages[0].body, null);
    for (let i = 0; i < 9; i++) assert.equal((await request('/messages', 'POST', { body: 'quota', client_message_id: randomUUID() })).status, 201);
    const limited = await request('/messages', 'POST', { body: 'quota', client_message_id: randomUUID() }); assert.equal(limited.status, 429); assert.ok(Number(limited.retry) >= 1);
    const page = await request('/messages?limit=1'); assert.equal(typeof page.data.next_cursor, 'string');
    assert.equal((await request(`/messages?cursor=${page.data.next_cursor}`)).status, 200);
    sql(`delete from public.room_members where room_id='${room}' and user_id='${b}';`);
    assert.equal((await request('/messages', 'GET', undefined, 'b')).status, 404);
    assert.equal((await request('/message-events', 'GET', undefined, 'b')).status, 404);
    assert.equal((await request('/messages', 'POST', { body: 'departed', client_message_id: randomUUID() }, 'b')).status, 404);
    assert.equal(sql(`select count(*) from public.messages where room_id='${room}';`), '10');
  } finally {
    server.close(); server.closeAllConnections(); await once(server, 'close');
  }
  // Preserve immutable history until the dedicated container is destroyed.
});

it('dedicated local Auth -> Express -> PostgREST -> current RPC/RLS regression', { skip: process.env.CHAT_LOCAL_DB !== '1', timeout: 120000 }, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(SUPABASE_|EXPO_PUBLIC_|PG[A-Z_]|DATABASE_URL$|DOTENV_|GROUP_RATE_SECRET$)/.test(key)) delete env[key];
  execFileSync(process.execPath, ['--import', 'tsx', resolve('verification/group-chat-local/final-validation.mjs')], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 115000,
  });
});
