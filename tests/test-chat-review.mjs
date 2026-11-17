import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dockerSocket } from '../verification/group-chat-local/docker-endpoint.mjs';
import { waitForBarrier, waitForBlockedRpc } from '../verification/group-chat-local/barriers.mjs';
import { fileFingerprint, completeHistory } from '../verification/group-chat-local/diagnostic-utils.mjs';
import { restrictSecrets, stopDedicated } from '../verification/group-chat-local/stack-safety.mjs';

it('startup failure stops only fully verified dedicated targets and preserves volumes', () => {
  const root = path.resolve('fixture'), project = 'dedicated', network = 'isolated';
  const container = () => ({ Config: { Labels: { 'com.supabase.cli.project': project, 'com.supabase.cli.workdir': root } }, NetworkSettings: { Networks: { [network]: {} } } });
  let containers = [container(), container()], calls = [];
  const execute = (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'ps') return 'first\nsecond\n';
    if (args[0] === 'inspect') return JSON.stringify(containers);
    assert.deepEqual(args, ['stop', 'first', 'second']); return '';
  };
  stopDedicated(root, project, network, execute);
  assert.deepEqual(calls.at(-1), ['stop', 'first', 'second']);
  for (const mutate of [c => { c.Config.Labels['com.supabase.cli.workdir'] = path.resolve('other'); },
    c => { c.Config.Labels['com.supabase.cli.project'] = 'other'; }, c => { c.NetworkSettings.Networks = { shared: {} }; }]) {
    containers = [container(), container()]; mutate(containers[1]); calls = [];
    assert.throws(() => stopDedicated(root, project, network, execute));
    assert.ok(!calls.some(args => args[0] === 'stop'));
  }
});

it('existing private artifacts retain their bytes while permissions are restricted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-review-private-'));
  try {
    restrictSecrets(dir);
    const runtime = path.join(dir, '.runtime'), names = ['signing_keys.json', 'local-status.credentials.json'];
    for (const name of names) fs.writeFileSync(path.join(runtime, name), 'retained fixture', { mode: 0o644 });
    fs.chmodSync(runtime, 0o755); restrictSecrets(dir);
    for (const name of names) assert.equal(fs.readFileSync(path.join(runtime, name), 'utf8'), 'retained fixture');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
      for (const name of names) assert.equal(fs.statSync(path.join(runtime, name)).mode & 0o777, 0o600);
    }
  } finally { fs.rmSync(dir, { recursive: true }); }
});

it('Docker endpoint matches CLI context/host precedence and rejects remote transports', () => {
  const calls = [];
  const execute = (_cmd, args) => {
    calls.push(args);
    return args[1] === 'show' ? 'desktop-linux\n' : JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///custom/docker.sock' } } }]);
  };
  assert.equal(dockerSocket({}, execute), '/custom/docker.sock');
  assert.deepEqual(calls, [['context', 'show'], ['context', 'inspect', 'desktop-linux']]);
  calls.length = 0;
  assert.equal(dockerSocket({ DOCKER_HOST: 'unix:///override.sock' }, execute), '/override.sock');
  assert.equal(calls.length, 0);
  assert.equal(dockerSocket({ DOCKER_HOST: 'tcp://remote:2375', DOCKER_CONTEXT: 'explicit' }, execute), '/custom/docker.sock');
  assert.deepEqual(calls, [['context', 'inspect', 'explicit']]);
  assert.equal(dockerSocket({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' }), '\\\\.\\pipe\\docker_engine');
  for (const host of ['tcp://remote:2375', 'ssh://remote']) assert.throws(() => dockerSocket({ DOCKER_HOST: host }), /unsupported/);
});

it('barriers fail on early response, rejection and deadline, and accept readiness', async () => {
  const never = new Promise(() => {});
  await waitForBarrier(Promise.resolve(), never, 'ready');
  await assert.rejects(waitForBarrier(never, Promise.resolve(), 'early'), /completed before barrier/);
  await assert.rejects(waitForBarrier(never, Promise.reject(Error('upstream failure')), 'failed'), /upstream failure/);
  await assert.rejects(waitForBarrier(never, never, 'missing', 10), /deadline exceeded/);
});

it('RPC barrier requires the operation-specific blocking query and ends polling', async () => {
  let count = 0;
  const db = { query: async (query, args) => {
    assert.match(query, /pg_blocking_pids/); assert.match(query, /position\(\$2 in a.query\)/);
    assert.deepEqual(args, [42, 'chat_send_message']);
    return { rows: [{ waiting: ++count === 2 }] };
  } };
  await waitForBlockedRpc(db, 42, 'chat_send_message', new Promise(() => {}));
  assert.equal(count, 2);
  await assert.rejects(waitForBlockedRpc(db, 42, 'chat_send_message', Promise.resolve()), /completed before barrier/);
});

it('file snapshots represent absence, creation, content changes and removal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-review-files-'));
  const file = path.join(dir, 'optional');
  try {
    assert.equal(fileFingerprint(file), null);
    fs.writeFileSync(file, 'first'); const first = fileFingerprint(file); assert.equal(typeof first, 'string');
    fs.writeFileSync(file, 'second'); assert.notEqual(fileFingerprint(file), first);
    fs.unlinkSync(file); assert.equal(fileFingerprint(file), null);
    assert.throws(() => fileFingerprint(dir));
  } finally { fs.rmSync(dir, { recursive: true }); }
});

it('history loads more than 100 retained messages and preserves the initial watermark', async () => {
  const stored = Array.from({ length: 250 }, (_, id) => ({ id: String(id), last_event_seq: String(id + 1) }));
  const api = async (_user, route) => {
    const cursor = new URL('http://local' + route).searchParams.get('cursor');
    const offset = cursor ? Number(cursor) : 0;
    return { status: 200, data: { messages: stored.slice(offset, offset + 100), sync_event_seq: offset ? '999' : '250', next_cursor: offset + 100 < stored.length ? String(offset + 100) : null } };
  };
  const history = await completeHistory(api);
  assert.deepEqual(history.data.messages, stored); assert.equal(history.data.sync_event_seq, '250');
  await assert.rejects(completeHistory(async () => ({ status: 200, data: { messages: [], next_cursor: 'repeat' } })), /cursor repeated/);
});

it('commit hygiene catches index-only UUIDs even after working file is restored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-review-index-'));
  const root = path.resolve(import.meta.dirname, '..');
  try {
    // A local shared clone has its own index and refs; no commits or source-index changes.
    execFileSync('git', ['clone', '--shared', '--quiet', '--no-hardlinks', root, dir], { stdio: 'pipe' });
    fs.copyFileSync(path.join(root, 'scripts/check-chat-commit.mjs'), path.join(dir, 'scripts/check-chat-commit.mjs'));
    const target = path.join(dir, 'docs/review-candidate.md');
    fs.writeFileSync(target, randomUUID()); execFileSync('git', ['add', 'docs/review-candidate.md'], { cwd: dir });
    fs.writeFileSync(target, 'corrected but unstaged');
    const check = () => spawnSync(process.execPath, ['scripts/check-chat-commit.mjs'], { cwd: dir, encoding: 'utf8' });
    const bad = check(); assert.equal(bad.status, 1);
    const report = JSON.parse(bad.stdout); assert.ok(report.issues.some(i => i.file === 'docs/review-candidate.md' && i.category === 'non-fixture-uuid' && i.source === 'index'));
    execFileSync('git', ['add', 'docs/review-candidate.md'], { cwd: dir }); assert.equal(check().status, 0);
    fs.writeFileSync(target, randomUUID());
    assert.ok(JSON.parse(check().stdout).issues.some(i => i.source === 'working-tree'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
