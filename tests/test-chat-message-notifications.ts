import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { chatMessagePushMessage, createChatMessageNotificationPoller, parseChatNotificationOptions,
  type ChatMessageClaim, type ChatMessageNotificationDependencies, type ChatMessageValidation } from '../server/jobs/chat-message-notifications';
import { createPushNotificationService, PushSendError, type PushClient } from '../server/services/notifications';

const claim: ChatMessageClaim = { notificationId: 'n', roomId: 'room', messageId: 'message', recipientUserId: 'recipient', leaseToken: 'lease' };
const valid: ChatMessageValidation = { owned: true, stillValid: true, senderName: '太郎', messageBody: 'こんにちは', remainingMs: 100_000, expiration: Math.floor(Date.now() / 1000) + 300 };
const result = (sent: number) => ({ sent, error: sent ? null : new PushSendError({ temporary: 1, permanent: 0, unknown: 0 }), failures: { temporary: sent ? 0 : 1, permanent: 0, unknown: 0 } });
function fixture(overrides: Partial<ChatMessageNotificationDependencies> = {}) {
  let claimed = false;
  const sends: Parameters<NonNullable<ChatMessageNotificationDependencies['sendPushNotifications']>>[] = [];
  const completions: Parameters<ChatMessageNotificationDependencies['completeNotification']>[] = [];
  const deps: ChatMessageNotificationDependencies = {
    claimNotifications: async () => { const claims = claimed ? [] : [claim]; claimed = true; return { claims, error: null }; },
    validateNotification: async () => ({ validation: { ...valid }, error: null }),
    getDeviceTokens: async () => ({ tokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]', 'ExponentPushToken[a]'], error: null }),
    sendPushNotifications: async (...args) => { sends.push(args); return result(1); },
    completeNotification: async (...args) => { completions.push(args); return { completed: true, error: null }; },
    ...overrides,
  };
  return { deps, sends, completions };
}

describe('chat message Push', () => {
  it('claims the next notification only after completion, with no interval wait', async () => {
    const events: string[] = []; let next = 0;
    const f = fixture({
      claimNotifications: async () => { events.push('claim'); return { claims: next < 2 ? [{ ...claim, notificationId: String(next++) }] : [], error: null }; },
      completeNotification: async id => { events.push(`complete:${id}`); return { completed: true, error: null }; },
    });
    await createChatMessageNotificationPoller(f.deps).runOnce();
    assert.deepEqual(events, ['claim', 'complete:0', 'claim', 'complete:1', 'claim']);
  });
  it('caps each cycle at 20 individually claimed notifications', async () => {
    let calls = 0;
    const f = fixture({ claimNotifications: async () => ({ claims: [{ ...claim, notificationId: String(++calls) }], error: null }) });
    const p = createChatMessageNotificationPoller(f.deps);
    await p.runOnce(); assert.equal(calls, 20); assert.equal(f.completions.length, 20);
    await p.runOnce(); assert.equal(calls, 40);
  });
  it('ends a cycle on an empty claim or a claim error', async () => {
    for (const error of [null, new Error('Unavailable')]) {
      let calls = 0;
      const f = fixture({ claimNotifications: async () => { calls++; return { claims: [], error }; } });
      await createChatMessageNotificationPoller(f.deps).runOnce(); assert.equal(calls, 1);
    }
  });
  it('does not start another claim after stop during completion', async () => {
    let entered!: () => void, release!: () => void, calls = 0;
    const ready = new Promise<void>(r => { entered = r; });
    const done = new Promise<void>(r => { release = r; });
    const f = fixture({
      claimNotifications: async () => { calls++; return { claims: [claim], error: null }; },
      completeNotification: async () => { entered(); await done; return { completed: true, error: null }; },
    });
    const p = createChatMessageNotificationPoller(f.deps);
    const running = p.runOnce(); await ready; const stopping = p.stop(); release();
    await Promise.all([running, stopping]); await p.runOnce(); assert.equal(calls, 1);
  });
  it('does not process a claim arriving after stop', async () => {
    let entered!: () => void, release!: () => void, calls = 0;
    const ready = new Promise<void>(r => { entered = r; });
    const done = new Promise<void>(r => { release = r; });
    const f = fixture({ claimNotifications: async () => { calls++; entered(); await done; return { claims: [claim], error: null }; } });
    const p = createChatMessageNotificationPoller(f.deps);
    const running = p.runOnce(); await ready; const stopping = p.stop(); release();
    await Promise.all([running, stopping]); assert.equal(calls, 1); assert.equal(f.sends.length, 0);
  });
  it('does not dispatch a queued claim after an immediate stop', async () => {
    let calls = 0;
    const f = fixture({ claimNotifications: async () => { calls++; return { claims: [], error: null }; } });
    const p = createChatMessageNotificationPoller(f.deps);
    const running = p.runOnce(); await p.stop(); await running; assert.equal(calls, 0);
  });
  it('validates independent startup options and timer bounds', () => {
    assert.deepEqual(parseChatNotificationOptions({}), { intervalMs: 5000, maxAttempts: 3 });
    for (const bad of ['', '0', '11', '1.5', 'NaN']) assert.throws(() => parseChatNotificationOptions({ CHAT_MESSAGE_NOTIFICATIONS_MAX_ATTEMPTS: bad }));
    assert.equal(parseChatNotificationOptions({ CHAT_MESSAGE_NOTIFICATIONS_MAX_ATTEMPTS: '10' }).maxAttempts, 10);
    assert.throws(() => parseChatNotificationOptions({ CHAT_MESSAGE_NOTIFICATIONS_INTERVAL_MS: '2147483648' }));
  });
  it('sends a bounded grapheme preview and a versioned group-chat routing contract', () => {
    const family = '👨‍👩‍👧‍👦';
    const m = chatMessagePushMessage(claim, { ...valid, senderName: '\u202e太郎\n', messageBody: family.repeat(81) });
    assert.equal(m.body, `太郎: ${family.repeat(80)}…`);
    assert.deepEqual(m.data, { version: 1, type: 'chat_message', roomId: 'room', messageId: 'message', notificationId: 'n' });
    assert.equal(m.expiration, valid.expiration);
    assert.ok(Buffer.byteLength(JSON.stringify(m)) < 3500);
    assert.ok(!JSON.stringify(m.data).includes('太郎'));
  });
  it('bounds pathological combining sequences without splitting a grapheme', () => {
    const m = chatMessagePushMessage(claim, { ...valid, senderName: 'x' + '\u0301'.repeat(3000), messageBody: '\u0001\n' });
    assert.equal(m.body, 'メンバー: 新しいメッセージ');
  });
  it('accepts one device as recipient completion, deduplicating tokens', async () => {
    const f = fixture(); await createChatMessageNotificationPoller(f.deps).runOnce();
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0][0].length, 2);
    assert.equal(f.completions[0][2], 'sent'); assert.equal(f.completions[0][4], 1);
  });
  for (const [name, state] of Object.entries({ expired: { remainingMs: 0 }, offOrRejoined: { stillValid: false }, deleted: { messageBody: null }, lostLease: { owned: false } })) {
    it(`does not send when ${name}`, async () => {
      const f = fixture({ validateNotification: async () => ({ validation: { ...valid, ...state }, error: null }) });
      await createChatMessageNotificationPoller(f.deps).runOnce(); assert.equal(f.sends.length, 0);
      if (name === 'lostLease') assert.equal(f.completions.length, 0);
    });
  }
  it('rechecks after device lookup and suppresses changed eligibility', async () => {
    let checked = 0;
    const f = fixture({ validateNotification: async () => ({ validation: { ...valid, stillValid: ++checked === 1 }, error: null }) });
    await createChatMessageNotificationPoller(f.deps).runOnce(); assert.equal(checked, 2); assert.equal(f.sends.length, 0);
  });
  for (const stage of ['eligibility', 'devices', 'send'] as const) {
    it(`bounds a stalled ${stage}, without claiming a successful acceptance`, async () => {
      let signal: AbortSignal | undefined;
      const hang = (s: AbortSignal) => { signal = s; return new Promise<never>(() => {}); };
      const f = fixture(stage === 'eligibility' ? { validateNotification: (_id, _lease, s) => hang(s) }
        : stage === 'devices' ? { getDeviceTokens: (_id, s) => hang(s) } : { sendPushNotifications: (_t, _m, s) => hang(s!) });
      await createChatMessageNotificationPoller(f.deps, { requestTimeoutMs: 20 }).runOnce();
      assert.ok(signal?.aborted); assert.equal(f.completions[0][2], 'failed'); assert.equal(f.completions[0][4], 0);
    });
  }
  it('preserves confirmed acceptance when a later chunk or cleanup stalls', async () => {
    const f = fixture({ sendPushNotifications: async (_t, _m, _s, accepted) => { accepted?.(1); accepted?.(1); return new Promise(() => {}); } });
    await createChatMessageNotificationPoller(f.deps, { requestTimeoutMs: 20 }).runOnce();
    assert.equal(f.completions[0][2], 'sent'); assert.equal(f.completions[0][4], 1); assert.ok(!f.completions[0][5].aborted);
  });
  it('records confirmed acceptance after a stop abort using a fresh signal', async () => {
    let started!: () => void; const ready = new Promise<void>(r => { started = r; });
    const f = fixture({ sendPushNotifications: async (_t, _m, _s, accepted) => { accepted?.(1); started(); return new Promise(() => {}); } });
    const p = createChatMessageNotificationPoller(f.deps, { stopTimeoutMs: 50, requestTimeoutMs: 1000 });
    const running = p.runOnce(); await ready; await p.stop(); await running;
    assert.equal(f.completions[0][2], 'sent'); assert.ok(!f.completions[0][5].aborted);
    await p.runOnce(); assert.equal(f.completions.length, 1);
  });
  it('does not count acceptance arriving only after abort', async () => {
    let report!: (n: number) => void;
    const f = fixture({ sendPushNotifications: async (_t, _m, _s, accepted) => { report = accepted!; return new Promise(() => {}); } });
    await createChatMessageNotificationPoller(f.deps, { requestTimeoutMs: 20 }).runOnce(); report(1); await setImmediate();
    assert.equal(f.completions.length, 1); assert.equal(f.completions[0][2], 'failed');
  });
  it('does not overlap cycles', async () => {
    let finish!: () => void, calls = 0;
    const f = fixture({ claimNotifications: async () => { calls++; await new Promise<void>(r => { finish = r; }); return { claims: [], error: null }; } });
    const p = createChatMessageNotificationPoller(f.deps); const first = p.runOnce(); await setImmediate(); const second = p.runOnce(); finish();
    await Promise.all([first, second]); assert.equal(calls, 1); await p.stop();
  });
  it('passes provider expiration without changing legacy Push callers', async () => {
    const sent: unknown[] = [];
    const client: PushClient = { chunkPushNotifications: msgs => [msgs], sendPushNotificationsAsync: async msgs => { sent.push(msgs[0]); return [{ status: 'ok', id: 'ticket' }]; } };
    const service = createPushNotificationService({ client, deleteDeviceToken: async () => ({ error: null }) });
    await service.sendPushNotifications(['ExponentPushToken[a]'], { title: 't', body: 'b', expiration: valid.expiration });
    await service.sendPushNotifications(['ExponentPushToken[a]'], { title: 't', body: 'b' });
    assert.equal((sent[0] as { expiration: number }).expiration, valid.expiration); assert.ok(!('expiration' in (sent[1] as object)));
  });
  it('never starts a provider chunk after expiration', async () => {
    let calls = 0;
    const client: PushClient = { chunkPushNotifications: msgs => [msgs], sendPushNotificationsAsync: async () => { calls++; return []; } };
    const service = createPushNotificationService({ client, deleteDeviceToken: async () => ({ error: null }) });
    const sent = await service.sendPushNotifications(['ExponentPushToken[a]'], { title: 't', body: 'b', expiration: 1 });
    assert.equal(calls, 0); assert.equal(sent.sent, 0);
  });
});
