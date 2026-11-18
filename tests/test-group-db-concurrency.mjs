// Dedicated disposable postgres:16 container only; apply README fixture/migration first.
// --fault=no-wait|early-release|timeout|node-timeout|observation-timeout|sql-error|session-exit:
// negative checks, must fail (and must not print PASS).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const container = 'imahima-group-mvp-verification';
const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8', timeout: 5000 }))[0];
assert.equal(info.HostConfig.NetworkMode, 'none', 'Refuse a network-connected DB');
assert.equal(info.Config.Image, 'postgres:16', 'Refuse an unexpected test image');
assert.ok(!info.HostConfig.Binds?.length, 'Refuse host bind mounts');
assert.ok(info.Mounts.every(m => m.Type === 'tmpfs'), 'Refuse persistent DB storage');
assert.equal(Object.keys(info.HostConfig.PortBindings ?? {}).length, 0, 'Refuse published ports');
const fault = process.argv[2]?.replace(/^--fault=/, '');
assert.ok(process.argv.length <= 3 && (!fault || ['no-wait', 'early-release', 'timeout', 'node-timeout', 'observation-timeout', 'sql-error', 'session-exit'].includes(fault)), 'Unknown fault option');
// Leave enough room for labels within PostgreSQL's 63-byte application_name limit.
const run = `gr-${randomUUID().replaceAll('-', '')}`;
const command = ['psql', '-X', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'];
const sessions = [], rooms = [];
const a = randomUUID(), b = randomUUID();
const rateKey = createHash('sha256').update(run).digest('hex');
let observerSequence = 0;
let interrupted;
const interrupt = signal => {
  interrupted ??= new Error(`Interrupted: ${signal}`);
  for (const session of sessions) session.fail(interrupted);
};
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);

function sql(statement) {
  return execFileSync('docker', ['exec', '-i', '-e', `PGAPPNAME=${run}-observer-${++observerSequence}`, '-e',
    'PGOPTIONS=-c statement_timeout=4000 -c lock_timeout=2000', container, ...command], {
    input: statement, encoding: 'utf8', timeout: 6000, maxBuffer: 1024 * 1024,
  }).trim();
}

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

class Session {
  constructor(label) {
    this.name = `${run}-${label}-${sessions.length}`;
    this.buffer = ''; this.errors = ''; this.sequence = 0; this.closed = false;
    this.child = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${this.name}`, '-e',
      'PGOPTIONS=-c statement_timeout=20000 -c lock_timeout=15000 -c idle_in_transaction_session_timeout=30000',
      container, ...command], { stdio: ['pipe', 'pipe', 'pipe'] });
    sessions.push(this);
    this.done = new Promise(resolve => this.child.once('close', code => {
      this.closed = true;
      this.fail(new Error(`${this.name} closed (${code}): ${this.errors}`));
      resolve();
    }));
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stderr.on('data', data => { this.errors = (this.errors + data).slice(-8192); });
    this.child.stdout.on('data', data => {
      this.buffer += data;
      let end;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end).replace(/\r$/, '');
        this.buffer = this.buffer.slice(end + 1);
        if (!this.pending) continue;
        if (line === this.pending.marker) {
          const pending = this.pending;
          clearTimeout(pending.timer); this.pending = null;
          pending.resolve(pending.lines.join('\n').trim());
        } else this.pending.lines.push(line);
      }
    });
  }
  fail(error) {
    this.failure ??= error;
    if (this.pending) {
      clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null;
    }
  }
  query(statement, timeoutMs = 25000) {
    if (this.failure || this.closed) return Promise.reject(this.failure ?? new Error('Session closed'));
    assert.ok(!this.pending, 'Only one outstanding query per session');
    const marker = `DONE_${++this.sequence}_${run}`;
    const result = new Promise((resolve, reject) => {
      this.pending = { marker, resolve, reject, lines: [], timer: setTimeout(() => {
        this.fail(new Error(`Node query timeout: ${this.name}`));
      }, timeoutMs) };
      this.child.stdin.write(`${statement}\n\\echo ${marker}\n`);
    });
    // Another session/observer may be awaited when this query fails.
    result.catch(() => {});
    return result;
  }
  async identify() {
    this.pid = Number(await this.query('select pg_backend_pid();'));
    assert.ok(Number.isInteger(this.pid) && this.pid > 0, 'Missing backend PID');
    return this;
  }
  finish() {
    // Closing is independent of query failure and may be requested more than once.
    this.finishing ??= (async () => {
      let failure;
      try {
        if (!this.closed && !this.failure) await this.query('rollback;');
      } catch (error) { failure = error; }
      finally {
        if (!this.closed && !this.child.stdin.destroyed && !this.child.stdin.writableEnded) {
          this.child.stdin.end('\\q\n');
        }
      }
      await bounded(this.done, 5000, `Session exit: ${this.name}`);
      if (failure) throw failure;
    })();
    return this.finishing;
  }
}

async function observeWait(leader, follower, label, deadlineMs = 8000) {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    if (interrupted) throw interrupted;
    if (leader.failure) throw leader.failure;
    if (follower.failure) throw follower.failure;
    if (!follower.pending) throw new Error(`${label}: follower completed without observed contention`);
    const observed = JSON.parse(sql(`select json_build_object(
      'leader_pid', l.pid, 'leader_application', l.application_name,
      'leader_state', l.state, 'leader_xact_start', l.xact_start,
      'follower_pid', f.pid, 'follower_application', f.application_name,
      'follower_state', f.state, 'wait_event_type', f.wait_event_type,
      'wait_event', f.wait_event, 'blockers', pg_blocking_pids(f.pid))
      from pg_stat_activity l cross join pg_stat_activity f
      where l.pid=${leader.pid} and l.application_name='${leader.name}'
        and f.pid=${follower.pid} and f.application_name='${follower.name}';`) || 'null');
    if (observed?.leader_state === 'idle in transaction' && observed.leader_xact_start &&
        observed.follower_state === 'active' && observed.wait_event_type === 'Lock' &&
        observed.blockers.includes(leader.pid)) {
      console.log(JSON.stringify({ event: 'contention', scenario: label, ...observed }));
      return;
    }
    await delay(50);
  }
  throw new Error(`${label}: lock observation timeout; contention not established`);
}

const invoke = (op, actor, args = {}) => `public.group_mvp_execute('${op}','${actor}','${JSON.stringify(args)}'::jsonb)`;
async function pair(label, first, second, inject = false) {
  const leader = await new Session(`${label}-leader`).identify();
  const follower = await new Session(`${label}-follower`).identify();
  const leadingResult = await leader.query(`begin; select ${first};`);
  const mode = inject ? fault : undefined;
  if (mode === 'early-release') await leader.query('commit;'); // Deliberate negative test only.
  if (mode === 'session-exit') {
    sql(`select pg_terminate_backend(pid) from pg_stat_activity where pid=${leader.pid} and application_name='${leader.name}';`);
  }
  const trailingResult = follower.query(mode === 'no-wait' ? 'select 1;' : mode === 'timeout'
    ? "set statement_timeout='200ms'; select pg_sleep(30);" : mode === 'sql-error'
      ? 'select 1/0;' : ['node-timeout', 'observation-timeout'].includes(mode)
        ? 'select pg_sleep(30);' : `select ${second};`, mode === 'node-timeout' ? 200 : 25000);
  await observeWait(leader, follower, label, mode === 'observation-timeout' ? 200 : 8000);
  // Only a positive database observation permits the normal commit.
  assert.ok(!mode, 'Injected fault unexpectedly established contention');
  await leader.query('commit;');
  const result = await trailingResult;
  await leader.finish(); await follower.finish();
  return [leadingResult, result];
}

async function cleanup() {
  // Every cancellation/termination is scoped to this run, never all postgres sessions.
  const owned = `application_name like '${run}-%' and pid <> pg_backend_pid()`;
  const errors = [];
  try { sql(`select pg_cancel_backend(pid) from pg_stat_activity where ${owned} and state='active';`); }
  catch (error) { errors.push(error); }
  // Stop outstanding jobs before closing their input; rejecting a query is not cancellation.
  for (const session of sessions) {
    if (session.pending) session.fail(new Error('Session stopped for cleanup'));
  }
  const exits = await Promise.allSettled(sessions.filter(item => !item.closed).map(session => session.finish()));
  for (const exit of exits) if (exit.status === 'rejected') errors.push(exit.reason);
  try { sql(`select pg_terminate_backend(pid) from pg_stat_activity where ${owned};`); }
  catch (error) { errors.push(error); }
  // A terminated backend does not imply that docker/psql has closed its input or exited.
  for (const session of sessions.filter(item => !item.closed)) {
    session.child.stdin.destroy(); session.child.kill();
  }
  let safeToDelete = false;
  try {
    await bounded(Promise.all(sessions.map(session => session.done)), 5000, 'All session exits');
    assert.equal(sql(`select count(*) from pg_stat_activity where ${owned};`), '0', 'Test backends remain');
    safeToDelete = true;
  } catch (error) { errors.push(error); }
  // Recovered exit errors still fail the test, but do not prevent safe data cleanup.
  if (safeToDelete) {
    try {
      sql(`begin;
        ${rooms.map(id => `delete from public.rooms where id='${id}';`).join('\n')}
        delete from public.rooms where mvp_created_by in ('${a}','${b}');
        delete from public.profiles where id in ('${a}','${b}');
        delete from auth.users where id in ('${a}','${b}');
        delete from public.group_mvp_rate_limits where key_hash='${rateKey}';
        commit;`);
      assert.equal(sql(`select
        (select count(*) from auth.users where id in ('${a}','${b}')) +
        (select count(*) from public.profiles where id in ('${a}','${b}')) +
        (select count(*) from public.rooms where mvp_created_by in ('${a}','${b}')) +
        (select count(*) from public.room_members where user_id in ('${a}','${b}')) +
        (select count(*) from public.group_mvp_rate_limits where key_hash='${rateKey}');`), '0', 'Test data remains');
      console.log(JSON.stringify({ event: 'cleanup', run, sessions: 'zero', test_data: 'zero' }));
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Cleanup failed');
}

let failure;
try {
  sql(`insert into auth.users values ('${a}'),('${b}'); insert into public.profiles(id,is_free) values ('${a}',false),('${b}',false);`);
  let result = JSON.parse(sql(`select ${invoke('create', a, { name: 'Race test' })};`));
  assert.equal(result.status, 201);
  let id = result.data.group.id; rooms.push(id);
  const code = result.data.invite_code;
  const [left, joined] = await pair('leave-join', invoke('leave', a, { room_id: id }), invoke('join', b, { invite_code: code }), true);
  assert.equal(JSON.parse(left).status, 204);
  assert.equal(JSON.parse(joined).status, 400, 'Join must not revive an archived room');
  assert.equal(sql(`select mvp_archived_at is not null from public.rooms where id='${id}';`), 't');
  assert.equal(sql(`select count(*) from public.room_members where room_id='${id}';`), '0');

  result = JSON.parse(sql(`select ${invoke('create', a, { name: 'Two departures' })};`));
  assert.equal(result.status, 201);
  id = result.data.group.id; rooms.push(id);
  assert.equal(JSON.parse(sql(`select ${invoke('join', b, { invite_code: result.data.invite_code })};`)).status, 201);
  const departures = await pair('two-departures', invoke('leave', a, { room_id: id }), invoke('leave', b, { room_id: id }));
  assert.ok(departures.every(value => JSON.parse(value).status === 204));
  assert.equal(sql(`select mvp_archived_at is not null from public.rooms where id='${id}';`), 't');
  assert.equal(sql(`select count(*) from public.room_members where room_id='${id}';`), '0');

  const quotaCall = `public.group_mvp_consume_rate('${rateKey}',5)`;
  const quotas = await pair('rate-limit', quotaCall, quotaCall);
  const remaining = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const session = await new Session(`quota-${index}`).identify();
    const value = await session.query(`select ${quotaCall};`);
    await session.finish();
    return value;
  }));
  quotas.push(...remaining);
  assert.equal(quotas.filter(value => value === 't').length, 5, 'Concurrent quota overrun');
  assert.equal(sql(`select attempts from public.group_mvp_rate_limits where key_hash='${rateKey}';`), '6');
} catch (error) { failure = error; }
finally {
  try { await cleanup(); }
  catch (error) { failure = failure ? new AggregateError([failure, error], 'Test and cleanup failed') : error; }
  process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
}
if (failure || interrupted) {
  throw failure ?? interrupted;
}
console.log('PASS: leave/join, two departures, rate limit (one observed pair; remaining eight attempts not proven concurrent)');
