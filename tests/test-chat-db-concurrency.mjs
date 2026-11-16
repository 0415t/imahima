// Dedicated disposable fixture DB only. Never points at a shared Supabase DB.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const container = 'imahima-chat-db-verification';
const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
assert.equal(info.HostConfig.NetworkMode, 'none');
assert.equal(info.Config.Image, 'postgres:16');
const command = ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'];
function sql(text) { return execFileSync('docker', command, { input: text, encoding: 'utf8' }).trim(); }
function session(text, onOutput = () => {}) {
  const child = spawn('docker', command, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; onOutput(output); });
  child.stderr.on('data', chunk => { error += chunk; });
  child.stdin.end(text);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
  });
}
const [a, b, c, d, e] = Array.from({ length: 5 }, () => randomUUID());
sql(`insert into auth.users(id) values ${[a, b, c, d, e].map(id => `('${id}')`).join(',')};
     insert into public.profiles(id) values ${[a, b, c, d, e].map(id => `('${id}')`).join(',')};`);
function create(actor) {
  return JSON.parse(sql(`select public.group_mvp_execute('create','${actor}','{"name":"Chat concurrency fixture"}');`)).data.group.id;
}
const [r1, r2] = [create(a), create(a)];
sql(`insert into public.room_members(room_id,user_id) values
 ('${r1}','${b}'),('${r2}','${b}'),('${r1}','${c}'),('${r1}','${d}');`);
const send = (actor, room, client = randomUUID()) =>
  `public.chat_send_message('${actor}','${room}','concurrency fixture','${client}')`;
const asService = query => `begin;set local role service_role;select ${query};commit;`;

// Cross-room quota, not one quota per room or API process.
const quota = await Promise.all(Array.from({ length: 11 }, (_, i) => session(asService(send(a, i % 2 ? r1 : r2)))));
const statuses = quota.map(value => JSON.parse(value).status);
assert.equal(statuses.filter(status => status === 201).length, 10);
assert.equal(statuses.filter(status => status === 429).length, 1);

const client = randomUUID();
const duplicate = await Promise.all([session(asService(send(b, r1, client))), session(asService(send(b, r1, client)))]);
assert.deepEqual(duplicate.map(value => JSON.parse(value).status).sort(), [200, 201]);
assert.equal(sql(`select count(*) from public.messages where sender_id='${b}' and client_message_id='${client}';`), '1');

const crossClient = randomUUID();
const crossRoom = await Promise.all([session(asService(send(b, r1, crossClient))), session(asService(send(b, r2, crossClient)))]);
assert.deepEqual(crossRoom.map(value => JSON.parse(value).status).sort(), [201, 409]);

// Different users serialize on the room, while using independent user locks.
const simultaneous = await Promise.all(Array.from({ length: 8 }, (_, i) => session(asService(send(i % 2 ? c : d, r1)))));
assert.ok(simultaneous.every(value => JSON.parse(value).status === 201));
assert.equal(sql(`select count(*)=max(room_seq) and count(*)=count(distinct room_seq) from public.messages where room_id='${r1}';`), 't');

const target = JSON.parse(simultaneous[0]).data.message;
const owner = target.sender.id;
const removes = await Promise.all([0, 1].map(() => session(asService(`public.chat_delete_message('${owner}','${r1}','${target.id}')`))));
assert.ok(removes.every(value => JSON.parse(value).status === 200));
assert.equal(sql(`select count(*) from public.room_message_events where message_id='${target.id}' and event_type='deleted';`), '1');
assert.equal(sql(`select count(*)=max(event_seq) and count(*)=count(distinct event_seq) from public.room_message_events where room_id='${r1}';`), 't');

// Deterministic barrier: leave has modified membership and holds its room lock.
const r3 = create(e);
let release;
const locked = new Promise(resolve => { release = resolve; });
const leaving = session(`begin;set local role service_role;
 select public.group_mvp_execute('leave','${e}','{"room_id":"${r3}"}');
 select 'ROOM_LOCK_HELD';select pg_sleep(1);commit;`, output => {
  if (output.includes('ROOM_LOCK_HELD')) release();
});
await Promise.race([locked, leaving.then(() => { throw new Error('Missing leave barrier'); })]);
const blockedSend = session(asService(send(e, r3)));
await leaving;
assert.equal(JSON.parse(await blockedSend).status, 404);
assert.equal(sql(`select count(*) from public.messages where room_id='${r3}';`), '0');

// Reverse ordering: send holds the room lock until COMMIT, then leave archives it.
const r4 = create(e);
let sendReady;
const sentBarrier = new Promise(resolve => { sendReady = resolve; });
const sending = session(`begin;set local role service_role;select ${send(e, r4)};
 select 'SEND_LOCK_HELD';select pg_sleep(1);commit;`, output => {
  if (output.includes('SEND_LOCK_HELD')) sendReady();
});
await Promise.race([sentBarrier, sending.then(() => { throw new Error('Missing send barrier'); })]);
const blockedLeave = session(asService(`public.group_mvp_execute('leave','${e}','{"room_id":"${r4}"}')`));
await sending;
assert.equal(JSON.parse(await blockedLeave).status, 204);
assert.equal(sql(`select mvp_archived_at is not null from public.rooms where id='${r4}';`), 't');
assert.equal(sql(`select count(*) from public.messages where room_id='${r4}';`), '1');

console.log('PASS: 11 concurrent sends across rooms = 10 successes / 1 rate limit');
console.log('PASS: simultaneous replay, cross-room conflict, room/event numbering, duplicate delete');
console.log('PASS: leave-before-send rejected; send-before-leave retained and room archived');
console.log('Synthetic rows remain only inside this disposable container; destroy it after verification.');
