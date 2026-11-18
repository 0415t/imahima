import { Buffer } from 'node:buffer';
// Real local Auth/JWT/PostgREST/Realtime test. Keeps every created test row.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectVerified, authSnapshot, root, runtime } from './schema-tools.mjs';
const require = createRequire(new URL('../../server/index.ts', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
assert.ok(process.argv.slice(2).every(a => a === '--legacy-subscribe'), 'Unsupported option');
const legacySubscribe = process.argv.includes('--legacy-subscribe');
const run = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const output = path.join(runtime, `integration-${run}`); fs.mkdirSync(output);
const report = { run, started_at: new Date().toISOString(), tests: [], http: [], rpc: [], subscriptions: [], events: [], barriers: [], data: { users: {}, rooms: [] }, warnings: [] };
const sessions = {}, clients = new Set(), channels = [], published = new Map();
let child, db, authBefore, phase = 'preflight', firstRoom, secondRoom, invitation;
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeError = error => ({ code: error?.code ?? 'TEST_FAILURE', ...(typeof error?.actual === 'number' ? { actual: error.actual } : {}), ...(typeof error?.expected === 'number' ? { expected: error.expected } : {}) });
async function test(name, action) {
  const row = { name, started_at: new Date().toISOString() }; report.tests.push(row); save();
  try { row.observation = await action(); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.failure = safeError(error); }
  row.finished_at = new Date().toISOString(); save(); console.log(`${row.status}: ${name}`); return row.status === 'PASS';
}
async function until(predicate, ms = 12000) {
  const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return; await sleep(100); }
  assert.fail('Timed out waiting for positive local control');
}
function target(url) { const u = new URL(url); assert.ok(['http://127.0.0.1:56321', 'http://127.0.0.1:56331'].includes(u.origin)); return u; }
async function request(origin, route, method = 'GET', body, token, category = 'api') {
  const url = target(new URL(route, origin));
  const headers = { 'Content-Type': 'application/json' };
  if (url.port === '56321') headers.apikey = status.ANON_KEY;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) });
  const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* Never record response body. */ }
  report.http.push({ category, route: url.pathname, method, status: response.status, rpc_status: url.pathname.startsWith('/rest/v1/rpc/') && typeof data?.status === 'number' ? data.status : null, observed_at: new Date().toISOString() });
  return { status: response.status, data, retry: response.headers.get('retry-after') };
}
let status;
const api = (user, route, method = 'GET', body) => request('http://127.0.0.1:56331', route, method, body, user ? sessions[user].access_token : undefined);
const direct = (user, route, method = 'GET', body) => request('http://127.0.0.1:56321', route, method, body, sessions[user].access_token, 'direct-user');
async function send(user, room, body = 'Local integration text', id = randomUUID()) {
  const result = await api(user, `/groups/${room}/messages`, 'POST', { body, client_message_id: id });
  if ([200, 201].includes(result.status)) published.set(result.data.message.id, { room_id: room, sender_id: report.data.users[user], client_message_id: id, created_at: result.data.message.created_at });
  return { ...result, clientId: id };
}
class LocalSocket extends WebSocket {
  constructor(url, protocols) { assert.equal(new URL(url).origin, 'ws://127.0.0.1:56321'); super(url, protocols); }
}
async function realtimeClient(user) {
  const c = createClient('http://127.0.0.1:56321', status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init) => { const url = typeof input === 'string' || input instanceof URL ? input : input.url; assert.equal(target(url).origin, 'http://127.0.0.1:56321'); return fetch(input, { ...init, redirect: 'error' }); } }, realtime: { transport: LocalSocket, logger: () => {} } });
  clients.add(c);
  const set = await c.auth.setSession(sessions[user]); assert.equal(set.error, null);
  await c.realtime.setAuth(sessions[user].access_token); return c;
}
async function subscribe(c, user, kind, room) {
  const label = `${user}-${kind}-${channels.length}`;
  const filter = { event: 'INSERT', schema: 'public', table: 'room_message_events', ...(room ? { filter: `room_id=eq.${room}` } : {}) };
  const channel = c.channel(`chat-it-${run}-${label}`, legacySubscribe ? undefined : { config: { postgres_changes_options: { wait: true, timeout: 15000 } } }).on('postgres_changes', filter, payload => {
    const row = payload.new;
    report.events.push({ receiver: user, channel: label, room_id: row.room_id, event_seq: String(row.event_seq), message_id: row.message_id, event_type: row.event_type, event_created_at: row.created_at, received_at: new Date().toISOString(), payload_columns: Object.keys(row).sort() });
  });
  const entry = { client: c, user, label, kind, room, channel, active: true }; channels.push(entry);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Subscription timeout')), 22000);
    channel.subscribe((state, error) => {
      report.subscriptions.push({ receiver: user, label, state, observed_at: new Date().toISOString(), error_present: Boolean(error) });
      if (state === 'SUBSCRIBED') { clearTimeout(timeout); resolve(); }
      else if (['CHANNEL_ERROR','TIMED_OUT'].includes(state)) { clearTimeout(timeout); reject(new Error('Subscription rejected')); }
    });
  });
  return entry;
}
const received = (entry, message, type = 'created') => report.events.some(e => e.channel === entry.label && e.message_id === message && e.event_type === type);
async function positive(entry, message, type = 'created') { await until(() => received(entry, message, type)); }
function live(entries) { for (const entry of entries) { assert.equal(entry.channel.state, 'joined'); assert.equal(entry.client.realtime.isConnected(), true); } }
async function leaveProof(aChannel, bEntries, cEntries, iteration) {
  live(bEntries); live(cEntries);
  const left = await api('B', `/groups/${firstRoom}/members/me`, 'DELETE'); assert.equal(left.status, 204);
  const { rows: [barrier] } = await db.query('select clock_timestamp() as acknowledged_db_time, exists(select 1 from public.room_members where room_id=$1 and user_id=$2) as member', [firstRoom, report.data.users.B]);
  assert.equal(barrier.member, false);
  const record = { iteration, exit_http: 204, exit_ack_at: new Date().toISOString(), db_confirmed_at: barrier.acknowledged_db_time.toISOString(), samples: [] }; report.barriers.push(record);
  for (let n = 0; n < 3; n++) {
    live(bEntries);
    const sent = await send('A', firstRoom); assert.equal(sent.status, 201);
    await positive(aChannel, sent.data.message.id); await sleep(2000); live(bEntries); live(cEntries);
    const { rows: [event] } = await db.query('select event_seq::text,created_at from public.room_message_events where room_id=$1 and message_id=$2 and event_type=\'created\'', [firstRoom, sent.data.message.id]);
    assert.ok(event.created_at >= barrier.acknowledged_db_time);
    const denied = bEntries.every(e => !received(e, sent.data.message.id));
    const cDenied = cEntries.every(e => !received(e, sent.data.message.id));
    record.samples.push({ message_id: sent.data.message.id, event_seq: event.event_seq, sender_id: report.data.users.A, event_created_at: event.created_at.toISOString(), a_received: true, b_received: !denied, c_received: !cDenied, b_subscription_states: bEntries.map(e => e.channel.state), observation_ms: 2000 });
    assert.ok(denied && cDenied);
  }
  return { iteration, samples: 3, positive_a_control: true, retained_b_subscriptions: true };
}
async function renew(user, c) {
  const result = await c.auth.refreshSession({ refresh_token: sessions[user].refresh_token }); assert.equal(result.error, null); assert.ok(result.data.session);
  sessions[user] = { access_token: result.data.session.access_token, refresh_token: result.data.session.refresh_token };
  await c.realtime.setAuth(sessions[user].access_token);
}
async function retire(c) { for (const entry of channels) if (entry.client === c) entry.active = false; await c.removeAllChannels(); await c.realtime.disconnect(); }
async function waitFreshUserQuota(user) {
  const { rows: [row] } = await db.query("select greatest(0,ceil(extract(epoch from max(created_at)+interval '60 seconds'-clock_timestamp())*1000))::int as wait_ms from public.messages where sender_id=$1", [report.data.users[user]]);
  if (row.wait_ms > 0) { console.log(`WAIT: real rolling-window expiry (${Math.ceil(row.wait_ms / 1000)} seconds)`); await sleep(row.wait_ms + 150); }
}
try {
  const verified = await connectVerified(); db = verified.client; report.identity = verified.identity;
  status = JSON.parse(fs.readFileSync(path.join(runtime, 'local-status.credentials.json'), 'utf8'));
  const { rows: [counts] } = await db.query('select (select count(*) from auth.users)::int as users,(select count(*) from public.rooms)::int as rooms,(select count(*) from public.messages)::int as messages');
  report.baseline_counts = counts; // Existing retained cohorts are allowed; this run uses only fresh identities.
  authBefore = await authSnapshot(db);
  phase = 'local-api-start';
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(SUPABASE_|EXPO_PUBLIC_|PG[A-Z_]|DATABASE_URL$|DOTENV_|GROUP_RATE_SECRET$)/.test(key)) delete env[key];
  Object.assign(env, { SUPABASE_URL: 'http://127.0.0.1:56321', SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, CHAT_LOCAL_PROJECT_ID: 'imahima-chat-local', CHAT_INTEGRATION_RUN: run, GROUP_RATE_SECRET: randomBytes(32).toString('hex'), PORT: '56331' });
  child = spawn(process.execPath, ['--import', pathToFileURL(path.resolve(root, '../../node_modules/tsx/dist/loader.mjs')).href, path.join(root, 'integration-api.ts')], { cwd: root, env, stdio: ['ignore','pipe','pipe','ipc'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {}); // No raw API/SDK output persisted.
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('API startup timeout')), 20000);
    child.on('message', message => {
      if (message.type === 'rpc') report.rpc.push(message);
      if (message.type === 'ready' && message.project === 'imahima-chat-local' && message.run === run) { clearTimeout(timeout); resolve(); }
      if (message.type === 'fatal') { clearTimeout(timeout); reject(new Error('API startup failed')); }
    });
    child.once('error', () => { clearTimeout(timeout); reject(new Error('API process unavailable')); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('API process exited')); });
  });
  phase = 'auth-setup';
  await test('create local A/B/C, real password JWT and automatic profiles', async () => {
    for (const user of ['A','B','C']) {
      const password = randomBytes(30).toString('base64url') + 'aA1!'; const email = `chat-${user.toLowerCase()}-${run}@example.test`;
      const created = await request(status.API_URL, '/auth/v1/admin/users', 'POST', { email, password, email_confirm: true, user_metadata: { username: `Chat-${user}-${run}` } }, status.SERVICE_ROLE_KEY, 'auth');
      assert.equal(created.status, 200); report.data.users[user] = created.data.id; save();
      const login = await request(status.API_URL, '/auth/v1/token?grant_type=password', 'POST', { email, password }, undefined, 'auth'); assert.equal(login.status, 200);
      sessions[user] = { access_token: login.data.access_token, refresh_token: login.data.refresh_token };
      const claims = JSON.parse(Buffer.from(login.data.access_token.split('.')[1], 'base64url').toString());
      assert.equal(claims.sub, created.data.id); assert.equal(claims.role, 'authenticated');
      const { rows: [profile] } = await db.query('select id,is_free from public.profiles where id=$1', [created.data.id]); assert.equal(profile.id, created.data.id); assert.equal(profile.is_free, false);
    }
    return { users: 3, profiles: 3, password_or_token_logged: false };
  });
  assert.equal(Object.keys(sessions).length, 3);
  phase = 'group-setup';
  await test('create two local rooms; A/B in first, A only in second, C outside', async () => {
    const first = await api('A', '/groups', 'POST', { name: `Chat integration ${run}` }); assert.equal(first.status, 201);
    firstRoom = first.data.group.id; invitation = first.data.invite_code; report.data.rooms.push(firstRoom); save();
    const second = await api('A', '/groups', 'POST', { name: `Chat other-room ${run}` }); assert.equal(second.status, 201);
    secondRoom = second.data.group.id; report.data.rooms.push(secondRoom); save();
    assert.equal((await api('B', '/groups/join', 'POST', { invite_code: invitation })).status, 201);
  });
  assert.ok(firstRoom && secondRoom);
  phase = 'realtime-subscribe';
  let aClient, bClient, cClient, aFirst, aSecond, bFirst, bAll, bOther, cFirst, cAll;
  const realtimeReady = await test('subscribe real-JWT A/B/C with room filters and unfiltered channels', async () => {
    aClient = await realtimeClient('A'); bClient = await realtimeClient('B'); cClient = await realtimeClient('C');
    aFirst = await subscribe(aClient, 'A', 'first', firstRoom); aSecond = await subscribe(aClient, 'A', 'second', secondRoom);
    bFirst = await subscribe(bClient, 'B', 'first', firstRoom); bAll = await subscribe(bClient, 'B', 'all'); bOther = await subscribe(bClient, 'B', 'other', secondRoom);
    cFirst = await subscribe(cClient, 'C', 'first', firstRoom); cAll = await subscribe(cClient, 'C', 'all');
    return { subscribed: 7, auth: 'local Auth-issued JWT' };
  });
  phase = 'api-contracts';
  await test('all four API routes reject missing and invalid JWT', async () => {
    for (const [route, method] of [[`/groups/${firstRoom}/messages`,'POST'],[`/groups/${firstRoom}/messages`,'GET'],[`/groups/${firstRoom}/messages/${randomUUID()}`,'DELETE'],[`/groups/${firstRoom}/message-events`,'GET']]) {
      assert.equal((await api(null, route, method)).status, 401);
      assert.equal((await request('http://127.0.0.1:56331', route, method, undefined, 'invalid.jwt')).status, 401);
    }
  });
  let initial;
  await test('normal send derives sender from verified JWT; spoofed sender rejected', async () => {
    initial = await send('A', firstRoom); assert.equal(initial.status, 201); assert.equal(initial.data.message.sender.id, report.data.users.A);
    assert.equal((await api('A', `/groups/${firstRoom}/messages`, 'POST', { body: 'forgery', client_message_id: randomUUID(), sender_id: report.data.users.B })).status, 400);
  });
  if (realtimeReady) await test('members receive INSERT; C filtered/unfiltered receives none', async () => {
    await positive(aFirst, initial.data.message.id); await positive(bFirst, initial.data.message.id); await positive(bAll, initial.data.message.id);
    await sleep(2000); live([cFirst,cAll]); assert.ok(!received(cFirst, initial.data.message.id) && !received(cAll, initial.data.message.id));
  });
  await test('same client ID replays 200; different body conflicts 409', async () => {
    const replay = await send('A', firstRoom, 'Local integration text', initial.clientId); assert.equal(replay.status, 200); assert.equal(replay.data.message.id, initial.data.message.id); assert.equal(replay.data.deduplicated, true);
    assert.equal((await send('A', firstRoom, 'different', initial.clientId)).status, 409);
  });
  await test('other sender delete 403; owner soft delete; deleted replay remains NULL', async () => {
    assert.equal((await api('B', `/groups/${firstRoom}/messages/${initial.data.message.id}`, 'DELETE')).status, 403);
    const removed = await api('A', `/groups/${firstRoom}/messages/${initial.data.message.id}`, 'DELETE'); assert.equal(removed.status, 200); assert.equal(removed.data.message.body, null);
    const replay = await send('A', firstRoom, 'Local integration text', initial.clientId); assert.equal(replay.status, 200); assert.equal(replay.data.message.body, null);
    if (realtimeReady) { await positive(aFirst, initial.data.message.id, 'deleted'); await positive(bFirst, initial.data.message.id, 'deleted'); }
  });
  await test('Unicode 499/500 code points accepted, 501 and whitespace rejected', async () => {
    for (const n of [499,500]) assert.equal((await send('B', firstRoom, '😀'.repeat(n))).status, 201);
    for (const body of ['😀'.repeat(501),'\u0085\u3000\t']) assert.equal((await send('B', firstRoom, body)).status, 400);
  });
  await test('nonmember C denied send/history/delete/delta', async () => {
    assert.equal((await send('C', firstRoom)).status, 404);
    for (const suffix of ['messages','message-events']) assert.equal((await api('C', `/groups/${firstRoom}/${suffix}`)).status, 404);
    assert.equal((await api('C', `/groups/${firstRoom}/messages/${initial.data.message.id}`, 'DELETE')).status, 404);
  });
  await test('history returns tombstones; event pagination returns current deleted state', async () => {
    const history = await api('B', `/groups/${firstRoom}/messages`); assert.equal(history.status, 200); assert.equal(history.data.messages.find(m => m.id === initial.data.message.id).body, null);
    let cursor, pages = 0, found = false;
    do { const r = await api('B', `/groups/${firstRoom}/message-events?limit=1${cursor ? '&cursor='+cursor : '&after_event_seq=0'}`); assert.equal(r.status, 200); pages++; const m = r.data.messages.find(m => m.id === initial.data.message.id); if (m) { assert.equal(m.body, null); found = true; } cursor = r.data.next_cursor; } while (cursor && pages < 20);
    assert.ok(found && pages >= 2 && !cursor);
  });
  await test('real user JWT cannot read messages or execute management RPCs directly', async () => {
    assert.equal((await direct('B', '/rest/v1/messages?select=id')).status, 403);
    for (const [name,args] of [
      ['group_mvp_execute',{p_operation:'list',p_actor:report.data.users.A,p_args:{}}],
      ['group_mvp_consume_rate',{p_key:'a'.repeat(64),p_maximum:10}],
      ['chat_send_message',{p_actor:report.data.users.A,p_room_id:firstRoom,p_body:'forgery',p_client_message_id:randomUUID()}],
      ['chat_delete_message',{p_actor:report.data.users.A,p_room_id:firstRoom,p_message_id:initial.data.message.id}],
      ['chat_list_messages',{p_actor:report.data.users.A,p_room_id:firstRoom}],
      ['chat_list_message_events',{p_actor:report.data.users.A,p_room_id:firstRoom}],
    ]) assert.equal((await direct('B', '/rest/v1/rpc/'+name, 'POST', args)).status, 403);
  });
  await test('PostgREST HTTP 200 with RPC JSON 404 maps to Express HTTP 404', async () => {
    const rpc = await request(status.API_URL, '/rest/v1/rpc/chat_list_messages', 'POST', { p_actor:report.data.users.C,p_room_id:firstRoom }, status.SERVICE_ROLE_KEY, 'direct-service-read');
    assert.equal(rpc.status, 200); assert.equal(rpc.data.status, 404); assert.equal((await api('C', `/groups/${firstRoom}/messages`)).status, 404);
    return { postgrest_http: 200, rpc_json: 404, express_http: 404 };
  });
  phase = 'quota';
  await test('10 successful sends across rooms including deleted row; 11th is 429', async () => {
    const { rows:[ledger] } = await db.query("select count(*)::int as n,count(*) filter(where deleted_at is not null)::int as deleted from public.messages where sender_id=$1 and created_at>clock_timestamp()-interval '60 seconds'", [report.data.users.A]);
    assert.equal(ledger.n,1); assert.equal(ledger.deleted,1);
    let otherControl;
    for (let i=1;i<10;i++) { const r=await send('A',i%2?secondRoom:firstRoom); assert.equal(r.status,201); if(i%2)otherControl=r.data.message.id; }
    const limited=await send('A',firstRoom); assert.equal(limited.status,429); assert.ok(Number(limited.retry)>0); assert.equal(Number(limited.retry),limited.data.retry_after_seconds);
    const replay=await send('A',firstRoom,'Local integration text',initial.clientId); assert.equal(replay.status,200); assert.equal(replay.data.message.body,null);
    if(realtimeReady){await positive(aSecond,otherControl);await sleep(2000);live([bOther,bAll,cFirst,cAll]);assert.ok(!received(bOther,otherControl)&&!received(bAll,otherControl)&&!received(cFirst,otherControl)&&!received(cAll,otherControl));}
    return {successful:10,deleted_counted:1,limit_http:429,replay_http:200};
  });
  if(realtimeReady){
    phase='quota-window-wait'; await waitFreshUserQuota('A');
    phase='realtime-authorization';
    await test('JWT refresh while member preserves authorized delivery',async()=>{await renew('B',bClient);const r=await send('A',firstRoom);assert.equal(r.status,201);await positive(aFirst,r.data.message.id);await positive(bFirst,r.data.message.id);});
    await test('exit cycle 1: retained B sockets reject three post-commit events',()=>leaveProof(aFirst,[bFirst,bAll,bOther],[cFirst,cAll],1));
    await test('departed B denied all API operations',async()=>{assert.equal((await send('B',firstRoom)).status,404);for(const s of ['messages','message-events'])assert.equal((await api('B',`/groups/${firstRoom}/${s}`)).status,404);assert.equal((await api('B',`/groups/${firstRoom}/messages/${initial.data.message.id}`,'DELETE')).status,404);});
    await test('JWT refresh after exit does not restore event access',async()=>{await renew('B',bClient);const r=await send('A',firstRoom);assert.equal(r.status,201);await positive(aFirst,r.data.message.id);await sleep(2000);live([bFirst,bAll,bOther]);assert.ok([bFirst,bAll,bOther].every(e=>!received(e,r.data.message.id)));});
    await test('fresh connection after exit cannot receive room or unfiltered events',async()=>{await retire(bClient);bClient=await realtimeClient('B');bFirst=await subscribe(bClient,'B','reconnected-first',firstRoom);bAll=await subscribe(bClient,'B','reconnected-all');bOther=await subscribe(bClient,'B','reconnected-other',secondRoom);const r=await send('A',firstRoom);assert.equal(r.status,201);await positive(aFirst,r.data.message.id);await sleep(2000);live([bFirst,bAll,bOther]);assert.ok([bFirst,bAll,bOther].every(e=>!received(e,r.data.message.id)));});
    await test('rejoin restores all history and live delivery without widening RLS',async()=>{assert.equal((await api('B','/groups/join','POST',{invite_code:invitation})).status,201);const h=await api('B',`/groups/${firstRoom}/messages`);assert.equal(h.status,200);assert.ok(h.data.messages.some(m=>m.id===initial.data.message.id&&m.body===null));const r=await send('A',firstRoom);assert.equal(r.status,201);await positive(aFirst,r.data.message.id);await positive(bFirst,r.data.message.id);await positive(bAll,r.data.message.id);});
    await test('exit cycle 2: retained B sockets reject three new post-commit events',()=>leaveProof(aFirst,[bFirst,bAll,bOther],[cFirst,cAll],2));
    phase='delta-recovery';
    await test('missed create/delete events recovered by paginated DB delta and reconnect',async()=>{
      assert.equal((await api('B','/groups/join','POST',{invite_code:invitation})).status,201);
      const before=await api('B',`/groups/${firstRoom}/message-events?after_event_seq=0&limit=100`);assert.equal(before.status,200);assert.equal(before.data.has_more,false);const checkpoint=before.data.next_after_event_seq;
      await retire(bClient);const lost=await send('B',firstRoom);assert.equal(lost.status,201);const stale={...lost.data.message};assert.equal((await api('B',`/groups/${firstRoom}/messages/${stale.id}`,'DELETE')).status,200);
      await positive(aFirst,stale.id,'deleted');let cursor,pages=0,restored=stale;const seen=[];
      do{const r=await api('B',`/groups/${firstRoom}/message-events?limit=1${cursor?'&cursor='+cursor:'&after_event_seq='+checkpoint}`);assert.equal(r.status,200);pages++;seen.push(...r.data.events);for(const m of r.data.messages)if(m.id===stale.id&&BigInt(m.last_event_seq)>=BigInt(restored.last_event_seq))restored=m;cursor=r.data.next_cursor;}while(cursor&&pages<10);
      assert.equal(pages,2);assert.deepEqual(seen.map(e=>e.type),['created','deleted']);assert.equal(restored.body,null);assert.ok(restored.deleted_at);
      bClient=await realtimeClient('B');bFirst=await subscribe(bClient,'B','recovered-first',firstRoom);bAll=await subscribe(bClient,'B','recovered-all');
      const control=await send('B',firstRoom);assert.equal(control.status,201);await positive(aFirst,control.data.message.id);await positive(bFirst,control.data.message.id);
      return {checkpoint,recovered_message:stale.id,pages:2,tombstone_restored:true,reconnected_delivery:true};
    });
    await test('all observed events contain metadata only; C/other-room access denied across controls',async()=>{await sleep(2000);live([cFirst,cAll]);assert.ok(report.events.length>0);for(const e of report.events)assert.deepEqual(e.payload_columns,['created_at','event_seq','event_type','message_id','room_id']);assert.equal(report.events.filter(e=>e.receiver==='C').length,0);assert.equal(report.events.filter(e=>e.receiver==='B'&&e.room_id===secondRoom).length,0);return {observed_receipts:report.events.length,c_receipts:0,b_other_room_receipts:0};});
  } else report.warnings.push('Realtime-dependent cases not run: initial real-JWT subscriptions failed. No policy/config changes attempted.');
  phase='final-audit';
  await test('local data attribution and unchanged Auth object definitions',async()=>{
    const after=await authSnapshot(db);const before={...authBefore};for(const k of ['users','sessions','refresh_tokens']){delete before[k];delete after[k];}assert.deepEqual(after,before);
    const {rows:summary}=await db.query('select room_id::text,count(*)::int as messages,count(*) filter(where deleted_at is not null)::int as deleted from public.messages where room_id=any($1::uuid[]) group by room_id order by room_id',[report.data.rooms]);
    assert.ok(summary.every(r=>report.data.rooms.includes(r.room_id)));report.data.message_counts=summary;
    const {rows:events}=await db.query('select e.room_id::text,e.event_seq::text,e.message_id::text,e.event_type,e.created_at,m.sender_id::text from public.room_message_events e join public.messages m on m.id=e.message_id where e.room_id=any($1::uuid[]) order by e.room_id,e.event_seq',[report.data.rooms]);
    report.database_events=events;
    assert.ok(events.every(e=>Object.values(report.data.users).includes(e.sender_id)));
    return {test_users:Object.keys(report.data.users).length,test_rooms:report.data.rooms.length,attributed_events:events.length};
  });
}catch(error){report.fatal={phase,...safeError(error)};console.log(`STOPPED: ${phase} (${error?.code??'TEST_FAILURE'}); no policy/schema changes attempted.`);}
finally{
  for(const c of clients){try{await c.removeAllChannels();await c.realtime.disconnect();}catch{/* No tokens/errors logged. */}}
  if(child&&child.exitCode===null){await new Promise(resolve=>{child.once('exit',resolve);child.send('stop');setTimeout(()=>{if(child.exitCode===null)child.kill();resolve();},5000).unref();});}
  if(db)await db.end();delete report.auth_before;
  report.finished_at=new Date().toISOString();report.summary={pass:report.tests.filter(t=>t.status==='PASS').length,fail:report.tests.filter(t=>t.status==='FAIL').length,fatal:Boolean(report.fatal),data_retained:true};save();
  fs.writeFileSync(path.join(runtime,'latest-integration.json'),JSON.stringify({run,directory:path.relative(root,output),summary:report.summary},null,2));
  console.log(JSON.stringify({run,summary:report.summary,results:path.relative(root,path.join(output,'results.json'))}));
  if(report.summary.fail||report.summary.fatal)process.exitCode=1;
}
