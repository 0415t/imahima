// Dedicated disposable DB only. No Auth/Push network calls or existing DB access.
// npx tsx integration/test-notification-db-concurrency.ts
// --fault=delay-lock must pass; --fault=readiness-timeout|session-exit must fail.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFreeEndNotificationPoller } from '../server/jobs/free-end-notifications';

const container = 'imahima-pr24-review13-db';
const metadata = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
assert.equal(metadata.HostConfig.NetworkMode, 'none');
assert.ok(Object.hasOwn(metadata.HostConfig.Tmpfs, '/var/lib/postgresql/data'));
assert.equal(Object.keys(metadata.HostConfig.PortBindings ?? {}).length, 0);
const run = promisify(execFile);
const sql = async (query: string) => (await run('docker', ['exec', '-e', 'PGOPTIONS=-c statement_timeout=15000', container, 'psql', '-X', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', query], { timeout: 30_000 })).stdout.trim();
const actor = 'a8131111-1111-4111-8111-111111111111';
// delay-lock is a positive regression; the other modes must fail and clean up.
const fault = process.argv[2]?.replace(/^--fault=/, '');
assert.ok(!fault || ['delay-lock', 'readiness-timeout', 'session-exit'].includes(fault));
const json = async (query: string) => JSON.parse(await sql(`select coalesce(json_agg(t), '[]'::json) from (${query}) t`));

async function waitForApplication(name: string, blocked = false,
  ready?: { pid: number; query: string; hasExited: () => boolean }) {
  const attempts = fault === 'readiness-timeout' ? 3 : 100;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (ready?.hasExited()) throw new Error(`locking session exited before readiness: ${name}`);
    const readiness = ready ? `and pid=${ready.pid} and state='idle in transaction' and btrim(query)='${ready.query.replaceAll("'", "''")}'` : '';
    if (await sql(`select exists(select 1 from pg_stat_activity where application_name='${name}' ${blocked ? "and wait_event_type='Lock'" : ''} ${readiness})`) === 't') return;
    await sleep(20);
  }
  throw new Error(`session did not reach expected state: ${name}`);
}

async function main() {
  const failures: string[] = [];
  try {
    await sql(`insert into auth.users(id) values ('${actor}')`);
    for (const operation of ['set', 'extend', 'notification'] as const) {
      await sql(`delete from public.free_end_notification_claims where user_id='${actor}'; update public.profiles set is_free=true, free_until=clock_timestamp()+interval '3 seconds' where id='${actor}'; insert into public.free_end_notification_claims(user_id,free_until,status) select id,free_until,'sent' from public.profiles where id='${actor}'`);
      // Keep a real row lock open; control release only after observing the waiter blocked.
      const locker = execFile('docker', ['exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { encoding: 'utf8' });
      const lockerName = `timer-lock-${randomUUID()}`;
      const waiterName = `timer-wait-${randomUUID()}`;
      const lockQuery = `select id from public.profiles where id='${actor}' for update;`;
      let lockerError = '';
      let exited = false;
      locker.stderr?.on('data', data => { lockerError += data; });
      locker.stdin!.on('error', error => { lockerError += String(error); });
      const closed = new Promise<number | null>(resolve => {
        locker.once('exit', code => { exited = true; resolve(code); });
        locker.once('error', error => { exited = true; lockerError += String(error); resolve(-1); });
      });
      const identity = Promise.withResolvers<number>();
      let output = '';
      locker.stdout?.on('data', data => {
        output += data;
        const match = output.match(/LOCK_PID:(\d+)/);
        if (match) identity.resolve(Number(match[1]));
      });
      let waiting: Promise<{ value: string; error: string }> | undefined;
      try {
        locker.stdin!.write(`begin; set idle_in_transaction_session_timeout='20s'; set application_name='${lockerName}'; select 'LOCK_PID:' || pg_backend_pid();\n`);
        const pid = await Promise.race([identity.promise, closed.then(() => { throw new Error(`locking session exited: ${lockerError}`); })]);
        if (fault === 'session-exit') locker.stdin!.end('\\q\n');
        else if (fault !== 'readiness-timeout') locker.stdin!.write(`${fault === 'delay-lock' ? 'select pg_sleep(1); ' : ''}${lockQuery}\n`);
        await waitForApplication(lockerName, false, { pid, query: lockQuery, hasExited: () => exited });
        const call = operation === 'set' ? `public.set_profile_is_free('${actor}',true,30)` : operation === 'extend' ? `public.extend_profile_is_free('${actor}')` : `public.extend_profile_is_free_from_notification('${actor}',(select id from public.free_end_notification_claims where user_id='${actor}'))`;
        waiting = sql(`set application_name='${waiterName}'; select * from ${call}`).then(value => ({ value, error: '' }), (error: Error) => ({ value: '', error: error.message }));
        await waitForApplication(waiterName, true);
        assert.equal(await sql(`select exists(select 1 from pg_stat_activity a, public.profiles p where a.application_name='${waiterName}' and p.id='${actor}' and a.xact_start<p.free_until and ${pid}=any(pg_blocking_pids(a.pid)))`), 't', 'waiter must start before expiry and be blocked by this locker');
        await sql('select pg_sleep(3.1)');
      } finally {
        if (!exited && !locker.stdin!.writableEnded) locker.stdin!.end('rollback;\n');
        const code = await closed;
        await waiting;
        if (code !== 0) throw new Error(`locking session failed (${code}): ${lockerError}`);
      }
      const result = await waiting!;
      try {
        if (operation === 'set') {
          assert.equal(result.error, '');
          assert.equal(await sql(`select free_until between clock_timestamp()+interval '29 minutes 55 seconds' and clock_timestamp()+interval '30 minutes' from public.profiles where id='${actor}'`), 't', 'expired timer must restart after the lock');
        } else {
          assert.match(result.error, /Cannot extend: not in an active timed free state/);
        }
        console.log(`PASS: post-lock clock (${operation})`);
      } catch (error) {
        failures.push(`${operation}: ${String(error)}`);
        console.error(`FAIL: post-lock clock (${operation})`);
      }
    }

    await sql(`delete from public.free_end_notification_claims where user_id='${actor}'; update public.profiles set is_free=true, free_until=clock_timestamp()+interval '4 minutes' where id='${actor}'`);
    // Both pollers invoke the actual DB RPC through separate psql sessions.
    let claims = 0;
    let sends = 0;
    const dependencies = () => ({
      claimNotifications: async () => {
        claims++;
        const rows = await json('select * from public.claim_free_end_notifications()');
        return { claims: rows.map((row: Record<string, unknown>) => ({ claimId: String(row.claim_id), userId: String(row.user_id), freeUntil: String(row.free_until), attempts: Number(row.attempts), leaseToken: String(row.lease_token), leaseExpiresAt: String(row.lease_expires_at) })), error: null };
      },
      validateNotification: async (id: string, lease: string) => {
        const rows = await json(`select * from public.validate_free_end_notification('${id}','${lease}')`);
        return { validation: rows[0] ? { owned: rows[0].owned, stillValid: rows[0].still_valid } : null, error: null };
      },
      getDeviceTokens: async () => ({ tokens: ['ExponentPushToken[isolated]'], error: null }),
      sendPushNotifications: async () => { sends++; return { sent: 1, error: null }; },
      completeNotification: async (id: string, lease: string, status: string) => ({ completed: await sql(`select public.complete_free_end_notification('${id}','${lease}','${status}')`) === 't', error: null }),
    });
    await Promise.all([createFreeEndNotificationPoller(dependencies()).runOnce(), createFreeEndNotificationPoller(dependencies()).runOnce()]);
    assert.equal(claims, 2, 'both independent pollers must reach the DB');
    assert.equal(sends, 1);
    assert.equal(await sql(`select count(*)=1 and bool_and(status='sent') from public.free_end_notification_claims where user_id='${actor}'`), 't');
    console.log('PASS: two independent pollers, two real DB claim calls, one acceptance');
    assert.deepEqual(failures, []);
  } finally {
    await sql(`delete from auth.users where id='${actor}'`);
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
