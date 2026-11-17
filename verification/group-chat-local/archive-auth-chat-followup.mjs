// Additional actual Auth-vs-chat races. Only this run's new users may be deleted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { connectVerified, runtime } from './schema-tools.mjs';
import { createApp } from '../../server/app.ts';
import { groupService } from '../../server/services/groups.ts';
import { chatService } from '../../server/services/chat.ts';
import { timeoutFetch } from '../../server/timeouts.ts';
import { waitForBarrier, waitForBlockedRpc } from './barriers.mjs';
const require = createRequire(new URL('../../server/index.ts', import.meta.url)); const { createClient } = require('@supabase/supabase-js');
const run = `archive-auth-${Date.now()}`, report = { run, tests: [], users: {}, rooms: [], deleted: [] }, tokens = {};
let db, blocker, server;
try {
  ({ client: db } = await connectVerified()); const settings = JSON.parse(fs.readFileSync(path.join(runtime, 'local-status.credentials.json'), 'utf8'));
  const u = new URL(settings.DB_URL); blocker = new Client({ host: '127.0.0.1', port: 56322, database: 'postgres', user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ssl: false, connectionTimeoutMillis: 5000 }); await blocker.connect();
  const pid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid;
  const fetcher = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); assert.equal(url.origin, 'http://127.0.0.1:56321'); return fetch(input, { ...init, redirect: 'error' }); };
  const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(fetcher) } }, admin = createClient(settings.API_URL, settings.SERVICE_ROLE_KEY, options);
  for (const label of ['L', 'M', 'N']) {
    const password = randomUUID() + randomUUID(), email = `${run}-${label}@example.test`;
    const user = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `${run}-${label}` } }); assert.equal(user.error, null); report.users[label] = user.data.user.id;
    const anon = createClient(settings.API_URL, settings.ANON_KEY, options), login = await anon.auth.signInWithPassword({ email, password }); assert.equal(login.error, null); tokens[label] = login.data.session.access_token;
  }
  let authenticated;
  const identity = async token => {
    const { data, error } = await admin.auth.getUser(token);
    if (authenticated && token === tokens.L && data.user && !error) { authenticated(); authenticated = null; }
    return { userId: data.user?.id ?? null, error };
  }, groups = groupService(admin, identity); groups.rateSecret = randomUUID();
  server = createServer(createApp({ getUserId: identity, toggleIsFree: async () => { throw Error('Disabled'); } }, groups, chatService(admin, groups))); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const api = async (label, room, method = 'GET', id) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/groups/${room}/messages${id ? '/' + id : ''}`, { method, headers: { Authorization: `Bearer ${tokens[label]}`, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ body: 'archive race', client_message_id: randomUUID() }) : undefined, signal: AbortSignal.timeout(25000) }); return { status: r.status, data: await r.json() };
  };
  async function prepare(label) {
    const r = await admin.rpc('group_mvp_execute', { p_operation: 'create', p_actor: report.users[label], p_args: { name: run } }); assert.equal(r.data.status, 201); const id = r.data.data.group.id; report.rooms.push(id);
    const join = await admin.rpc('group_mvp_execute', { p_operation: 'join', p_actor: report.users.N, p_args: { invite_code: r.data.data.invite_code } }); assert.equal(join.data.status, 201);
    const sent = await api(label, id, 'POST'); assert.equal(sent.status, 201); return { room: id, message: sent.data.message.id };
  }
  async function remove(label) {
    assert.ok(['L', 'M'].includes(label)); const user = await admin.auth.admin.getUserById(report.users[label]); assert.equal(user.data.user.user_metadata.username, `${run}-${label}`);
    const r = await admin.auth.admin.deleteUser(report.users[label], false); assert.equal(r.error, null); report.deleted.push(report.users[label]);
  }
  async function waitBlocked() {
    for (let n = 0; n < 70; n++) { if ((await db.query('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting', [pid])).rows[0].waiting) return; await sleep(40); }
    throw Error('Missing blocking proof');
  }
  const first = await prepare('L');
  await blocker.query('begin'); await blocker.query('select id from public.rooms where id=$1 for share', [first.room]);
  const deletingUser = remove('L'); await waitBlocked();
  const authReady = new Promise(resolve => { authenticated = resolve; });
  const deletingMessage = api('L', first.room, 'DELETE', first.message);
  await waitForBarrier(authReady, deletingMessage, 'DELETE authentication');
  await waitForBlockedRpc(db, pid, 'chat_delete_message', deletingMessage);
  await blocker.query('commit'); await deletingUser; assert.equal((await deletingMessage).status, 404);
  const retained = await api('N', first.room); assert.equal(retained.status, 200); assert.equal(retained.data.messages[0].sender, null); assert.equal(retained.data.messages[0].deleted_at, null);
  report.tests.push({ name: 'Auth deletion before pending message deletion rejects delete and preserves body', status: 'PASS' });
  const second = await prepare('M');
  await blocker.query('begin'); await blocker.query('set local role service_role');
  const history = (await blocker.query('select public.chat_list_messages($1,$2) as r', [report.users.M, second.room])).rows[0].r; assert.equal(history.status, 200);
  const removing = remove('M'); await waitBlocked(); await blocker.query('commit'); await removing;
  assert.equal((await api('M', second.room)).status, 401); const after = await api('N', second.room); assert.equal(after.status, 200); assert.equal(after.data.messages[0].sender, null);
  report.tests.push({ name: 'history holds shared room lock before Auth deletion; later JWT denied', status: 'PASS' }); report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = { type: error.name, code: error.code }; process.exitCode = 1; }
finally {
  if (server) { server.close(); server.closeAllConnections(); } if (blocker) { await blocker.query('rollback').catch(() => {}); await blocker.end(); } await db?.end();
  fs.writeFileSync(path.join(runtime, `${run}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ run, status: report.status, passed: report.tests.length, error: report.error }));
}
