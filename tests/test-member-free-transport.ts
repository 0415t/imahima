import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createPushNotificationService } from '../server/services/notifications';
import { createMemberFreeNotificationPoller } from '../server/jobs/member-free-notifications';

for (const stalled of ['headers', 'body'] as const) {
test(`worker signal closes stalled Expo ${stalled} and prevents later chunks`, { timeout: 5000 }, async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const local = `http://127.0.0.1:${address.port}/mock-expo`;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  // Keep Expo's serialization, HTTP client and abort dispatcher. Redirect only
  // its destination to our ephemeral loopback server; never call Expo externally.
  globalThis.fetch = (input, init) => {
    assert.equal(String(input), 'https://exp.host/--/api/v2/push/send');
    return originalFetch(local, { ...init, redirect: 'error' });
  };
  let received!: () => void;
  const arrived = new Promise<void>((resolve) => { received = resolve; });
  let disconnected!: () => void;
  const closed = new Promise<void>((resolve) => { disconnected = resolve; });
  server.on('request', (req, res) => {
    requests++;
    req.resume();
    res.on('close', disconnected);
    if (stalled === 'body') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"data":');
    }
    received(); // Deliberately never complete the response.
  });
  try {
    const controller = new AbortController();
    const service = createPushNotificationService({ deleteDeviceToken: async () => ({ error: null }) });
    const tokens = Array.from({ length: 101 }, (_, i) => `ExpoPushToken[offline-${i}]`);
    const sending = service.sendPushNotifications(tokens, { title: 'test', body: 'test' }, controller.signal);
    const rejected = assert.rejects(sending, /abort/i);
    await arrived;
    controller.abort();
    await rejected;
    await closed;
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
}

for (const mode of ['success', 'timeout', 'stop', 'partial-timeout', 'cleanup-timeout', 'partial-stop'] as const) {
test(`integrated member-free worker and real Expo Agent: ${mode}`, { timeout: 5000 }, async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const local = `http://127.0.0.1:${address.port}/mock-expo`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    assert.equal(String(input), 'https://exp.host/--/api/v2/push/send');
    return originalFetch(local, { ...init, redirect: 'error' });
  };
  let arrived!: () => void, disconnected!: () => void;
  const receiving = new Promise<void>((resolve) => { arrived = resolve; });
  const closed = new Promise<void>((resolve) => { disconnected = resolve; });
  let requests = 0;
  const completions: { status: string; count: number }[] = [];
  server.on('request', (req, res) => {
    requests++; req.resume(); res.on('close', disconnected);
    if (mode !== 'partial-stop' || requests === 2) arrived();
    if (mode === 'cleanup-timeout') {
      res.end(JSON.stringify({ data: [{ status: 'ok', id: 'confirmed' }, {
        status: 'error', message: 'unregistered', details: { error: 'DeviceNotRegistered' },
      }] }));
    } else if (mode === 'success' || ((mode === 'partial-timeout' || mode === 'partial-stop') && requests === 1)) {
      const count = requests === 1 ? 100 : 1;
      res.end(JSON.stringify({ data: Array.from({ length: count }, () => ({ status: 'ok', id: 'offline-ticket' })) }));
    }
  });
  const service = createPushNotificationService({ deleteDeviceToken: async () => {
    if (mode === 'cleanup-timeout') return new Promise(() => {});
    return { error: null };
  } });
  const poller = createMemberFreeNotificationPoller({
    claimNotifications: async () => ({ claims: [{ notificationId: 'n', eventId: 'e', recipientUserId: 'r', actorName: null, attempts: 1, leaseToken: 'l' }], error: null }),
    validateNotification: async () => ({ validation: { owned: true, stillValid: true }, error: null }),
    getDeviceTokens: async () => ({ tokens: Array.from({ length: mode === 'cleanup-timeout' ? 2 : 101 }, (_, i) => `ExpoPushToken[offline-${i}]`), error: null }),
    sendPushNotifications: service.sendPushNotifications,
    completeNotification: async (_id, _lease, status, _reason, count) => { completions.push({ status, count: count ?? 0 }); return { completed: true, error: null }; },
  }, { requestTimeoutMs: 500, stopTimeoutMs: 20 });
  try {
    const cycle = poller.runOnce();
    await receiving;
    if (mode === 'stop' || mode === 'partial-stop') await poller.stop();
    await cycle; await closed;
    assert.equal(requests, ['success', 'partial-timeout', 'partial-stop'].includes(mode) ? 2 : 1);
    const accepted = mode === 'success' ? 101 : mode === 'cleanup-timeout' ? 1
      : mode === 'partial-timeout' || mode === 'partial-stop' ? 100 : 0;
    assert.deepEqual(completions, mode === 'stop' ? [] : [{ status: accepted > 0 ? 'sent' : 'failed', count: accepted }]);
  } finally {
    await poller.stop();
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
}
