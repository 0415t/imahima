// Offline regressions: execute the production entrypoint / test harness in isolated VMs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { URL, urlToHttpOptions } from 'node:url';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

test('entrypoint rejects invalid max attempts before listening or claiming', () => {
  const code = ts.transpileModule(source('server/index.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  for (const value of ['', 'abc', '0', '11', '1.5', 'Infinity']) {
    let listened = false;
    const noop = () => {};
    const modules = {
      'dotenv/config': {}, './app': { createApp: () => ({ listen: () => { listened = true; return {}; } }) },
      './services/supabase': { serverSupabase: {} },
      './device-verifier': { notificationSessionExtender: () => async () => ({ status: 503 }) },
      './services/notifications': { createPushNotificationService: () => ({ sendPushNotifications: noop }) },
      './services/notification-delivery': require('../server/services/notification-delivery.ts'),
      './jobs/free-end-notifications': {},
      './jobs/chat-message-notifications': require('../server/jobs/chat-message-notifications.ts'),
      './services/groups': { groupService: () => ({}) },
      './services/chat': { chatService: () => ({}) },
      './jobs/member-free-notifications': { ...require('../server/jobs/member-free-notifications.ts'), createMemberFreeNotificationPoller: () => ({ start: noop }) },
    };
    assert.throws(() => runInNewContext(code, {
      exports: {}, require: (name) => { assert.ok(name in modules, name); return modules[name]; },
      process: { env: { MEMBER_FREE_NOTIFICATIONS_ENABLED: 'true', MEMBER_FREE_NOTIFICATIONS_MAX_ATTEMPTS: value }, on: noop }, console,
    }), /MEMBER_FREE_NOTIFICATIONS_MAX_ATTEMPTS must be an integer from 1 to 10/);
    assert.equal(listened, false);
  }
});

function runEntrypoint({ supabase = {}, poller, server = {}, listeners = {}, ...globals }) {
  const noop = () => {};
  const modules = {
    'dotenv/config': {}, './app': { createApp: () => ({ listen: () => server }) },
    './services/supabase': { serverSupabase: supabase },
    './device-verifier': { notificationSessionExtender: () => async () => ({ status: 503 }) },
    './services/notifications': { createPushNotificationService: () => ({ sendPushNotifications: noop }) },
    './services/notification-delivery': require('../server/services/notification-delivery.ts'),
    './jobs/free-end-notifications': {},
    './jobs/chat-message-notifications': require('../server/jobs/chat-message-notifications.ts'),
    './services/groups': { groupService: () => ({}) },
    './services/chat': { chatService: () => ({}) },
    './jobs/member-free-notifications': {
      ...require('../server/jobs/member-free-notifications.ts'), createMemberFreeNotificationPoller: poller,
    },
  };
  runInNewContext(ts.transpileModule(source('server/index.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports: {}, require: (name) => { assert.ok(name in modules, name); return modules[name]; },
    console: { log: noop }, process: { env: { MEMBER_FREE_NOTIFICATIONS_ENABLED: 'true' }, on: (event, fn) => { listeners[event] = fn; }, exit: noop },
    ...globals,
  });
}

test('entrypoint passes cancellation into every real member-free PostgREST request', { timeout: 5000 }, async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  let deps;
  const supabase = createClient(`http://127.0.0.1:${address.port}`, 'offline-key', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    runEntrypoint({ supabase, poller: (value) => { deps = value; return { start() {} }; } });
    const calls = [
      (signal) => deps.claimNotifications(signal),
      (signal) => deps.validateNotification('n', 'lease', signal),
      (signal) => deps.sendAuthorized('n', 'lease', { title: 'test', body: 'test' }, signal),
      (signal) => deps.completeNotification('n', 'lease', 'failed', 'test', 0, signal),
    ];
    for (const call of calls) {
      const arrived = once(server, 'request');
      const controller = new AbortController();
      const pending = call(controller.signal);
      const [req, res] = await arrived;
      req.resume();
      const closed = once(res, 'close');
      controller.abort();
      assert.ok((await pending).error);
      await closed;
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('entrypoint bounds total shutdown and ignores repeated signals', async () => {
  const listeners = {}; let forceExit, stopping = 0, forced = 0, exits = 0;
  runEntrypoint({
    poller: () => ({ start() {}, stop: () => { stopping++; return new Promise(() => {}); } }),
    server: { closeAllConnections() { forced++; } }, listeners,
    process: { env: { MEMBER_FREE_NOTIFICATIONS_ENABLED: 'true' }, on: (event, fn) => { listeners[event] = fn; }, exit: () => { exits++; } },
    setTimeout: (fn, ms) => { assert.equal(ms, 10_000); forceExit = fn; return { unref() {} }; }, clearTimeout() {},
  });
  listeners.SIGTERM(); listeners.SIGINT();
  assert.equal(stopping, 1);
  forceExit(); assert.equal(forced, 1); assert.equal(exits, 1);
});

test('gateway destroys downstream on incomplete upstream close, keeps completed responses', () => {
  let handle, receive;
  const upstream = new EventEmitter(); upstream.destroy = () => {};
  const http = {
    createServer: (fn) => { handle = fn; return { listen() {} }; },
    request: (_options, fn) => { receive = fn; return upstream; },
  };
  runInNewContext(source('tests/member-free-api-gateway.mjs').replace(/^import .*;$/gm, ''), {
    http, timingSafeEqual: (a, b) => a.equals(b), Buffer, process: { env: { ANON_KEY: 'local' } },
  });
  for (const complete of [false, true]) {
    let destroyed = false;
    const res = { writeHead() {}, destroy() { destroyed = true; } };
    handle({ headers: { apikey: 'local' }, url: '/rest/v1/profiles', pipe() {} }, res);
    const response = new EventEmitter(); Object.assign(response, { statusCode: 200, headers: {}, complete, pipe() {} });
    receive(response); response.emit('close');
    assert.equal(destroyed, !complete);
  }
});

test('guard checks effective URL plus options for request/get, without dispatching externally', () => {
  const dispatched = [];
  const http = {}, https = {};
  for (const mod of [http, https]) for (const method of ['get', 'request']) {
    mod[method] = (...args) => { dispatched.push(args); return {}; };
  }
  const config = { url: 'http://127.0.0.1:55440', service: 'fake' };
  const modules = {
    'node:assert/strict': assert, 'node:fs': { readFileSync: () => JSON.stringify(config) },
    'node:http': http, 'node:https': https, 'node:url': { urlToHttpOptions },
    'node:module': { syncBuiltinESMExports() {} },
  };
  runInNewContext(source('tests/member-free-entrypoint-guard.cjs'), {
    require: (name) => { assert.ok(name in modules, name); return modules[name]; }, URL,
    process: { env: { SUPABASE_URL: config.url, SUPABASE_SERVICE_ROLE_KEY: config.service, HOST: '127.0.0.1', PORT: '55442', EXPO_ACCESS_TOKEN: '' }, on() {} },
  });
  for (const method of ['request', 'get']) {
    for (const options of [{ hostname: 'example.test' }, { port: 80 }, { protocol: 'https:' }]) {
      assert.throws(() => http[method](config.url, options), /OUTBOUND_BLOCKED/);
    }
    const callback = () => {};
    http[method](`${config.url}/rest/v1/profiles?q=1`, { method: 'POST' }, callback);
    const [options, cb] = dispatched.at(-1);
    assert.equal(options.hostname, '127.0.0.1'); assert.equal(String(options.port), '55440');
    assert.equal(options.path, '/rest/v1/profiles?q=1'); assert.equal(options.method, 'POST'); assert.equal(cb, callback);
  }
  assert.equal(dispatched.length, 2);
});

const integration = source('tests/test-member-free-push-integration.mjs');

function runChatEntrypoint(env, supabase = {}) {
  const noop = () => {}; let listened = false, deps, options, started = 0;
  const modules = {
    'dotenv/config': {}, './app': { createApp: () => ({ listen: () => { listened = true; return {}; } }) },
    './device-verifier': { notificationSessionExtender: () => async () => ({ status: 503 }) },
    './services/supabase': { serverSupabase: supabase },
    './services/notifications': { createPushNotificationService: () => ({ sendPushNotifications: noop }) },
    './services/notification-delivery': require('../server/services/notification-delivery.ts'),
    './services/groups': { groupService: () => ({}) }, './services/chat': { chatService: () => ({}) },
    './jobs/free-end-notifications': {}, './jobs/member-free-notifications': {},
    './jobs/chat-message-notifications': { ...require('../server/jobs/chat-message-notifications.ts'),
      createChatMessageNotificationPoller: (d, o) => { deps = d; options = o; return { start: () => started++, stop: async () => {} }; } },
  };
  runInNewContext(ts.transpileModule(source('server/index.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports: {}, require: name => { assert.ok(name in modules, name); return modules[name]; }, process: { env, on: noop }, console: { log: noop } });
  return { deps, options, started, listened };
}

test('chat worker is disabled by default and validates config before listen', () => {
  assert.equal(runChatEntrypoint({}).started, 0);
  for (const value of ['', '0', '11', '1.5']) assert.throws(() => runChatEntrypoint({ CHAT_MESSAGE_NOTIFICATIONS_ENABLED: 'true', CHAT_MESSAGE_NOTIFICATIONS_MAX_ATTEMPTS: value }), /CHAT_MESSAGE_NOTIFICATIONS_MAX_ATTEMPTS/);
});

test('chat entrypoint wires the claim, authorization and completion RPCs', async () => {
  const calls = []; const signal = new AbortController().signal;
  const query = (name, args) => ({
    retry(value) { assert.equal(value, false); return this; },
    async abortSignal(s) {
      assert.ok(s instanceof AbortSignal);
      calls.push({ name, args });
      return { data: name === 'authorize_notification_delivery' ? { eligible: false, targets: [], cursor: null } : [], error: null };
    },
  });
  const supabase = { rpc: query };
  const f = runChatEntrypoint({ CHAT_MESSAGE_NOTIFICATIONS_ENABLED: 'true', CHAT_MESSAGE_NOTIFICATIONS_MAX_ATTEMPTS: '4' }, supabase);
  assert.equal(f.started, 1); assert.equal(f.options.intervalMs, 5000);
  await f.deps.claimNotifications(signal); await f.deps.validateNotification('id', 'lease', signal);
  await f.deps.sendAuthorized('id', 'lease', { title: 'test', body: 'test' }, signal);
  await f.deps.completeNotification('id', 'lease', 'sent', 'safe', 2, signal);
  assert.deepEqual(calls.map(c => c.name), ['claim_chat_message_notifications', 'validate_chat_message_notification', 'authorize_notification_delivery', 'complete_chat_message_notification']);
  assert.equal(calls[0].args.p_max_attempts, 4); assert.equal(calls[3].args.p_accepted_count, 2);
  assert.equal(calls[0].args.p_limit, 1); assert.equal(calls[0].args.p_lease_seconds, 120);
});

test('crash stop and graceful fallback both force SIGKILL', async () => {
  const code = integration.slice(integration.indexOf('  async function stop('), integration.indexOf('  const sessions'));
  for (const graceful of [false, true]) {
    const signals = []; let fallback;
    const child = { send() {}, kill(signal) { signals.push(signal); } };
    const fn = runInNewContext(`${code}; stop`, {
      once: async () => [0], assert, processes: new Set([child]),
      setTimeout: (fn) => { fallback = fn; }, clearTimeout() {},
    });
    await fn({ child, logs: () => ({}) }, graceful); fallback();
    assert.deepEqual(signals, graceful ? ['SIGKILL'] : ['SIGKILL', 'SIGKILL']);
  }
});

test('retry zero-call assertion applies only before the backoff deadline', async () => {
  const code = integration.slice(integration.indexOf("    const recovering = await start('success', true);"), integration.indexOf('    retry.final ='));
  for (const now of [999, 1000, 1001]) {
    let checked = false;
    await runInNewContext(`(async () => { ${code} })()`, {
      start: async () => ({}), pause: async () => {},
      Date: { now: () => now, parse: () => 1000 }, retry: { notificationId: 'n', failed: { next_attempt_at: 'deadline' } },
      count: () => { checked = true; return now < 1000 ? 0 : 1; }, assert,
    });
    assert.equal(checked, now < 1000);
  }
});

test('cleanup failure fails the test after recording failure, preserves token-specific DELETE', async () => {
  const code = integration.slice(integration.lastIndexOf('    for (const child of processes)'), integration.lastIndexOf('\n  }\n});'));
  for (const outcome of ['ok', 'error', 'throw', 'read-error']) {
    let written;
    const report = { passed: true };
    const promise = runInNewContext(`(async () => { ${code} })()`, {
      processes: [], identityVerified: true, report, config: { url: 'local' }, token: 'run-token', encodeURIComponent, assert,
      request: async (_url, path, method) => {
        assert.equal(method, 'DELETE'); assert.ok(path.endsWith('expo_push_token=eq.run-token'));
        if (outcome === 'throw') throw new Error('delete unavailable');
        return { status: outcome === 'ok' ? 204 : 500 };
      }, rows: async () => { if (outcome === 'read-error') throw new Error('read unavailable'); return []; },
      writeFileSync: (_path, text) => { written = JSON.parse(text); },
    });
    if (outcome === 'ok') await promise; else await assert.rejects(promise, /synthetic token cleanup failed/i);
    assert.equal(written.fakeTokenRemoved, outcome === 'ok');
    assert.equal(written.passed, outcome === 'ok');
  }
});
