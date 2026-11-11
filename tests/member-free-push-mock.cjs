// Test-only preload: keep the real Expo SDK and service; replace its final fetch only.
require('./member-free-entrypoint-guard.cjs');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const guardedFetch = globalThis.fetch;
const allowedModes = ['success', 'temporary', 'permanent', 'hold', 'accepted-hold'];
assert.ok(allowedModes.includes(process.env.LOCAL_PUSH_MOCK_MODE));
assert.equal(process.env.EXPO_BASE_URL, 'https://exp.host');
const releases = new Map();
process.on('message', (message) => {
  if (message?.type === 'mock-release') releases.get(message.notificationId)?.();
});
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.href !== 'https://exp.host/--/api/v2/push/send') return guardedFetch(input, init);
  assert.equal(init.method.toUpperCase(), 'POST');
  const compressed = new Headers(init.headers).get('Content-Encoding') === 'gzip';
  const messages = JSON.parse(compressed ? gunzipSync(init.body).toString() : init.body);
  assert.ok(Array.isArray(messages) && messages.length > 0);
  for (const message of messages) {
    assert.equal(message.to, process.env.LOCAL_PUSH_MOCK_TOKEN, 'Only the dedicated fake token is allowed');
    assert.equal(message.data.type, 'member_free');
    assert.ok(message.data.notificationId && message.data.eventId);
  }
  const mode = process.env.LOCAL_PUSH_MOCK_MODE;
  process.send?.({ type: 'mock-push', mode, messages });
  if (mode === 'hold' || mode === 'accepted-hold') {
    // accepted-hold models acceptance before the worker can record completion.
    await new Promise((resolve) => releases.set(messages[0].data.notificationId, resolve));
  }
  const data = messages.map(() => mode === 'temporary'
    ? { status: 'error', message: 'Simulated temporary failure', details: { error: 'MessageRateExceeded' } }
    : mode === 'permanent'
      ? { status: 'error', message: 'Simulated permanent failure', details: { error: 'InvalidCredentials' } }
      : { status: 'ok', id: 'mock-ticket-no-external-delivery' });
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
