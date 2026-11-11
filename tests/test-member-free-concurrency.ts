// 明示指定した専用ローカルDBでだけ実行。マイグレーション適用・外部送信はしない。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const dbUrl = process.env.MEMBER_FREE_TEST_DB_URL;

test('real PostgreSQL: concurrent ON and independent claim workers', {
  skip: !dbUrl, timeout: process.env.MEMBER_FREE_TEST_DOCKER === '1' ? 120_000 : 30_000,
}, async () => {
  const url = new URL(dbUrl!);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only loopback DB is allowed');
  const database = decodeURIComponent(url.pathname.slice(1));
  assert.match(database, /^imahima_.*test/, 'A dedicated imahima_*test* database is required');
  assert.equal(url.search, '', 'Connection options that could override the local host are not allowed');
  const env: NodeJS.ProcessEnv = { ...process.env };
  // PGHOSTADDR/PGSERVICEなどの継承で別DBへ接続しないよう、接続設定を明示する。
  for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
  Object.assign(env, { PGHOST: url.hostname === '[::1]' ? '::1' : url.hostname,
    PGPORT: url.port || '5432', PGDATABASE: database,
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '5',
    PGOPTIONS: '-c statement_timeout=10000 -c lock_timeout=5000' });
  const children = new Set<ReturnType<typeof spawn>>();
  // ホストにpsqlがない場合も、今回作成した専用コンテナだけで実行できる。
  const dockerMode = process.env.MEMBER_FREE_TEST_DOCKER === '1';
  if (dockerMode) {
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, '55439');
    assert.equal(database, 'imahima_member_free_test');
  }
  function start(sql: string, marker?: string) {
    const args = ['-X', '-w', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
    const child = dockerMode
      ? spawn('docker', ['exec', '-i', 'imahima-member-free-test-db', 'psql',
          '-U', 'supabase_admin', '-d', database,
          ...args], { env, windowsHide: true })
      : spawn('psql', args, { env, windowsHide: true });
    children.add(child);
    let output = '';
    let errors = '';
    let signal!: () => void;
    let failSignal!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { signal = resolve; failSignal = reject; });
    // readyの未参照の場合も未処理rejectにしない。
    void ready.catch(() => {});
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (marker && output.includes(marker)) signal(); });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    const done = new Promise<string>((resolve, reject) => {
      child.on('error', (error) => { failSignal(error); reject(error); });
      child.on('close', (code) => {
        children.delete(child);
        if (code !== 0) {
          const error = new Error(`Local psql failed (${code}): ${errors.slice(0, 500)}`);
          failSignal(error); reject(error);
        } else {
          if (!marker) signal();
          else if (!output.includes(marker)) failSignal(new Error('Synchronization marker missing'));
          resolve(output);
        }
      });
    });
    void done.catch(() => {});
    child.stdin.end(sql);
    return { ready, done };
  }
  const actor = randomUUID(); const recipient = randomUUID(); const room = randomUUID();
  const actorSql = `'${actor}'::uuid`;
  const recipientSql = `'${recipient}'::uuid`;
  const query = async (sql: string) => start(sql).done;
  // 既存outboxがあるDBではテストしない（claimが他のデータを取らないようにする）。
  assert.equal((await query('select count(*) from public.member_free_events;')).trim(), '0', 'Test requires an empty dedicated DB');
  try {
    await query(`
      insert into auth.users (id,email,created_at,updated_at) values
        (${actorSql},'${actor}@example.test',now(),now()), (${recipientSql},'${recipient}@example.test',now(),now());
      select * from public.set_profile_is_free(${recipientSql},true,30);
      insert into public.rooms(id,room_name) values ('${room}','concurrency-test');
      insert into public.room_members(room_id,user_id) values ('${room}',${actorSql}),('${room}',${recipientSql});
    `);
    const a = start(`begin; select * from public.set_profile_is_free(${actorSql},true,30); select 'ON_LOCKED'; select pg_sleep(1); commit;`, 'ON_LOCKED');
    await a.ready;
    const b = start(`select * from public.set_profile_is_free(${actorSql},true,60);`);
    await Promise.all([a.done, b.done]);
    assert.equal((await query(`select count(*) from public.member_free_events where actor_user_id=${actorSql};`)).trim(), '1');
    assert.equal((await query(`select count(*) from public.member_free_notifications where recipient_user_id=${recipientSql};`)).trim(), '1');

    const workerA = start(`begin; select notification_id from public.claim_member_free_notifications(); select 'CLAIM_LOCKED'; select pg_sleep(1); commit;`, 'CLAIM_LOCKED');
    await workerA.ready;
    const workerB = start('select notification_id from public.claim_member_free_notifications();');
    const [first, second] = await Promise.all([workerA.done, workerB.done]);
    const ids = (text: string) => text.split(/\r?\n/).filter((line) => /^[0-9a-f-]{36}$/.test(line));
    assert.equal(ids(first).length, 1); assert.equal(ids(second).length, 0);
  } finally {
    for (const child of children) child.kill();
    await query(`delete from public.rooms where id='${room}'; delete from auth.users where id in (${actorSql},${recipientSql});`);
  }
});
