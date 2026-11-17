import { disabledTimerDependencies } from '../../tests/helpers/chat-availability.ts';
// Final verification; only newly-created explicitly tracked victims may be deleted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
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

const require = createRequire(new URL('../../server/index.ts', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const run = `final-${Date.now()}-${randomUUID().slice(0, 8)}`;
const report = { run, project: 'imahima-chat-local', tests: [], http: [], subscriptions: [], receipts: [], barriers: [],
  users: {}, deleted_users: [], rooms: [], preservation: {} };
const created = new Map(), sessions = {}, clients = [], subscriptions = [];
let db, blocker, server, admin, settings, phase = 'identity', oldUsers, oldRooms;
const save = () => fs.writeFileSync(path.join(runtime, `${run}.json`), JSON.stringify(report, null, 2));
const sourcePaths = ['server/auth.ts', 'server/timeouts.ts', 'server/chat.ts', 'server/services/chat.ts', 'server/app.ts', 'server/index.ts', 'server/groups.ts', 'server/services/supabase.ts',
  'supabase/migrations/20261111000000_group_management_mvp.sql', 'supabase/migrations/20261113000000_group_chat_mvp.sql'];
const sourceHashes = () => Object.fromEntries(sourcePaths.map(p => [p, createHash('sha256').update(fs.readFileSync(new URL('../../' + p, import.meta.url))).digest('hex')]));
async function test(name, kind, action) {
  phase = name; const row = { name, kind, started_at: new Date().toISOString() }; report.tests.push(row); save();
  try { row.observation = await action(); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error_type = error.name; save(); throw error; }
  row.completed_at = new Date().toISOString(); save();
}
const localFetch = (input, init) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(u.origin, 'http://127.0.0.1:56321'); return fetch(input, { ...init, redirect: 'error' });
};
async function preservation() {
  const result = {};
  for (const [table, column, ids] of [['auth.users', 'id', oldUsers], ['public.profiles', 'id', oldUsers],
    ['public.rooms', 'id', oldRooms], ['public.room_members', 'room_id', oldRooms],
    ['public.messages', 'room_id', oldRooms], ['public.room_message_events', 'room_id', oldRooms]]) {
    const expression = table === 'auth.users' ? 't.id::text' : 'to_jsonb(t)::text';
    const { rows: [r] } = await db.query(`select count(*)::int as count, md5(coalesce(string_agg(${expression},'' order by ${expression}),'')) as digest
      from ${table} t where ${column}=any($1::uuid[])`, [ids]); result[table] = r;
  }
  return result;
}
async function deleteVictim(label) {
  const entry = created.get(label);
  assert.ok(entry && label !== 'B' && label !== 'C'); assert.ok(!oldUsers.includes(entry.id));
  const before = await admin.auth.admin.getUserById(entry.id);
  assert.equal(before.error, null); assert.equal(before.data.user.email, entry.email.toLowerCase());
  assert.equal(before.data.user.user_metadata.username, `${run}-${label}`);
  const removed = await admin.auth.admin.deleteUser(entry.id, false);
  if (removed.error) report.deletion_failure = { label, name: removed.error.name, status: removed.error.status, code: removed.error.code };
  assert.equal(removed.error, null); report.deleted_users.push(entry.id); save();
}
async function main() {
  ({ client: db, identity: report.identity } = await connectVerified());
  report.preservation.sources_before = sourceHashes();
  oldUsers = (await db.query('select id::text from auth.users order by id')).rows.map(r => r.id);
  oldRooms = (await db.query('select id::text from public.rooms order by id')).rows.map(r => r.id);
  report.preservation.before = await preservation();
  settings = JSON.parse(fs.readFileSync(path.join(runtime, 'local-status.credentials.json'), 'utf8')); assert.equal(settings.API_URL, 'http://127.0.0.1:56321');
  const url = new URL(settings.DB_URL);
  blocker = new Client({ host: '127.0.0.1', port: 56322, database: 'postgres', user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: false, connectionTimeoutMillis: 5000, query_timeout: 10000 }); await blocker.connect();
  const blockerPid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid;
  admin = createClient(settings.API_URL, settings.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(localFetch) } });
  await test('create five dedicated Auth users, profiles and real JWT sessions', 'real-auth', async () => {
    for (const label of ['A', 'B', 'C', 'D', 'E']) {
      const email = `${run}-${label}@example.test`, password = randomUUID() + randomUUID();
      const user = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `${run}-${label}` } });
      assert.equal(user.error, null); const id = user.data.user.id; created.set(label, { id, email }); report.users[label] = id;
      const client = createClient(settings.API_URL, settings.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(localFetch) } });
      const login = await client.auth.signInWithPassword({ email, password }); assert.equal(login.error, null); sessions[label] = login.data.session;
      assert.equal((await db.query('select count(*)::int as n from public.profiles where id=$1', [id])).rows[0].n, 1);
    }
  });
  let authenticated;
  const getUserId = async token => {
    const { data, error } = await admin.auth.getUser(token);
    if (authenticated && token === sessions.D.access_token && data.user && !error) { authenticated(); authenticated = null; }
    return { userId: data.user?.id ?? null, error };
  };
  const groups = groupService(admin, getUserId); groups.rateSecret = randomUUID();
  const app = createApp({ ...disabledTimerDependencies, getUserId, toggleIsFree: async id => { const { data, error } = await admin.rpc('toggle_profile_is_free', { target_profile_id: id }); return { isFree: data, error }; } }, undefined, groups, chatService(admin, groups));
  server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  async function api(label, route, method = 'GET', body) {
    const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${sessions[label].access_token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    const data = response.status === 204 ? null : await response.json();
    report.http.push({ phase, method, route, status: response.status }); return { status: response.status, data };
  }
  async function makeRoom(owner, members = []) {
    const r = await admin.rpc('group_mvp_execute', { p_operation: 'create', p_actor: report.users[owner], p_args: { name: run } });
    assert.equal(r.error, null); assert.equal(r.data.status, 201); const id = r.data.data.group.id; report.rooms.push(id);
    for (const member of members) {
      const j = await admin.rpc('group_mvp_execute', { p_operation: 'join', p_actor: report.users[member], p_args: { invite_code: r.data.data.invite_code } }); assert.equal(j.data.status, 201);
    }
    return id;
  }
  const send = (label, room, clientId = randomUUID(), body = 'final verification') => api(label, `/groups/${room}/messages`, 'POST', { body, client_message_id: clientId });
  async function waitBlocked() {
    for (let i = 0; i < 80; i++) {
      const r = await db.query('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked', [blockerPid]);
      if (r.rows[0].blocked) { report.barriers.push({ phase, blocked_at: new Date().toISOString() }); return; }
      await sleep(50);
    }
    throw Error('Expected database lock barrier');
  }
  class LocalSocket extends WebSocket { constructor(url, protocols) { assert.equal(new URL(url).origin, 'ws://127.0.0.1:56321'); super(url, protocols); } }
  async function subscribe(label, room) {
    const client = createClient(settings.API_URL, settings.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(localFetch) },
      realtime: { transport: LocalSocket, logger: () => {} } }); clients.push(client);
    assert.equal((await client.auth.setSession(sessions[label])).error, null);
    await client.realtime.setAuth(sessions[label].access_token);
    const entry = { label, room, client, errors: [] };
    entry.channel = client.channel(`${run}-${label}-${subscriptions.length}`, { config: { postgres_changes_options: { wait: true, timeout: 15000 } } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_message_events', filter: `room_id=eq.${room}` }, payload => {
        const row = payload.new; report.receipts.push({ receiver: label, room_id: row.room_id, message_id: row.message_id, event_seq: String(row.event_seq),
          type: row.event_type, created_at: row.created_at, received_at: new Date().toISOString(), columns: Object.keys(row).sort() });
      }); subscriptions.push(entry);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Subscription readiness timeout')), 22000);
      entry.channel.subscribe((state, error) => {
        report.subscriptions.push({ label, state, error_present: !!error, at: new Date().toISOString() });
        if (state === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
        if (['CHANNEL_ERROR', 'TIMED_OUT'].includes(state)) { entry.errors.push(state); clearTimeout(timer); reject(Error('Subscription error')); }
      });
    }); return entry;
  }
  const received = (label, id, type = 'created') => report.receipts.some(e => e.receiver === label && e.message_id === id && e.type === type);
  async function positive(label, id, type = 'created') {
    const until = Date.now() + 12000;
    while (!received(label, id, type) && Date.now() < until) await sleep(50);
    assert.ok(received(label, id, type));
  }
  const mainRoom = await makeRoom('A', ['B']);
  let aChannel, bChannel, cChannel, retainedMessage, deletedMessage, bMessage;
  await test('ready Postgres Changes subscriptions use real JWTs', 'real-realtime', async () => {
    aChannel = await subscribe('A', mainRoom); bChannel = await subscribe('B', mainRoom); cChannel = await subscribe('C', mainRoom);
  });
  await test('normal chat, replay, owner deletion and history before account deletion', 'real-api-db-realtime', async () => {
    const id = randomUUID(); retainedMessage = await send('A', mainRoom, id); assert.equal(retainedMessage.status, 201);
    await positive('A', retainedMessage.data.message.id); await positive('B', retainedMessage.data.message.id);
    assert.equal((await send('A', mainRoom, id)).status, 200); assert.equal((await send('A', mainRoom, id, 'different')).status, 409);
    deletedMessage = await send('A', mainRoom); assert.equal(deletedMessage.status, 201);
    assert.equal((await api('B', `/groups/${mainRoom}/messages/${deletedMessage.data.message.id}`, 'DELETE')).status, 403);
    assert.equal((await api('A', `/groups/${mainRoom}/messages/${deletedMessage.data.message.id}`, 'DELETE')).status, 200);
    await positive('B', deletedMessage.data.message.id, 'deleted');
    bMessage = await send('B', mainRoom); assert.equal(bMessage.status, 201);
    assert.equal((await api('A', `/groups/${mainRoom}/messages`)).status, 200);
  });
  const eventsBeforeDeletion = (await db.query('select count(*)::int as n from public.room_message_events where room_id=$1', [mainRoom])).rows[0].n;
  await test('hard-delete only newly-created victim A via real Auth Admin API', 'real-auth-account-delete', async () => { await deleteVictim('A'); });
  await test('deleted account JWT is rejected by all chat APIs', 'real-auth-api', async () => {
    for (const [method, route] of [['POST', 'messages'], ['GET', 'messages'], ['DELETE', `messages/${retainedMessage.data.message.id}`], ['GET', 'message-events']])
      assert.equal((await api('A', `/groups/${mainRoom}/${route}`, method)).status, 401);
  });
  await test('FK cascades, retained bodies, tombstones and surviving sender remain consistent', 'real-db-and-http', async () => {
    for (const table of ['auth.users', 'public.profiles', 'public.room_members']) {
      const column = table === 'public.room_members' ? 'user_id' : 'id';
      assert.equal((await db.query(`select count(*)::int as n from ${table} where ${column}=$1`, [report.users.A])).rows[0].n, 0);
    }
    const history = await api('B', `/groups/${mainRoom}/messages`); assert.equal(history.status, 200);
    const retained = history.data.messages.find(m => m.id === retainedMessage.data.message.id);
    assert.equal(retained.sender, null); assert.equal(retained.body, 'final verification');
    const tombstone = history.data.messages.find(m => m.id === deletedMessage.data.message.id); assert.equal(tombstone.sender, null); assert.equal(tombstone.body, null); assert.ok(tombstone.deleted_at);
    assert.equal(history.data.messages.find(m => m.id === bMessage.data.message.id).sender.id, report.users.B);
    assert.equal((await db.query('select mvp_created_by is null as cleared from public.rooms where id=$1', [mainRoom])).rows[0].cleared, true);
    assert.equal((await db.query('select count(*)::int as n from public.room_message_events where room_id=$1', [mainRoom])).rows[0].n, eventsBeforeDeletion);
  });
  await test('deleted connected subscriber and outsider receive no three post-delete events', 'real-realtime-rls', async () => {
    for (let n = 0; n < 3; n++) {
      assert.equal(aChannel.channel.state, 'joined'); assert.equal(cChannel.channel.state, 'joined');
      assert.ok(aChannel.client.realtime.isConnected()); assert.ok(cChannel.client.realtime.isConnected());
      const sent = await send('B', mainRoom); assert.equal(sent.status, 201); await positive('B', sent.data.message.id); await sleep(2000);
      assert.ok(!received('A', sent.data.message.id)); assert.ok(!received('C', sent.data.message.id));
      assert.deepEqual(aChannel.errors, []); assert.deepEqual(cChannel.errors, []);
    }
  });
  await test('real user JWT cannot read bodies or call service RPCs; event SELECT follows membership', 'real-postgrest-rls', async () => {
    async function direct(label, route, method = 'GET', body) {
      const response = await localFetch(settings.API_URL + '/rest/v1/' + route, { method, headers: { apikey: settings.ANON_KEY, Authorization: `Bearer ${sessions[label].access_token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      return { status: response.status, data: await response.json() };
    }
    assert.equal((await direct('B', 'messages?select=id')).status, 403);
    for (const name of ['chat_send_message', 'chat_delete_message', 'chat_list_messages', 'chat_list_message_events']) {
      const body = { p_actor: report.users.B, p_room_id: mainRoom,
        ...(name === 'chat_send_message' ? { p_body: 'blocked', p_client_message_id: randomUUID() } : {}),
        ...(name === 'chat_delete_message' ? { p_message_id: retainedMessage.data.message.id } : {}) };
      assert.equal((await direct('B', 'rpc/' + name, 'POST', body)).status, 403);
    }
    assert.ok((await direct('B', `room_message_events?room_id=eq.${mainRoom}&select=event_seq`)).data.length > 0);
    assert.deepEqual((await direct('A', `room_message_events?room_id=eq.${mainRoom}&select=event_seq`)).data, []);
    assert.deepEqual((await direct('C', `room_message_events?room_id=eq.${mainRoom}&select=event_seq`)).data, []);
  });
  await test('disconnect, create/delete, fixed-highwater delta, JWT refresh and reconnect', 'real-api-realtime-delta', async () => {
    const history = await api('B', `/groups/${mainRoom}/messages`); const baseline = history.data.sync_event_seq;
    await bChannel.client.removeAllChannels(); await bChannel.client.realtime.disconnect();
    const sent = await send('B', mainRoom); assert.equal(sent.status, 201);
    assert.equal((await api('B', `/groups/${mainRoom}/messages/${sent.data.message.id}`, 'DELETE')).status, 200);
    let cursor, highwater; const recovered = [];
    do {
      const r = await api('B', `/groups/${mainRoom}/message-events?limit=1&${cursor ? 'cursor=' + cursor : 'after_event_seq=' + baseline}`);
      assert.equal(r.status, 200); highwater ??= r.data.through_event_seq; assert.equal(r.data.through_event_seq, highwater);
      recovered.push(...r.data.events); assert.ok(r.data.messages.every(m => m.id !== sent.data.message.id || m.body === null)); cursor = r.data.next_cursor;
    } while (cursor);
    assert.deepEqual(recovered.map(e => e.type), ['created', 'deleted']);
    const renewed = await bChannel.client.auth.refreshSession({ refresh_token: sessions.B.refresh_token }); assert.equal(renewed.error, null); sessions.B = renewed.data.session;
    bChannel = await subscribe('B', mainRoom); const newMessage = await send('B', mainRoom); assert.equal(newMessage.status, 201); await positive('B', newMessage.data.message.id);
    for (const receipt of report.receipts) assert.deepEqual(receipt.columns, ['created_at', 'event_seq', 'event_type', 'message_id', 'room_id']);
  });
  await test('account deletion commits before blocked send; pending send denied without rows', 'real-auth-db-race', async () => {
    const r = await makeRoom('B', ['D']);
    await blocker.query('begin'); await blocker.query('select id from public.rooms where id=$1 for share', [r]);
    // Auth CASCADE now also takes this room lock. Queue it FIRST, then the send,
    // and release the barrier before awaiting deletion (avoids self-blocking).
    const removing = deleteVictim('D'); await waitBlocked();
    const authReady = new Promise(resolve => { authenticated = resolve; });
    const pending = send('D', r);
    await waitForBarrier(authReady, pending, 'send authentication');
    await waitForBlockedRpc(db, blockerPid, 'chat_send_message', pending);
    await blocker.query('commit'); await removing;
    report.barriers.push({ phase, delete_committed_at: new Date().toISOString() });
    assert.equal((await pending).status, 404); assert.equal((await send('D', r)).status, 401);
    assert.equal((await db.query('select count(*)::int as n from public.messages where room_id=$1', [r])).rows[0].n, 0);
  });
  await test('send commits before blocked Auth deletion; one message survives with NULL sender', 'real-auth-db-race', async () => {
    const r = await makeRoom('B', ['E']); const id = randomUUID();
    await blocker.query('begin'); await blocker.query('set local role service_role');
    const sent = await blocker.query('select public.chat_send_message($1,$2,$3,$4) as result', [report.users.E, r, 'final verification', id]); assert.equal(sent.rows[0].result.status, 201);
    const deleting = deleteVictim('E'); await waitBlocked(); await blocker.query('commit'); await deleting;
    const { rows: [m] } = await db.query('select sender_id,body is not null as retained from public.messages where room_id=$1 and client_message_id=$2', [r, id]); assert.equal(m.sender_id, null); assert.ok(m.retained);
    assert.equal((await send('E', r, id)).status, 401);
  });
  await test('eleven concurrent sends enforce global quota and unique room/event order', 'real-postgrest-rpc-concurrency', async () => {
    const r = await makeRoom('C');
    const sends = await Promise.all(Array.from({ length: 11 }, () => send('C', r)));
    assert.equal(sends.filter(s => s.status === 201).length, 10); assert.equal(sends.filter(s => s.status === 429).length, 1);
    const { rows: [m] } = await db.query('select count(*)::int as n,count(distinct room_seq)::int as unique_seq,max(room_seq)::int as maximum from public.messages where room_id=$1', [r]); assert.deepEqual(m, { n: 10, unique_seq: 10, maximum: 10 });
    const target = sends.find(s => s.status === 201).data.message.id;
    const deletes = await Promise.all([0, 1].map(() => api('C', `/groups/${r}/messages/${target}`, 'DELETE'))); assert.ok(deletes.every(d => d.status === 200));
    assert.equal((await db.query("select count(*)::int as n from public.room_message_events where message_id=$1 and event_type='deleted'", [target])).rows[0].n, 1);
  });
  await test('group API create, list, invite, join, members and leave remain compatible', 'real-group-api', async () => {
    const r = await api('B', '/groups', 'POST', { name: run }); assert.equal(r.status, 201); const id = r.data.group.id; report.rooms.push(id);
    assert.ok((await api('B', '/groups')).data.groups.some(g => g.id === id));
    const invitation = await api('B', `/groups/${id}/invite-code`); assert.equal(invitation.status, 200);
    assert.equal((await api('C', '/groups/join', 'POST', { invite_code: invitation.data.invite_code })).status, 201);
    assert.equal((await api('C', `/groups/${id}/members`)).status, 200);
    assert.equal((await api('C', `/groups/${id}/invite-code`)).status, 403);
    assert.equal((await api('C', `/groups/${id}/members/me`, 'DELETE')).status, 204);
    assert.equal((await api('B', `/groups/${id}/members/me`, 'DELETE')).status, 204);
  });
  await test('effective availability boundaries are reused without mutating profiles on read', 'real-group-rpc-state-contract', async () => {
    const r = await makeRoom('B');
    for (const [isFree, delta, expected] of [[true, null, true], [true, 60, true], [true, -60, false], [false, null, false]]) {
      await db.query("update public.profiles set is_free=$2,free_until=case when $3::int is null then null else clock_timestamp()+$3*interval '1 second' end where id=$1", [report.users.B, isFree, delta]);
      const before = (await db.query('select to_jsonb(p) as row from public.profiles p where id=$1', [report.users.B])).rows[0].row;
      const members = await api('B', `/groups/${r}/members`); assert.equal(members.status, 200); assert.equal(members.data.members[0].is_free, expected);
      assert.deepEqual((await db.query('select to_jsonb(p) as row from public.profiles p where id=$1', [report.users.B])).rows[0].row, before);
    }
  });
  const { rows: functions } = await db.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('toggle_profile_is_free','set_profile_is_free','extend_profile_is_free','auto_expire_free_status') order by p.proname");
  report.timer_functions_present = functions.map(f => f.proname);
  if (!functions.length) report.tests.push({ name: 'real timer update/extend/expiry API integration', kind: 'unavailable', status: 'SKIP', reason: 'Dedicated local stack has no production timer functions; definitions may not be added in this task.' });
  await test('SQL privilege and publication boundaries remain least-privilege', 'real-db-catalog', async () => {
    for (const role of ['anon', 'authenticated']) for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal((await db.query("select has_table_privilege($1,'public.messages',$2) as allowed", [role, privilege])).rows[0].allowed, false);
      if (role !== 'authenticated' || privilege !== 'SELECT') assert.equal((await db.query("select has_table_privilege($1,'public.room_message_events',$2) as allowed", [role, privilege])).rows[0].allowed, false);
    }
    const tables = (await db.query("select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' order by tablename")).rows.map(r => r.tablename);
    assert.ok(tables.includes('room_message_events')); assert.ok(!tables.includes('messages'));
    assert.equal((await db.query('select count(*)::int as n from public.room_message_events e left join public.messages m on m.room_id=e.room_id and m.id=e.message_id where m.id is null')).rows[0].n, 0);
  });
  await test('all preexisting user/data rows and backend sources remain unchanged', 'preservation', async () => {
    report.preservation.after = await preservation(); assert.deepEqual(report.preservation.after, report.preservation.before);
    report.preservation.sources_after = sourceHashes(); assert.deepEqual(report.preservation.sources_after, report.preservation.sources_before);
    assert.equal(report.deleted_users.length, 3); assert.ok(report.deleted_users.every(id => [...created.values()].some(c => c.id === id)));
  });
}
try { await main(); report.status = 'COMPLETE'; }
catch (error) { report.status = 'STOPPED'; report.failed_phase = phase; report.error_type = error.name; process.exitCode = 1; }
finally {
  for (const c of clients) { await c.removeAllChannels().catch(() => {}); await c.realtime.disconnect(); }
  if (server) { server.close(); server.closeAllConnections(); }
  if (blocker) { await blocker.query('rollback').catch(() => {}); await blocker.end(); }
  if (db) { report.retained = (await db.query('select room_id,count(*)::int as messages,count(*) filter(where deleted_at is not null)::int as deleted from public.messages where room_id=any($1::uuid[]) group by room_id order by room_id', [report.rooms])).rows; await db.end(); }
  report.summary = { passed: report.tests.filter(t => t.status === 'PASS').length, failed: report.tests.filter(t => t.status === 'FAIL').length,
    skipped: report.tests.filter(t => t.status === 'SKIP').length, status: report.status, failed_phase: report.failed_phase };
  save(); console.log(JSON.stringify({ run, ...report.summary, deletion_failure: report.deletion_failure }));
}
