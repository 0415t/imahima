// Dedicated disposable fixture DB only. Never points at a shared Supabase DB.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { waitForBarrier, waitForBlockedRpc } from '../verification/group-chat-local/barriers.mjs';

const container = 'imahima-chat-db-verification';
const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
assert.equal(info.HostConfig.NetworkMode, 'none');
assert.equal(info.Config.Image, 'postgres:16');
const command = ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'];
function sql(text) { return execFileSync('docker', command, { input: text, encoding: 'utf8' }).trim(); }
function openSession(text, onOutput = () => {}, held = false) {
  const child = spawn('docker', command, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; onOutput(output); });
  child.stderr.on('data', chunk => { error += chunk; });
  child.stdin.on('error', () => {});
  if (held) child.stdin.write(text); else child.stdin.end(text);
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
  });
  return { done, commit: () => child.stdin.end('commit;\n'),
    cancel: () => { if (!child.stdin.writableEnded) child.stdin.end('rollback;\n'); } };
}
const session = (text, onOutput) => openSession(text, onOutput).done;
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

// Hold each transaction on stdin until its named competitor is observed waiting.
async function serialization(firstSql, competingSql, rpc) {
  const holderName = 'chat-holder-' + randomUUID();
  const competitorName = 'chat-competitor-' + randomUUID();
  let signal;
  const ready = new Promise(resolve => { signal = resolve; });
  const holder = openSession(`set application_name='${holderName}';begin;set local role service_role;
    select ${firstSql};select 'ROOM_LOCK_HELD';\n`, output => {
    if (output.includes('ROOM_LOCK_HELD')) signal();
  }, true);
  let competitor;
  try {
    await waitForBarrier(ready, holder.done, 'holder room lock');
    competitor = openSession(`set application_name='${competitorName}';${asService(competingSql)}`);
    const holderPid = Number(sql(`select pid from pg_stat_activity where application_name='${holderName}';`));
    assert.ok(holderPid > 0);
    // psql adapter lets the same barrier used by Auth/API harnesses run against
    // a real DB without exposing this fixture container's network.
    const observer = { query: async (query, values) => {
      const statement = query.replace(/\$(\d+)/g, (_match, n) => `'${String(values[Number(n) - 1]).replaceAll("'", "''")}'`);
      return { rows: [JSON.parse(sql(`select row_to_json(t) from (${statement}) t;`))] };
    } };
    await waitForBlockedRpc(observer, holderPid, rpc, competitor.done);
    assert.equal(sql(`select exists(select 1 from pg_stat_activity c join pg_stat_activity h
      on h.pid=any(pg_blocking_pids(c.pid)) where c.application_name='${competitorName}'
      and h.application_name='${holderName}' and c.wait_event_type='Lock');`), 't');
    holder.commit(); await holder.done;
    return await competitor.done;
  } finally {
    holder.cancel(); await holder.done.catch(() => {});
    await competitor?.done.catch(() => {});
  }
}
const r3 = create(e);
const blockedSend = await serialization(`public.group_mvp_execute('leave','${e}','{"room_id":"${r3}"}')`, send(e, r3), 'chat_send_message');
assert.equal(JSON.parse(blockedSend).status, 404);
assert.equal(sql(`select count(*) from public.messages where room_id='${r3}';`), '0');

const r4 = create(e);
const blockedLeave = await serialization(send(e, r4), `public.group_mvp_execute('leave','${e}','{"room_id":"${r4}"}')`, 'group_mvp_execute');
assert.equal(JSON.parse(blockedLeave).status, 204);
assert.equal(sql(`select mvp_archived_at is not null from public.rooms where id='${r4}';`), 't');
assert.equal(sql(`select count(*) from public.messages where room_id='${r4}';`), '1');

console.log('PASS: 11 concurrent sends across rooms = 10 successes / 1 rate limit');
console.log('PASS: simultaneous replay, cross-room conflict, room/event numbering, duplicate delete');
console.log('PASS: leave-before-send rejected; send-before-leave retained and room archived');
console.log('Synthetic rows remain only inside this disposable container; destroy it after verification.');
