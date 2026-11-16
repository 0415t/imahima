// Run only after the README fixture/migration in the dedicated disposable container.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

const container = 'imahima-group-mvp-verification';
const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
assert.equal(info.HostConfig.NetworkMode, 'none', 'Refuse a network-connected DB');
assert.equal(info.Config.Image, 'postgres:16', 'Refuse an unexpected test image');
const command = ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'];
function sql(statement) {
  return execFileSync('docker', command, { input: statement, encoding: 'utf8' }).trim();
}
function session(statement, onOutput = () => {}) {
  const child = spawn('docker', command, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; onOutput(output); });
  child.stderr.on('data', data => { errors += data; });
  child.stdin.end(statement);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
  });
}
const a = '44444444-4444-4444-8444-444444444444';
const b = '55555555-5555-4555-8555-555555555555';
const invoke = (op, actor, args = {}) => `public.group_mvp_execute('${op}','${actor}','${JSON.stringify(args)}'::jsonb)`;
const rooms = [];
try {
  sql(`insert into auth.users values ('${a}'),('${b}'); insert into public.profiles(id,is_free) values ('${a}',false),('${b}',false);`);
  let result = JSON.parse(sql(`select ${invoke('create', a, { name: 'Race test' })};`));
  let id = result.data.group.id;
  rooms.push(id);
  const code = result.data.invite_code;
  let unlock;
  const locked = new Promise(resolve => { unlock = resolve; });
  const leaving = session(`begin; select ${invoke('leave', a, { room_id: id })}; select 'LOCK_HELD'; select pg_sleep(1); commit;`, output => {
    if (output.includes('LOCK_HELD')) unlock();
  });
  // If the first SQL session fails, propagate it instead of waiting indefinitely.
  await Promise.race([locked, leaving.then(() => { throw new Error('Missing lock marker'); })]);
  const joining = session(`select ${invoke('join', b, { invite_code: code })};`);
  await leaving;
  assert.equal(JSON.parse(await joining).status, 400, 'Join must not revive an archived room');

  result = JSON.parse(sql(`select ${invoke('create', a, { name: 'Two departures' })};`));
  id = result.data.group.id; rooms.push(id);
  sql(`select ${invoke('join', b, { invite_code: result.data.invite_code })};`);
  const departures = await Promise.all([a, b].map(actor => session(`select ${invoke('leave', actor, { room_id: id })};`)));
  assert.ok(departures.every(value => JSON.parse(value).status === 204));
  assert.equal(sql(`select mvp_archived_at is not null from public.rooms where id='${id}';`), 't');
  assert.equal(sql(`select count(*) from public.room_members where room_id='${id}';`), '0');

  const rateKey = 'b'.repeat(64);
  const quotas = await Promise.all(Array.from({ length: 10 }, () => session(`select public.group_mvp_consume_rate('${rateKey}',5);`)));
  assert.equal(quotas.filter(value => value === 't').length, 5, 'Concurrent quota overrun');
  console.log('PASS: leave/join race, simultaneous departures, shared quota concurrency');
} finally {
  // Only our test records in the dedicated network-isolated container.
  for (const id of rooms) sql(`delete from public.rooms where id='${id}';`);
  sql(`delete from public.profiles where id in ('${a}','${b}'); delete from auth.users where id in ('${a}','${b}'); delete from public.group_mvp_rate_limits where key_hash=repeat('b',64);`);
}
