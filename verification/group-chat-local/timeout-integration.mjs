import { disabledTimerDependencies } from '../../tests/helpers/chat-availability.ts';
// Dedicated local stack only. No dotenv, migrations, schema changes or Push.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { connectVerified, runtime } from './schema-tools.mjs';
import { createApp } from '../../server/app.ts';
import { groupService } from '../../server/services/groups.ts';
import { chatService } from '../../server/services/chat.ts';
import { timeoutFetch } from '../../server/timeouts.ts';
import { waitForBarrier } from './barriers.mjs';

const require = createRequire(new URL('../../server/index.ts', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const results = [];
let db, blocker, server, admin, releaseResponse;
const run = `timeout-${Date.now()}-${randomUUID().slice(0, 8)}`;
let user, room, delayedId, committed;
let stage = 'identity-check';
const trace = [];
const upstream = [], httpServer = [], diagnostics = [];
const correlation = new AsyncLocalStorage();
const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
let requestNumber = 0;
async function test(name, work) { stage = name; await work(); results.push({ name, status: 'PASS' }); }
async function main() {
  ({ client: db } = await connectVerified());
  stage = 'local-client-setup';
  const status = JSON.parse(fs.readFileSync(path.join(runtime, 'local-status.credentials.json'), 'utf8'));
  assert.equal(status.API_URL, 'http://127.0.0.1:56321');
  const dbUrl = new URL(status.DB_URL);
  blocker = new Client({ host: '127.0.0.1', port: 56322, database: 'postgres',
    user: decodeURIComponent(dbUrl.username), password: decodeURIComponent(dbUrl.password), ssl: false, connectionTimeoutMillis: 5000 });
  await blocker.connect();
  const { rows: [pid] } = await blocker.query('select pg_backend_pid() as id');
  const fetcher = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, 'http://127.0.0.1:56321');
    const timing = { request_id: correlation.getStore(), stage: url.pathname.startsWith('/auth/') ? 'auth' :
      url.pathname.startsWith('/rest/v1/rpc/') ? 'rpc' : 'membership', started_at: new Date().toISOString() };
    upstream.push(timing); const start = performance.now();
    let response;
    try { response = await fetch(input, { ...init, redirect: 'error' }); }
    catch (error) { timing.error_type = error.name; timing.elapsed_ms = Math.round(performance.now() - start); throw error; }
    timing.headers_ms = Math.round(performance.now() - start); timing.http_status = response.status;
    if (url.pathname === '/rest/v1/rpc/chat_send_message' && delayedId && JSON.parse(init.body).p_client_message_id === delayedId) {
      delayedId = null;
      const body = await response.arrayBuffer();
      // Successful RPC response proves its transaction has completed; suppress
      // its delivery to Express to reproduce a lost post-COMMIT response.
      committed();
      await new Promise(resolve => { releaseResponse = resolve; });
      timing.elapsed_ms = Math.round(performance.now() - start);
      return new Response(body, { status: response.status, headers: response.headers });
    }
    const body = await response.arrayBuffer(); timing.elapsed_ms = Math.round(performance.now() - start);
    return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers });
  };
  admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(fetcher) },
  });
  const password = randomUUID() + randomUUID();
  stage = 'test-user-creation';
  const created = await admin.auth.admin.createUser({ email: `${run}@example.test`, password, email_confirm: true,
    user_metadata: { username: run } });
  assert.equal(created.error, null); user = created.data.user.id;
  const anon = createClient(status.API_URL, status.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(fetcher) },
  });
  const login = await anon.auth.signInWithPassword({ email: `${run}@example.test`, password });
  assert.equal(login.error, null);
  const token = login.data.session.access_token;
  const identity = async access => { const { data, error } = await admin.auth.getUser(access); return { userId: data.user?.id ?? null, error }; };
  const groups = groupService(admin, identity);
  groups.rateSecret = randomUUID(); // Dedicated test only; never load application .env.
  stage = 'express-start';
  const app = createApp({ ...disabledTimerDependencies, getUserId: identity, toggleIsFree: async () => { throw Error('Disabled'); } }, undefined, groups, chatService(admin, groups));
  server = createServer((req, res) => {
    const start = performance.now(); const row = { request_id: req.headers['x-verification-id'], received_at: new Date().toISOString() }; httpServer.push(row);
    res.once('finish', () => { row.status = res.statusCode; row.finish_ms = Math.round(performance.now() - start); });
    res.once('close', () => { row.close_ms = Math.round(performance.now() - start); });
    correlation.run(row.request_id, () => app(req, res));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (url, method = 'GET', body, signal) => {
    const row = { request_id: String(++requestNumber), operation: `${method} ${url.split('/').at(-1)}`, started_at: new Date().toISOString() }; trace.push(row);
    let r;
    try {
      r = await fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Verification-Id': row.request_id },
        body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(25000) });
    } catch (error) {
      row.error_type = error.name;
      const { rows } = await db.query("select pid,state,wait_event_type,wait_event,extract(epoch from clock_timestamp()-query_start)*1000 as elapsed_ms from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state<>'idle'");
      diagnostics.push({ request_id: row.request_id, activity: rows }); throw error;
    }
    row.http_status = r.status; row.headers_at = new Date().toISOString();
    const data = r.status === 204 ? null : await r.json(); row.completed_at = new Date().toISOString();
    return { status: r.status, data };
  };
  stage = 'test-room-creation';
  const setup = await api('/groups', 'POST', { name: run }); assert.equal(setup.status, 201); room = setup.data.group.id;
  stage = 'test-execution';
  const send = (id, body = 'timeout verification', signal) => api(`/groups/${room}/messages`, 'POST', { body, client_message_id: id }, signal);
  async function lock() { await blocker.query('begin'); await blocker.query('select id from public.rooms where id=$1 for update', [room]); }
  async function waitBlocked() {
    for (let i = 0; i < 60; i++) {
      const { rows: [r] } = await db.query('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting', [pid.id]);
      if (r.waiting) return;
      await sleep(50);
    }
    throw Error('Expected blocked RPC');
  }
  await test('real RPC lock wait expires with HTTP 503 and same ID retry succeeds once', async () => {
    const id = randomUUID(); await lock();
    const started = Date.now(); const r = await send(id);
    assert.equal(r.status, 503); assert.ok(Date.now() - started >= 4500);
    await blocker.query('commit'); assert.equal((await send(id)).status, 201);
  });
  await test('disconnect before COMMIT then parallel replay creates one row and one event', async () => {
    const id = randomUUID(); await lock();
    const controller = new AbortController();
    const first = send(id, 'timeout verification', controller.signal).then(() => 'response', () => 'disconnected');
    await waitBlocked(); controller.abort(); assert.equal(await first, 'disconnected');
    const retries = [send(id), send(id)];
    await sleep(100); await blocker.query('commit');
    const statuses = (await Promise.all(retries)).map(r => r.status);
    assert.ok(statuses.every(s => [200, 201].includes(s)));
    const { rows: [r] } = await db.query('select count(*)::int as n from public.messages where sender_id=$1 and client_message_id=$2', [user, id]);
    assert.equal(r.n, 1);
  });
  await test('lost response after COMMIT returns 503; parallel replays deduplicate and conflict is 409', async () => {
    const id = randomUUID(); delayedId = id;
    const commitSeen = new Promise(resolve => { committed = resolve; });
    const first = send(id); await waitForBarrier(commitSeen, first, 'post-COMMIT response');
    const parallel = await send(id); assert.equal(parallel.status, 200);
    assert.equal((await first).status, 503); releaseResponse(); releaseResponse = null;
    assert.equal((await send(id)).status, 200);
    assert.equal((await send(id, 'different body')).status, 409);
    const deleted = await api(`/groups/${room}/messages/${parallel.data.message.id}`, 'DELETE'); assert.equal(deleted.status, 200);
    const replay = await send(id); assert.equal(replay.status, 200); assert.equal(replay.data.message.body, null);
  });
  await test('replays use three successful send slots total and preserve one created event per message', async () => {
    const { rows: [r] } = await db.query(`select count(*)::int as messages,
      (select count(*)::int from public.room_message_events where room_id=$1 and event_type='created') as created,
      (select count(*)::int from public.room_message_events where room_id=$1 and event_type='deleted') as deleted
      from public.messages where room_id=$1 and sender_id=$2`, [room, user]);
    assert.deepEqual(r, { messages: 3, created: 3, deleted: 1 });
    for (let i = 0; i < 7; i++) assert.equal((await send(randomUUID())).status, 201);
    assert.equal((await send(randomUUID())).status, 429);
  });
  const leave = await api(`/groups/${room}/members/me`, 'DELETE'); assert.equal(leave.status, 204);
  const { rows: [remaining] } = await db.query(`select
    (select count(*)::int from public.messages where room_id=$1) as messages,
    (select count(*)::int from public.room_message_events where room_id=$1) as events,
    (select count(*)::int from public.room_members where room_id=$1) as memberships,
    (select mvp_archived_at is not null from public.rooms where id=$1) as archived`, [room]);
  const report = { run, project: 'imahima-chat-local', results, trace, upstream, httpServer, diagnostics,
    event_loop_max_ms: Math.round(eventLoop.max / 1e6), test_user: user, test_room: room,
    retained: remaining, note: 'Only newly created data; user and immutable history retained. No migrations or Push.' };
  fs.writeFileSync(path.join(runtime, `${run}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ run, passed: results.length, failed: 0, retained: remaining }));
}
try { await main(); }
catch (error) {
  const report = { run, stage, error_type: error.name, results, trace, upstream, httpServer, diagnostics,
    event_loop_max_ms: Math.round(eventLoop.max / 1e6), test_user: user, test_room: room,
    status: 'STOPPED', note: 'No automatic retry or cleanup; inspect dedicated test data.' };
  fs.writeFileSync(path.join(runtime, `${run}.json`), JSON.stringify(report, null, 2));
  console.error(JSON.stringify({ run, stage, error_type: error.name, passed: results.length, failed: 1, trace })); process.exitCode = 1;
}
finally {
  eventLoop.disable();
  releaseResponse?.();
  if (server) { server.close(); server.closeAllConnections(); }
  if (blocker) { await blocker.query('rollback').catch(() => {}); await blocker.end(); }
  await db?.end();
}
