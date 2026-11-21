import assert from 'node:assert/strict';
import { it } from 'node:test';
import { waitForWorkerBarrier } from './helpers/worker-barrier';

it('worker barrier waits for the send callback and clears its timer', async t => {
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  let enter!: () => void;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  let passed = false;
  const waiting = waitForWorkerBarrier(ready, new Promise(() => {})).then(() => { passed = true; });
  await Promise.resolve(); assert.equal(passed, false);
  enter(); await waiting; assert.equal(passed, true); assert.equal(cleared.mock.callCount(), 1);
});
it('worker barrier fails immediately when the worker finishes before sending', async t => {
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  await assert.rejects(waitForWorkerBarrier(new Promise(() => {}), Promise.resolve()), /completed before entering send/);
  assert.equal(cleared.mock.callCount(), 1);
});
it('worker barrier observes worker rejection and clears its timer', async t => {
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  const error = new Error('Synthetic worker failure');
  await assert.rejects(waitForWorkerBarrier(new Promise(() => {}), Promise.reject(error)), error);
  assert.equal(cleared.mock.callCount(), 1);
});
it('worker barrier timeout still reaches cleanup', async t => {
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  let cleaned = false;
  try {
    await assert.rejects(waitForWorkerBarrier(new Promise(() => {}), new Promise(() => {}), 10), /barrier timed out/);
  } finally { cleaned = true; }
  assert.equal(cleaned, true); assert.equal(cleared.mock.callCount(), 1);
});
