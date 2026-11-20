import { PushSendError, type PushMessage, type SendPushResult } from '../services/notifications';
import { withRequestTimeout } from './request-timeout';

export type ChatMessageClaim = {
  notificationId: string; roomId: string; messageId: string; recipientUserId: string; leaseToken: string;
};
export type ChatMessageValidation = {
  owned: boolean; stillValid: boolean; senderName: string; messageBody: string | null;
  remainingMs: number; expiration: number;
};
export type ChatMessageNotificationDependencies = {
  claimNotifications: (signal: AbortSignal) => Promise<{ claims: ChatMessageClaim[]; error: unknown | null }>;
  validateNotification: (id: string, lease: string, signal: AbortSignal) => Promise<{ validation: ChatMessageValidation | null; error: unknown | null }>;
  getDeviceTokens: (userId: string, signal: AbortSignal) => Promise<{ tokens: string[]; error: unknown | null }>;
  sendPushNotifications: (tokens: string[], message: PushMessage, signal?: AbortSignal,
    onAccepted?: (confirmedCount: number) => void) => Promise<SendPushResult>;
  completeNotification: (id: string, lease: string, status: 'sent' | 'failed' | 'cancelled', reason: string,
    acceptedCount: number, signal: AbortSignal) => Promise<{ completed: boolean; error: unknown | null }>;
};

export function parseChatNotificationOptions(env: Record<string, string | undefined>) {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return value;
  };
  return {
    intervalMs: integer('CHAT_MESSAGE_NOTIFICATIONS_INTERVAL_MS', 5000, 1000, 2_147_483_647),
    maxAttempts: integer('CHAT_MESSAGE_NOTIFICATIONS_MAX_ATTEMPTS', 3, 1, 10),
  };
}

// Display-only copies: never edit the stored message, split UTF-16 pairs or ZWJ
// emoji, or place the full message/credentials in data or logs.
function preview(value: string, maximum: number, fallback: string, byteBudget: number): string {
  const clean = value.replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  const segments = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(clean)];
  let text = ''; let count = 0;
  for (const { segment } of segments) {
    if (count >= maximum || Buffer.byteLength(text + segment, 'utf8') > byteBudget) break;
    text += segment; count++;
  }
  return text ? text + (count < segments.length ? '…' : '') : fallback;
}

export function chatMessagePushMessage(claim: ChatMessageClaim, validation: ChatMessageValidation): PushMessage {
  return {
    title: 'imahima',
    body: `${preview(validation.senderName, 40, 'メンバー', 400)}: ${preview(validation.messageBody ?? '', 80, '新しいメッセージ', 2400)}`,
    expiration: validation.expiration,
    data: { version: 1, type: 'chat_message', roomId: claim.roomId, messageId: claim.messageId, notificationId: claim.notificationId },
  };
}

export function createChatMessageNotificationPoller(deps: ChatMessageNotificationDependencies, options: {
  intervalMs?: number; requestTimeoutMs?: number; stopTimeoutMs?: number;
} = {}) {
  const intervalMs = options.intervalMs ?? 5000, requestTimeoutMs = options.requestTimeoutMs ?? 10_000, stopTimeoutMs = options.stopTimeoutMs ?? 5000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 2_147_483_647) throw new Error('Invalid chat notification interval');
  for (const n of [requestTimeoutMs, stopTimeoutMs]) if (!Number.isInteger(n) || n < 1 || n > 2_147_483_647) throw new Error('Invalid chat notification timeout');
  const shutdown = new AbortController();
  const request = <T>(work: (signal: AbortSignal) => Promise<T>) => withRequestTimeout(work, requestTimeoutMs, shutdown.signal);
  let stopped = false, running: Promise<void> | null = null, timer: ReturnType<typeof setInterval> | null = null;

  const complete = async (c: ChatMessageClaim, status: 'sent' | 'failed' | 'cancelled', reason: string, accepted = 0) => {
    try {
      if (shutdown.signal.aborted && status !== 'sent') return;
      const result = await withRequestTimeout(signal => deps.completeNotification(c.notificationId, c.leaseToken, status, reason, accepted, signal),
        requestTimeoutMs, status === 'sent' ? undefined : shutdown.signal);
      if (result.error || !result.completed) console.warn('[chat-push] completion not recorded', { notificationId: c.notificationId });
    } catch { console.warn('[chat-push] completion unavailable', { notificationId: c.notificationId }); }
  };
  const validate = async (c: ChatMessageClaim) => {
    const started = performance.now();
    const { validation: v, error } = await request(signal => deps.validateNotification(c.notificationId, c.leaseToken, signal));
    if (error) { await complete(c, 'failed', 'Eligibility lookup failed'); return null; }
    if (!v?.owned) return null;
    // Subtract the entire roundtrip, conservatively accounting for time since the
    // DB check without assuming that the worker wall clock matches the DB clock.
    const remainingMs = v.remainingMs - (performance.now() - started) - 25;
    if (!v.stillValid || v.messageBody === null || !Number.isFinite(remainingMs) || remainingMs <= 0) {
      await complete(c, 'cancelled', 'Eligibility changed or deadline reached'); return null;
    }
    return { validation: v, deadline: performance.now() + remainingMs };
  };
  const processClaim = async (c: ChatMessageClaim) => {
    let accepted = 0;
    try {
      if (!await validate(c)) return;
      const { tokens, error } = await request(signal => deps.getDeviceTokens(c.recipientUserId, signal));
      if (error) { await complete(c, 'failed', 'Device lookup failed'); return; }
      if (!tokens.length) { await complete(c, 'cancelled', 'No registered devices'); return; }
      if (stopped) return;
      const ready = await validate(c);
      if (!ready || stopped) return;
      const message = chatMessagePushMessage(c, ready.validation);
      // Leave headroom under APNs/FCM's total payload ceiling, including wrappers.
      if (Buffer.byteLength(JSON.stringify(message), 'utf8') > 3500) { await complete(c, 'cancelled', 'Payload too large'); return; }
      const budget = Math.floor(Math.min(requestTimeoutMs, ready.deadline - performance.now()));
      if (budget < 1) { await complete(c, 'cancelled', 'Deadline reached'); return; }
      const result = await withRequestTimeout(signal => {
        if (performance.now() >= ready.deadline) throw new Error('Chat notification expired');
        return deps.sendPushNotifications([...new Set(tokens)], message, signal, count => {
          if (!signal.aborted && performance.now() < ready.deadline && Number.isSafeInteger(count) && count > 0) accepted = Math.max(accepted, count);
        });
      }, budget, shutdown.signal);
      if (performance.now() < ready.deadline) accepted = Math.max(accepted, result.sent);
      const reason = `temporary=${result.failures.temporary}, permanent=${result.failures.permanent}, unknown=${result.failures.unknown}`;
      await complete(c, accepted > 0 ? 'sent' : result.error instanceof PushSendError && result.error.permanentOnly ? 'cancelled' : 'failed', reason, accepted);
    } catch { await complete(c, accepted > 0 ? 'sent' : 'failed', 'Transport interrupted; unconfirmed acceptance may be unknown', accepted); }
  };
  const cycle = async () => {
    try {
      // Reserve only work that can start now. Claiming a batch spends every
      // row's lease and attempt while preceding rows are still being processed.
      for (let processed = 0; processed < 20 && !stopped; processed++) {
        const { claims, error } = await request(signal => stopped
          ? Promise.resolve({ claims: [], error: null }) : deps.claimNotifications(signal));
        if (error) { console.warn('[chat-push] claim unavailable'); return; }
        if (stopped || !claims.length) return;
        if (claims.length !== 1) { console.warn('[chat-push] expected a single claim'); return; }
        await processClaim(claims[0]);
      }
    } catch { console.warn('[chat-push] claim failed'); }
  };
  const runOnce = () => {
    if (stopped || running) return running ?? Promise.resolve();
    running = cycle().finally(() => { running = null; }); return running;
  };
  const start = () => { if (!timer && !stopped) { timer = setInterval(() => { void runOnce(); }, intervalMs); void runOnce(); } };
  const stop = async () => {
    stopped = true; if (timer) { clearInterval(timer); timer = null; } if (!running) return;
    let abort: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([running, new Promise<void>(resolve => {
      abort = setTimeout(() => shutdown.abort(), Math.max(1, Math.floor(stopTimeoutMs / 2)));
      deadline = setTimeout(() => { shutdown.abort(); resolve(); }, stopTimeoutMs);
    })]); } finally { clearTimeout(abort); clearTimeout(deadline); }
  };
  return { start, stop, runOnce };
}
