import { disabledTimerDependencies } from '../../tests/helpers/chat-availability.ts';
// Verification only. Does not import dotenv, Push or alter database definitions.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createPrivateKey, sign } from 'node:crypto';
import { once } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
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
const run = `phase3-${Date.now()}-${randomUUID().slice(0, 8)}`;
const report = { run, project: 'imahima-chat-local', results: [], http: [], upstream: [], barriers: [], users: {}, rooms: [] };
const scope = new AsyncLocalStorage();
let db, blocker, server, admin, fault = '', requestNumber = 0, stage = 'identity';
let delayedHistory, releaseHistory, historyReady;
const save = () => fs.writeFileSync(path.join(runtime, `${run}.json`), JSON.stringify(report, null, 2));
async function test(name, kind, work) {
  stage = name; const start = performance.now();
  try { await work(); report.results.push({ name, kind, status: 'PASS', elapsed_ms: Math.round(performance.now() - start) }); save(); }
  catch (error) { report.results.push({ name, kind, status: 'FAIL', error_type: error.name, elapsed_ms: Math.round(performance.now() - start) }); save(); throw error; }
}
async function main() {
  ({ client: db, identity: report.identity } = await connectVerified());
  const settings = JSON.parse(fs.readFileSync(path.join(runtime, 'local-status.credentials.json'), 'utf8'));
  assert.equal(settings.API_URL, 'http://127.0.0.1:56321');
  const url = new URL(settings.DB_URL);
  blocker = new Client({ host: '127.0.0.1', port: 56322, database: 'postgres', user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), ssl: false, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  await blocker.connect();
  const { rows: [blockerPid] } = await blocker.query('select pg_backend_pid() as pid');
  const fetcher = async (input, init) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(u.origin, 'http://127.0.0.1:56321');
    const auth = u.pathname.startsWith('/auth/v1/');
    const row = { request_id: scope.getStore(), stage: auth ? 'auth' : u.pathname.startsWith('/rest/v1/rpc/') ? 'rpc' : 'membership', fault,
      started_at: new Date().toISOString() }; report.upstream.push(row); const start = performance.now();
    try {
      if (fault === 'auth-503' && auth) return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
      if ((fault === 'auth-hang' && auth) || (fault === 'rest-hang' && !auth)) {
        await sleep(60000, undefined, { signal: init.signal }); throw Error('Unexpected completion');
      }
      if (fault === 'rest-disconnect' && !auth) throw new TypeError('Injected connection failure');
      if (fault === 'all-slow') await sleep(auth ? 4000 : 7000, undefined, { signal: init.signal });
      const response = await fetch(input, { ...init, redirect: 'error' }); row.http_status = response.status;
      const bytes = await response.arrayBuffer(); row.body_ms = Math.round(performance.now() - start);
      if (delayedHistory && u.pathname === '/rest/v1/rpc/chat_list_messages') {
        delayedHistory = false; historyReady();
        await new Promise(resolve => { releaseHistory = resolve; });
      }
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, headers: response.headers });
    } catch (error) { row.error_type = error.name; throw error; }
    finally { row.elapsed_ms = Math.round(performance.now() - start); }
  };
  admin = createClient(settings.API_URL, settings.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(fetcher) } });
  const sessions = {};
  for (const label of ['A', 'B']) {
    const password = randomUUID() + randomUUID(), email = `${run}-${label}@example.test`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `${run}-${label}` } });
    assert.equal(created.error, null); report.users[label] = created.data.user.id;
    const anon = createClient(settings.API_URL, settings.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(fetcher) } });
    const login = await anon.auth.signInWithPassword({ email, password }); assert.equal(login.error, null); sessions[label] = login.data.session.access_token;
  }
  const identity = async token => { const { data, error } = await admin.auth.getUser(token); return { userId: data.user?.id ?? null, error }; };
  const groups = groupService(admin, identity); groups.rateSecret = randomUUID();
  const app = createApp({ ...disabledTimerDependencies, getUserId: identity, toggleIsFree: async () => { throw Error('Disabled'); } }, groups, chatService(admin, groups));
  server = createServer((req, res) => scope.run(req.headers['x-verification-id'], () => app(req, res)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  async function api(label, route, method = 'GET', body, token = sessions[label]) {
    const row = { request_id: String(++requestNumber), stage, operation: `${method} ${route.split('/').at(-1)}`, fault, started_at: new Date().toISOString() };
    report.http.push(row); const start = performance.now();
    try {
      const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Verification-Id': row.request_id },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
      row.status = response.status; row.headers_ms = Math.round(performance.now() - start);
      return { status: response.status, data: response.status === 204 ? null : await response.json() };
    } catch (error) { row.error_type = error.name; throw error; }
    finally { row.elapsed_ms = Math.round(performance.now() - start); }
  }
  async function room() {
    const r = await admin.rpc('group_mvp_execute', { p_operation: 'create', p_actor: report.users.A, p_args: { name: run } });
    assert.equal(r.error, null); assert.equal(r.data.status, 201); const id = r.data.data.group.id; report.rooms.push(id);
    const join = await admin.rpc('group_mvp_execute', { p_operation: 'join', p_actor: report.users.B, p_args: { invite_code: r.data.data.invite_code } });
    assert.equal(join.data.status, 201); return id;
  }
  const send = (r, id = randomUUID()) => api('A', `/groups/${r}/messages`, 'POST', { body: 'phase3 verification', client_message_id: id });
  async function hold(fn, args) {
    assert.ok(['chat_delete_message', 'chat_list_messages', 'group_mvp_execute'].includes(fn));
    await blocker.query('begin'); await blocker.query('set local role service_role');
    const r = await blocker.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as result`, args);
    report.barriers.push({ stage, event: 'operation-complete-lock-held', at: new Date().toISOString(), rpc_status: r.rows[0].result.status });
    return r.rows[0].result;
  }
  async function waitBlocked() {
    for (let i = 0; i < 60; i++) {
      const { rows: [r] } = await db.query('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting', [blockerPid.pid]);
      if (r.waiting) { report.barriers.push({ stage, event: 'competing-operation-blocked', at: new Date().toISOString() }); return; }
      await sleep(40);
    }
    throw Error('Missing lock barrier');
  }
  async function release() { await blocker.query('commit'); report.barriers.push({ stage, event: 'commit-lock-released', at: new Date().toISOString() }); }

  const mainRoom = await room();
  let shortToken;
  await test('short-lived signed JWT is accepted by real local Auth before expiry', 'real-auth-local-signature', async () => {
    const [headerPart, payloadPart] = sessions.A.split('.');
    const originalHeader = JSON.parse(Buffer.from(headerPart, 'base64url'));
    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url'));
    const keys = JSON.parse(fs.readFileSync(path.join(runtime, 'signing_keys.json'), 'utf8'));
    const key = keys.find(k => k.kid === originalHeader.kid); assert.equal(key.alg, 'ES256');
    const now = Math.floor(Date.now() / 1000); claims.iat = now; claims.exp = now + 2;
    const data = Buffer.from(JSON.stringify(originalHeader)).toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = sign('sha256', Buffer.from(data), { key: createPrivateKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
    shortToken = data + '.' + signature.toString('base64url');
    assert.equal((await admin.auth.getUser(shortToken)).error, null); report.jwt_expiry_epoch = claims.exp;
  });
  await test('SDK receives injected Auth 503 and Express returns safe 503', 'fault-injected-transport', async () => {
    fault = 'auth-503'; const r = await api('A', `/groups/${mainRoom}/messages`); assert.equal(r.status, 503); assert.equal(r.data.code, 'CHAT_UNAVAILABLE'); fault = '';
  });
  await test('Auth response stall ends at five seconds with 503', 'fault-injected-transport', async () => {
    fault = 'auth-hang'; const start = performance.now(); const r = await api('A', `/groups/${mainRoom}/messages`);
    assert.equal(r.status, 503); assert.ok(performance.now() - start >= 4500); fault = '';
  });
  await test('PostgREST stall ends at eight seconds; same ID retry saves one message', 'real-auth-fault-injected-rest', async () => {
    const id = randomUUID(); fault = 'rest-hang'; const r = await send(mainRoom, id); assert.equal(r.status, 503); fault = '';
    assert.equal((await send(mainRoom, id)).status, 201); assert.equal((await send(mainRoom, id)).status, 200);
  });
  await test('PostgREST connection failure becomes 503', 'real-auth-fault-injected-rest', async () => {
    fault = 'rest-disconnect'; assert.equal((await api('A', `/groups/${mainRoom}/messages`)).status, 503); fault = '';
  });
  await test('twenty-second HTTP deadline wins over individually valid slow stages', 'real-stack-delayed-transport', async () => {
    fault = 'all-slow'; const start = performance.now(); const r = await api('A', '/groups', 'POST', { name: run });
    assert.equal(r.status, 503); assert.ok(performance.now() - start >= 19000); assert.ok(performance.now() - start < 24000); fault = '';
  });
  await test('delete holds room lock before leave; tombstone and one delete event survive', 'real-db-and-http', async () => {
    const r = await room(), sent = await send(r); assert.equal(sent.status, 201); const id = sent.data.message.id;
    assert.equal((await hold('chat_delete_message', [report.users.A, r, id])).status, 200);
    const leaving = api('A', `/groups/${r}/members/me`, 'DELETE'); await waitBlocked(); await release(); assert.equal((await leaving).status, 204);
    const history = await api('B', `/groups/${r}/messages`); assert.equal(history.data.messages[0].body, null);
    const { rows: [count] } = await db.query("select count(*)::int as n from public.room_message_events where message_id=$1 and event_type='deleted'", [id]); assert.equal(count.n, 1);
  });
  await test('leave holds room lock before delete; delete returns 404 and body remains', 'real-db-and-http', async () => {
    const r = await room(), sent = await send(r); assert.equal(sent.status, 201); const id = sent.data.message.id;
    assert.equal((await hold('group_mvp_execute', ['leave', report.users.A, { room_id: r }])).status, 204);
    const deleting = api('A', `/groups/${r}/messages/${id}`, 'DELETE'); await waitBlocked(); await release(); assert.equal((await deleting).status, 404);
    const { rows: [m] } = await db.query('select body is not null as retained, deleted_at is null as undeleted from public.messages where id=$1', [id]); assert.ok(m.retained && m.undeleted);
  });
  await test('history read lock precedes delete; fresh history returns newer tombstone', 'real-db-and-http', async () => {
    const r = await room(), sent = await send(r); assert.equal(sent.status, 201); const id = sent.data.message.id;
    const snapshot = await hold('chat_list_messages', [report.users.A, r]);
    const deleting = api('A', `/groups/${r}/messages/${id}`, 'DELETE'); await waitBlocked(); await release(); assert.equal((await deleting).status, 200);
    const history = await api('A', `/groups/${r}/messages`); assert.equal(history.data.messages[0].body, null);
    assert.ok(BigInt(history.data.messages[0].last_event_seq) > BigInt(snapshot.data.messages[0].last_event_seq));
  });
  await test('history read lock precedes leave; later history and events reject departed user', 'real-db-and-http', async () => {
    const r = await room(); assert.equal((await send(r)).status, 201);
    assert.equal((await hold('chat_list_messages', [report.users.A, r])).status, 200);
    const leaving = api('A', `/groups/${r}/members/me`, 'DELETE'); await waitBlocked(); await release(); assert.equal((await leaving).status, 204);
    assert.equal((await api('A', `/groups/${r}/messages`)).status, 404); assert.equal((await api('A', `/groups/${r}/message-events`)).status, 404);
  });
  await test('in-flight history response delayed past leave is stale; subsequent read is 404', 'real-stack-delayed-response', async () => {
    const r = await room(); assert.equal((await send(r)).status, 201);
    const ready = new Promise(resolve => { historyReady = resolve; }); delayedHistory = true;
    const reading = api('A', `/groups/${r}/messages`); await waitForBarrier(ready, reading, 'history readiness');
    assert.equal((await api('A', `/groups/${r}/members/me`, 'DELETE')).status, 204); releaseHistory(); releaseHistory = null;
    assert.equal((await reading).status, 200); assert.equal((await api('A', `/groups/${r}/messages`)).status, 404);
  });
  await test('naturally expired signed JWT returns 401 on all four chat APIs', 'real-auth-expiry', async () => {
    const remaining = Math.max(0, (report.jwt_expiry_epoch + 65) * 1000 - Date.now());
    if (remaining) await sleep(remaining);
    const auth = await admin.auth.getUser(shortToken); assert.ok(auth.error);
    report.expired_auth_error = { name: auth.error.name, status: auth.error.status, code: auth.error.code };
    for (const [method, route] of [['POST', 'messages'], ['GET', 'messages'], ['DELETE', `messages/${randomUUID()}`], ['GET', 'message-events']]) {
      const r = await api('A', `/groups/${mainRoom}/${route}`, method, undefined, shortToken); assert.equal(r.status, 401);
    }
  });
  report.results.push({ name: 'Auth account deletion and post-deletion integrity', kind: 'not-executed', status: 'SKIP',
    reason: 'Current instruction forbids deleting test data. Prior isolated SQL evidence is not counted as a new real-Auth test.' });
  const { rows: retained } = await db.query(`select r.id, count(m.id)::int as messages, count(m.id) filter(where m.deleted_at is not null)::int as deleted,
    (select count(*)::int from public.room_members where room_id=r.id) as members from public.rooms r left join public.messages m on m.room_id=r.id
    where r.id=any($1::uuid[]) group by r.id order by r.id`, [report.rooms]); report.retained = retained;
  report.status = 'COMPLETE'; save();
  console.log(JSON.stringify({ run, passed: report.results.filter(r => r.status === 'PASS').length, failed: 0, skipped: 1 }));
}
try { await main(); }
catch (error) { report.status = 'STOPPED'; report.failed_stage = stage; report.error_type = error.name; save(); console.error(JSON.stringify({ run, status: 'STOPPED', stage, error_type: error.name })); process.exitCode = 1; }
finally { fault = ''; releaseHistory?.(); if (server) { server.close(); server.closeAllConnections(); } if (blocker) { await blocker.query('rollback').catch(() => {}); await blocker.end(); } await db?.end(); }
