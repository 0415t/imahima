// Explicit isolated-fixture mode only. No Supabase, Auth service or Push calls.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { createApp } from '../server/app.ts';
import { chatService } from '../server/services/chat.ts';
import { disabledTimerDependencies } from './helpers/chat-availability.ts';
import { waitForBarrier, waitForBlockedRpc } from '../verification/group-chat-local/barriers.mjs';
import { assertRpcLockTimeout } from '../verification/group-chat-local/timeout-evidence.mjs';

it('HTTP send reaches a real PostgreSQL room lock and expires in the RPC stage', { skip: process.env.CHAT_ISOLATED_DB !== '1', timeout: 30000 }, async () => {
  const container = 'imahima-chat-db-verification';
  const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
  assert.equal(info.Config.Labels['imahima.task'], 'pr26-review-round3');
  assert.equal(info.HostConfig.NetworkMode, 'none'); assert.equal(info.Config.Image, 'postgres:16');
  assert.ok(!info.HostConfig.PortBindings || !Object.keys(info.HostConfig.PortBindings).length);
  assert.ok(Object.hasOwn(info.HostConfig.Tmpfs, '/var/lib/postgresql/data'));
  const command = ['exec', '-i', container, 'psql', '-U', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate'];
  const sql = input => execFileSync('docker', command, { input, encoding: 'utf8' }).trim();
  const literal = value => `'${String(value).replaceAll("'", "''")}'`;
  const user = randomUUID();
  sql(`insert into auth.users(id) values('${user}');insert into public.profiles(id) values('${user}');`);
  const room = JSON.parse(sql(`select public.group_mvp_execute('create','${user}','{"name":"Lock timeout fixture"}');`)).data.group.id;
  const upstream = [], requestId = 'isolated-send';
  const rpc = async (name, args) => {
    assert.equal(name, 'chat_send_message');
    const row = { request_id: requestId, stage: 'rpc', operation: name }; upstream.push(row);
    const started = performance.now();
    const query = `begin;set local role service_role;select public.chat_send_message(${[args.p_actor, args.p_room_id, args.p_body, args.p_client_message_id].map(literal).join(',')});commit;`;
    const child = spawn('docker', command, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
    child.stdin.on('error', () => {}); child.stdin.end(query);
    try {
      await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error('RPC failed'))); });
      row.http_status = 200; return { data: JSON.parse(output.trim()), error: null };
    } catch {
      row.http_status = 500; row.db_error_code = error.includes('55P03') ? '55P03' : 'unexpected';
      return { data: null, error: { code: row.db_error_code } };
    } finally { row.elapsed_ms = Math.round(performance.now() - started); }
  };
  const identity = {
    getUserId: async () => { upstream.push({ request_id: requestId, stage: 'auth', http_status: 200 }); return { userId: user, error: null }; },
    isMember: async () => {
      const member = sql(`select exists(select 1 from public.room_members where room_id='${room}' and user_id='${user}');`) === 't';
      upstream.push({ request_id: requestId, stage: 'membership', http_status: member ? 200 : 404 }); return member;
    },
  };
  const holderName = 'review-lock-' + randomUUID();
  const holder = spawn('docker', command, { stdio: ['pipe', 'pipe', 'pipe'] });
  let signal, output = '';
  const held = new Promise(resolve => { signal = resolve; });
  holder.stdout.on('data', data => { output += data; if (output.includes('LOCK_HELD')) signal(); });
  holder.stderr.resume(); holder.stdin.on('error', () => {});
  const holding = new Promise((resolve, reject) => { holder.once('error', reject); holder.once('close', code => code === 0 ? resolve() : reject(Error('Holder failed'))); });
  holder.stdin.write(`set application_name='${holderName}';begin;select id from public.rooms where id='${room}' for update;select 'LOCK_HELD';\n`);
  let server;
  try {
    await waitForBarrier(held, holding, 'room lock held');
    const pid = Number(sql(`select pid from pg_stat_activity where application_name='${holderName}';`)); assert.ok(pid > 0);
    server = createServer(createApp({ ...disabledTimerDependencies, getUserId: identity.getUserId, toggleIsFree: async () => { throw Error('Disabled'); } }, undefined, undefined, chatService({ rpc }, identity)));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const first = fetch(`http://127.0.0.1:${server.address().port}/groups/${room}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'lock timeout', client_message_id: randomUUID() }), signal: AbortSignal.timeout(12000),
    });
    const observer = { query: async (query, args) => {
      const statement = query.replace(/\$(\d+)/g, (_, n) => literal(args[Number(n) - 1]));
      return { rows: [JSON.parse(sql(`select row_to_json(t) from (${statement}) t;`))] };
    } };
    await waitForBlockedRpc(observer, pid, 'chat_send_message', first);
    const response = await first;
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'CHAT_UNAVAILABLE');
    assertRpcLockTimeout(upstream, requestId);
    assert.equal(sql(`select count(*) from public.messages where room_id='${room}';`), '0');
  } finally {
    holder.stdin.end('rollback;\n'); await holding.catch(() => {});
    if (server) { server.close(); server.closeAllConnections(); await once(server, 'close'); }
  }
});
