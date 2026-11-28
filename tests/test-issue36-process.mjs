import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopIssue36Server } from './helpers/issue36-process.mjs';

test('Issue #36 stops Express gracefully while waiting for close', async () => {
  const done = Promise.withResolvers();
  const child = {
    connected: true,
    send(message) {
      assert.deepEqual(message, { type: 'shutdown' });
      done.resolve({ code: 0 });
    },
    kill() { assert.fail('graceful exit must not be force-killed'); },
  };
  assert.deepEqual(await stopIssue36Server(child, done.promise, false), {code:0});
});

test('Issue #36 force-kills a stalled child and waits for close before cleanup', async () => {
  const done = Promise.withResolvers();
  const killed = Promise.withResolvers();
  const child = {
    connected: true,
    send() {},
    kill(signal) {
      assert.equal(signal, 'SIGKILL');
      killed.resolve();
    },
  };
  let cleanupStarted = false;
  const cleanup = stopIssue36Server(child, done.promise, false, 5).then(() => { cleanupStarted = true; });
  await killed.promise;
  assert.equal(cleanupStarted,false);
  done.resolve({code:null,signal:'SIGKILL'});
  await cleanup;
  assert.equal(cleanupStarted,true);
});
