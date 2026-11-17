// Dedicated disposable DB only. No Auth/Push network calls or existing DB access.
// npx tsx integration/test-notification-db-concurrency.ts
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
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
const json = async (query: string) => JSON.parse(await sql(`select coalesce(json_agg(t), '[]'::json) from (${query}) t`));

async function waitForApplication(name: string, blocked = false) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await sql(`select exists(select 1 from pg_stat_activity where application_name='${name}' ${blocked ? "and wait_event_type='Lock'" : ''})`) === 't') return;
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
      let lockerError = '';
      locker.stderr?.on('data', data => { lockerError += data; });
      const closed = new Promise<void>((resolve, reject) => locker.on('exit', code => code === 0 ? resolve() : reject(new Error(lockerError))));
      locker.stdin!.write(`begin; set idle_in_transaction_session_timeout='20s'; set application_name='review13-lock'; select id from public.profiles where id='${actor}' for update;\n`);
      await waitForApplication('review13-lock');
      const call = operation === 'set' ? `public.set_profile_is_free('${actor}',true,30)` : operation === 'extend' ? `public.extend_profile_is_free('${actor}')` : `public.extend_profile_is_free_from_notification('${actor}',(select id from public.free_end_notification_claims where user_id='${actor}'))`;
      const waiting = sql(`set application_name='review13-wait'; select * from ${call}`).then(value => ({ value, error: '' }), (error: Error) => ({ value: '', error: error.message }));
      try {
        await waitForApplication('review13-wait', true);
        assert.equal(await sql(`select exists(select 1 from pg_stat_activity a, public.profiles p where a.application_name='review13-wait' and p.id='${actor}' and a.xact_start<p.free_until)`), 't', 'waiter must start before expiry');
        await sql('select pg_sleep(3.1)');
      } finally {
        locker.stdin!.end('commit;\n');
        await closed;
      }
      const result = await waiting;
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
