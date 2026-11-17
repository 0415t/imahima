import { disabledTimerDependencies } from '../../tests/helpers/chat-availability.ts';
// Dedicated local regression. Only users/rooms created in this run are mutated/deleted.
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
import { waitForBlockedRpc } from './barriers.mjs';
const require = createRequire(new URL('../../server/index.ts', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const run = `archive-${Date.now()}-${randomUUID().slice(0, 8)}`;
const report = { run, tests: [], rooms: [], users: {}, deleted: [], http: [], barriers: [], events: [] };
const tokens = {}, sessions = {}, entries = new Map(), roomCodes = new Map(), clients = [];
let db, blocker, server, admin, stage = 'preflight', oldRooms, oldUsers, blockerPid, base, settings;
const save = () => fs.writeFileSync(path.join(runtime, `${run}.json`), JSON.stringify(report, null, 2));
async function test(name, work) {
  stage = name; const row = { name, status: 'RUNNING' }; report.tests.push(row); save();
  try { row.observation = await work(); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = { type: error.name, code: error.code }; save(); throw error; }
  save();
}
async function api(label, route, method = 'GET', body) {
  const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[label]}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  const data = r.status === 204 ? null : await r.json(); report.http.push({ stage, method, route, status: r.status }); return { status: r.status, data };
}
async function rpc(op, label, args) {
  const r = await admin.rpc('group_mvp_execute', { p_operation: op, p_actor: report.users[label], p_args: args });
  assert.equal(r.error, null); return r.data;
}
async function makeRoom(label, members = [], managed = true) {
  let id;
  if (managed) { const r = await rpc('create', label, { name: run }); assert.equal(r.status, 201); id = r.data.group.id; roomCodes.set(id, r.data.invite_code); }
  else {
    id = randomUUID(); const code = randomUUID().replaceAll('-', ''); roomCodes.set(id, code);
    await db.query('insert into public.rooms(id,room_name,room_key,mvp_created_by,mvp_managed) values($1,$2,$3,$4,false)', [id, run, code, report.users[label]]);
    await db.query('insert into public.room_members(room_id,user_id) values($1,$2)', [id, report.users[label]]);
  }
  report.rooms.push(id);
  for (const member of members) assert.equal((await rpc('join', member, { invite_code: roomCodes.get(id) })).status, 201);
  return id;
}
async function state(id) { return (await db.query('select mvp_managed,mvp_archived_at is not null as archived,(select count(*)::int from public.room_members where room_id=$1) as members from public.rooms where id=$1', [id])).rows[0]; }
const leave = (label, id) => api(label, `/groups/${id}/members/me`, 'DELETE');
const send = (label, id, client = randomUUID()) => api(label, `/groups/${id}/messages`, 'POST', { body: 'archive regression', client_message_id: client });
async function remove(label) {
  const entry = entries.get(label); assert.ok(entry && !oldUsers.includes(entry.id));
  const user = await admin.auth.admin.getUserById(entry.id); assert.equal(user.error, null); assert.equal(user.data.user.user_metadata.username, `${run}-${label}`);
  const r = await admin.auth.admin.deleteUser(entry.id, false);
  if (r.error) report.auth_delete_error = { label, status: r.error.status, code: r.error.code, name: r.error.name };
  assert.equal(r.error, null); report.deleted.push(entry.id); save();
}
async function waitBlocked() {
  for (let n = 0; n < 70; n++) {
    const r = await db.query('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting', [blockerPid]);
    if (r.rows[0].waiting) { report.barriers.push({ stage, at: new Date().toISOString() }); return; }
    await sleep(40);
  }
  throw Error('Missing lock barrier');
}
async function holdGroup(operation, label, args) {
  await blocker.query('begin'); await blocker.query('set local role service_role');
  return (await blocker.query('select public.group_mvp_execute($1,$2,$3) as r', [operation, report.users[label], args])).rows[0].r;
}
async function preservation() {
  const result = {};
  for (const [table, column, ids] of [['auth.users', 'id', oldUsers], ['public.profiles', 'id', oldUsers], ['public.rooms', 'id', oldRooms],
    ['public.room_members', 'room_id', oldRooms], ['public.messages', 'room_id', oldRooms], ['public.room_message_events', 'room_id', oldRooms]]) {
    const expr = table === 'auth.users' ? 't.id::text' : 'to_jsonb(t)::text';
    result[table] = (await db.query(`select count(*)::int as n,md5(coalesce(string_agg(${expr},'' order by ${expr}),'')) as digest from ${table} t where ${column}=any($1::uuid[])`, [ids])).rows[0];
  }
  return result;
}
async function main() {
  const v = await connectVerified(); db = v.client; report.identity = v.identity;
  assert.equal((await db.query('select count(*)::int as n from public.rooms where mvp_managed is null')).rows[0].n, 0);
  oldRooms = (await db.query('select id::text from public.rooms')).rows.map(r => r.id); oldUsers = (await db.query('select id::text from auth.users')).rows.map(r => r.id);
  report.before = await preservation();
  settings = JSON.parse(fs.readFileSync(path.join(runtime, 'local-status.credentials.json'), 'utf8'));
  const u = new URL(settings.DB_URL); blocker = new Client({ host: '127.0.0.1', port: 56322, database: 'postgres',
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ssl: false, connectionTimeoutMillis: 5000 }); await blocker.connect();
  blockerPid = (await blocker.query('select pg_backend_pid() as id')).rows[0].id;
  const safeFetch = (input, init) => { const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); assert.equal(u.origin, 'http://127.0.0.1:56321'); return fetch(input, { ...init, redirect: 'error' }); };
  const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(safeFetch) } };
  admin = createClient(settings.API_URL, settings.SERVICE_ROLE_KEY, options);
  for (const label of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']) {
    const email = `${run}-${label}@example.test`, password = randomUUID() + randomUUID();
    const r = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `${run}-${label}` } }); assert.equal(r.error, null);
    entries.set(label, { id: r.data.user.id }); report.users[label] = r.data.user.id;
    const client = createClient(settings.API_URL, settings.ANON_KEY, options); const login = await client.auth.signInWithPassword({ email, password }); assert.equal(login.error, null); sessions[label] = login.data.session; tokens[label] = login.data.session.access_token;
  }
  const identity = async token => { const { data, error } = await admin.auth.getUser(token); return { userId: data.user?.id ?? null, error }; };
  const groups = groupService(admin, identity); groups.rateSecret = randomUUID();
  server = createServer(createApp({ ...disabledTimerDependencies, getUserId: identity, toggleIsFree: async () => { throw Error('Disabled'); } }, undefined, groups, chatService(admin, groups)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;

  await test('trigger owner, search_path, RLS visibility and no public execution', async () => {
    const r = (await db.query("select prosecdef,proconfig,pg_get_userbyid(proowner) as owner from pg_proc where oid='group_mvp_private.archive_empty_membership_rooms()'::regprocedure")).rows[0];
    assert.equal(r.prosecdef, true); assert.equal(r.owner, 'postgres'); assert.ok(r.proconfig.includes('search_path=""')); assert.ok(r.proconfig.includes('row_security=off'));
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal((await db.query("select has_function_privilege($1,'group_mvp_private.archive_empty_membership_rooms()','EXECUTE') as allowed", [role])).rows[0].allowed, false);
    return { owner: r.owner, direct_general_or_service_execution: false };
  });
  await test('creator deletion then last leave archives and rejects old invitation', async () => {
    const id = await makeRoom('A', ['B']); assert.equal((await send('A', id)).status, 201); await remove('A');
    assert.equal((await state(id)).archived, false); assert.equal((await leave('B', id)).status, 204);
    assert.deepEqual(await state(id), { mvp_managed: true, archived: true, members: 0 });
    assert.equal((await rpc('join', 'C', { invite_code: roomCodes.get(id) })).status, 400);
    assert.equal((await api('B', `/groups/${id}/messages`)).status, 404); assert.equal((await api('B', `/groups/${id}/message-events`)).status, 404);
  });
  await test('last member Auth hard delete alone archives room', async () => {
    const id = await makeRoom('D'); await remove('D'); assert.deepEqual(await state(id), { mvp_managed: true, archived: true, members: 0 });
    assert.equal((await rpc('join', 'C', { invite_code: roomCodes.get(id) })).status, 400);
  });
  await test('Auth deletion with remaining members leaves active room', async () => {
    const id = await makeRoom('E', ['B']); await remove('E'); assert.equal((await state(id)).archived, false); assert.equal((await state(id)).members, 1);
  });
  await test('non-MVP empty room is preserved', async () => {
    const id = await makeRoom('B', [], false); assert.equal((await leave('B', id)).status, 204); assert.deepEqual(await state(id), { mvp_managed: false, archived: false, members: 0 });
  });
  await test('explicit membership deletion archives; role-only update does not', async () => {
    const id = await makeRoom('B'); await db.query("update public.room_members set role='member' where room_id=$1", [id]); assert.equal((await state(id)).archived, false);
    await db.query('delete from public.room_members where room_id=$1', [id]); assert.equal((await state(id)).archived, true);
  });
  await test('room_id update archives the emptied OLD room only', async () => {
    const old = await makeRoom('C'), target = await makeRoom('B');
    await db.query('update public.room_members set room_id=$2 where room_id=$1 and user_id=$3', [old, target, report.users.C]);
    assert.equal((await state(old)).archived, true); assert.equal((await state(target)).archived, false); assert.equal((await state(target)).members, 2);
  });
  await test('last leave before join: join waits then returns 400', async () => {
    const id = await makeRoom('B'); assert.equal((await holdGroup('leave', 'B', { room_id: id })).status, 204);
    const joining = rpc('join', 'C', { invite_code: roomCodes.get(id) }); await waitBlocked(); await blocker.query('commit'); assert.equal((await joining).status, 400);
  });
  await test('join before last leave: committed newcomer prevents archive', async () => {
    const id = await makeRoom('B'); assert.equal((await holdGroup('join', 'C', { invite_code: roomCodes.get(id) })).status, 201);
    const leaving = leave('B', id); await waitBlocked(); await blocker.query('commit'); assert.equal((await leaving).status, 204); assert.equal((await state(id)).archived, false);
    await leave('C', id); assert.equal((await state(id)).archived, true);
  });
  await test('last Auth deletion before join closes room atomically', async () => {
    const id = await makeRoom('B', ['G']); await leave('B', id);
    await blocker.query('begin'); await blocker.query('select id from public.rooms where id=$1 for share', [id]);
    const deleting = remove('G'); await waitBlocked(); const joining = rpc('join', 'C', { invite_code: roomCodes.get(id) });
    await waitForBlockedRpc(db, blockerPid, 'group_mvp_execute', joining);
    await blocker.query('commit'); await deleting; assert.equal((await joining).status, 400); assert.equal((await state(id)).archived, true);
  });
  await test('join before last Auth deletion keeps newcomer and active room', async () => {
    const id = await makeRoom('B', ['H']); await leave('B', id);
    assert.equal((await holdGroup('join', 'C', { invite_code: roomCodes.get(id) })).status, 201);
    const deleting = remove('H'); await waitBlocked(); await blocker.query('commit'); await deleting;
    assert.deepEqual(await state(id), { mvp_managed: true, archived: false, members: 1 });
  });
  await test('multi-room Auth cascade archives empty rooms and preserves populated room', async () => {
    const first = await makeRoom('F'), second = await makeRoom('F'), active = await makeRoom('F', ['B']); await remove('F');
    assert.equal((await state(first)).archived, true); assert.equal((await state(second)).archived, true); assert.equal((await state(active)).archived, false);
  });
  await test('simultaneous two-user multi-room Auth deletes maintain atomic lifecycle', async () => {
    const first = await makeRoom('I', ['J']), second = await makeRoom('J', ['I']);
    await Promise.all([remove('I'), remove('J')]); assert.equal((await state(first)).archived, true); assert.equal((await state(second)).archived, true);
  });
  await test('send commits before Auth delete, retaining message and archiving room', async () => {
    const id = await makeRoom('K'); await blocker.query('begin'); await blocker.query('set local role service_role');
    const sent = (await blocker.query('select public.chat_send_message($1,$2,$3,$4) as r', [report.users.K, id, 'archive regression', randomUUID()])).rows[0].r; assert.equal(sent.status, 201);
    const deleting = remove('K'); await waitBlocked(); await blocker.query('commit'); await deleting;
    assert.equal((await state(id)).archived, true); assert.equal((await db.query('select sender_id from public.messages where room_id=$1', [id])).rows[0].sender_id, null);
  });
  await test('trigger room lock timeout rolls back membership deletion', async () => {
    const id = await makeRoom('B'); await blocker.query('begin'); await blocker.query('select id from public.rooms where id=$1 for update', [id]);
    let code; try { await db.query('delete from public.room_members where room_id=$1', [id]); } catch (error) { code = error.code; }
    await blocker.query('commit'); assert.equal(code, '55P03'); assert.equal((await state(id)).members, 1); assert.equal((await state(id)).archived, false);
    return { sqlstate: code, rolled_back: true };
  });
  await test('trigger failure under unsupported isolation rolls back all changes', async () => {
    const id = await makeRoom('B'); await db.query('begin isolation level repeatable read'); let code;
    try { await db.query('delete from public.room_members where room_id=$1', [id]); } catch (error) { code = error.code; } finally { await db.query('rollback'); }
    assert.equal(code, 'P0001'); assert.equal((await state(id)).members, 1); assert.equal((await state(id)).archived, false);
  });
  await test('leave blocks pending send and archived room denies API/delta/old code', async () => {
    const id = await makeRoom('B'); await holdGroup('leave', 'B', { room_id: id });
    const pending = send('B', id); await waitBlocked(); await blocker.query('commit'); assert.equal((await pending).status, 404);
    assert.equal((await api('B', `/groups/${id}/messages`)).status, 404); assert.equal((await api('B', `/groups/${id}/message-events`)).status, 404);
  });
  await test('Realtime RLS denies post-archive probe while active room control receives', async () => {
    const archived = await makeRoom('B'), active = await makeRoom('B');
    class Socket extends WebSocket { constructor(url, protocols) { assert.equal(new URL(url).origin, 'ws://127.0.0.1:56321'); super(url, protocols); } }
    const c = createClient(settings.API_URL, settings.ANON_KEY, { ...options, realtime: { transport: Socket, logger: () => {} } }); clients.push(c);
    assert.equal((await c.auth.setSession(sessions.B)).error, null); await c.realtime.setAuth(tokens.B);
    const channels = [];
    for (const id of [archived, active]) {
      const ch = c.channel(`${run}-${id}`, { config: { postgres_changes_options: { wait: true, timeout: 15000 } } }).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_message_events', filter: `room_id=eq.${id}` }, p => report.events.push({ room: p.new.room_id, message: p.new.message_id, columns: Object.keys(p.new).sort() })); channels.push(ch);
      await new Promise((resolve, reject) => { const t = setTimeout(() => reject(Error('Subscription timeout')), 22000); ch.subscribe(s => { if (s === 'SUBSCRIBED') { clearTimeout(t); resolve(); } else if (['CHANNEL_ERROR', 'TIMED_OUT'].includes(s)) { clearTimeout(t); reject(Error('Subscription error')); } }); });
    }
    const original = await send('B', archived); assert.equal(original.status, 201);
    for (let n = 0; n < 120 && !report.events.some(e => e.message === original.data.message.id); n++) await sleep(50);
    assert.ok(report.events.some(e => e.message === original.data.message.id)); await leave('B', archived);
    // Privileged metadata probe in this NEW archived fixture only. Normal APIs
    // remain denied. This tests actual delivery RLS, not absence of any INSERT.
    const probe = randomUUID();
    await db.query('begin'); await db.query('select id from public.rooms where id=$1 for update', [archived]);
    await db.query('insert into public.messages(id,room_id,sender_id,room_seq,body,client_message_id,last_event_seq) values($1,$2,$3,2,$4,$5,2)', [probe, archived, report.users.B, 'archive policy probe', randomUUID()]);
    await db.query("insert into public.room_message_events(room_id,event_seq,message_id,event_type) values($1,2,$2,'created')", [archived, probe]); await db.query('commit');
    const control = await send('B', active); assert.equal(control.status, 201);
    for (let n = 0; n < 120 && !report.events.some(e => e.message === control.data.message.id); n++) await sleep(50);
    assert.ok(report.events.some(e => e.message === control.data.message.id)); await sleep(2000);
    assert.equal(c.realtime.isConnected(), true); assert.ok(channels.every(ch => ch.state === 'joined')); assert.ok(!report.events.some(e => e.message === probe));
    const response = await safeFetch(`${settings.API_URL}/rest/v1/room_message_events?room_id=eq.${archived}&select=event_seq`, { headers: { apikey: settings.ANON_KEY, Authorization: `Bearer ${tokens.B}` } }); assert.deepEqual(await response.json(), []);
    return { privileged_probe: true, active_control_received: true, archived_probe_received: false };
  });
  await test('preexisting rows, invitation codes, histories and memberships are preserved', async () => {
    report.after = await preservation(); assert.deepEqual(report.after, report.before);
  });
}
try { await main(); report.status = 'COMPLETE'; }
catch (error) { report.status = 'STOPPED'; report.failed_stage = stage; report.error = { type: error.name, code: error.code }; process.exitCode = 1; }
finally {
  for (const c of clients) { await c.removeAllChannels().catch(() => {}); await c.realtime.disconnect(); }
  if (server) { server.close(); server.closeAllConnections(); }
  if (blocker) { await blocker.query('rollback').catch(() => {}); await blocker.end(); }
  if (db) { await db.query('rollback').catch(() => {}); await db.end(); }
  report.summary = { passed: report.tests.filter(t => t.status === 'PASS').length, failed: report.tests.filter(t => t.status === 'FAIL').length, status: report.status, failed_stage: report.failed_stage };
  save(); console.log(JSON.stringify({ run, ...report.summary, auth_delete_error: report.auth_delete_error }));
}
