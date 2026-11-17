import { PushSendError, type PushMessage, type SendPushResult } from '../services/notifications';
import { withRequestTimeout } from './request-timeout';

export function parseMemberFreeMaxAttempts(value: string | undefined): number {
  const attempts = Number(value ?? 3);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error('MEMBER_FREE_NOTIFICATIONS_MAX_ATTEMPTS must be an integer from 1 to 10');
  }
  return attempts;
}

export type MemberFreeClaim = {
  notificationId: string;
  eventId: string;
  recipientUserId: string;
  actorName: string | null;
  attempts: number;
  leaseToken: string;
};
export type MemberFreeDependencies = {
  claimNotifications: (signal?: AbortSignal) => Promise<{ claims: MemberFreeClaim[]; error: unknown | null }>;
  validateNotification: (id: string, lease: string, signal?: AbortSignal) => Promise<{
    validation: { owned: boolean; stillValid: boolean } | null; error: unknown | null;
  }>;
  getDeviceTokens: (userId: string, signal?: AbortSignal) => Promise<{ tokens: string[]; error: unknown | null }>;
  sendPushNotifications: (tokens: string[], message: PushMessage, signal?: AbortSignal) => Promise<SendPushResult>;
  completeNotification: (id: string, lease: string, status: 'sent' | 'failed' | 'cancelled',
    error?: string, acceptedCount?: number, signal?: AbortSignal) => Promise<{ completed: boolean; error: unknown | null }>;
};

export function createMemberFreeNotificationPoller(dependencies: MemberFreeDependencies, options: {
  intervalMs?: number; requestTimeoutMs?: number; stopTimeoutMs?: number;
} = {}) {
  const intervalMs = options.intervalMs ?? 5_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new Error('Member-free interval must be at least 1000 ms');
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  for (const timeout of [requestTimeoutMs, stopTimeoutMs]) {
    if (!Number.isInteger(timeout) || timeout < 1) throw new Error('Member-free timeouts must be positive integers');
  }
  const shutdown = new AbortController();
  const request = <T>(operation: (signal: AbortSignal) => PromiseLike<T>) =>
    withRequestTimeout(operation, requestTimeoutMs, shutdown.signal);
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const complete = async (claim: MemberFreeClaim, status: 'sent' | 'failed' | 'cancelled', reason?: string, sent = 0) => {
    try {
      if (shutdown.signal.aborted) return;
      const result = await request((signal) => dependencies.completeNotification(claim.notificationId, claim.leaseToken, status, reason, sent, signal));
      if (result.error || !result.completed) console.warn('[member-free] completion not recorded', { notificationId: claim.notificationId });
    } catch {
      // lease期限切れ後にDBから再取得する。Token・認証情報を含み得る例外本文は記録しない。
      console.warn('[member-free] completion unavailable', { notificationId: claim.notificationId });
    }
  };

  const validate = async (claim: MemberFreeClaim) => {
    const { validation, error } = await request((signal) => dependencies.validateNotification(claim.notificationId, claim.leaseToken, signal));
    if (error) {
      await complete(claim, 'failed', 'Eligibility lookup failed');
      return false;
    }
    if (!validation?.owned) return false;
    if (!validation.stillValid) {
      await complete(claim, 'cancelled', 'Eligibility changed');
      return false;
    }
    return true;
  };

  const processClaim = async (claim: MemberFreeClaim) => {
    try {
      if (!await validate(claim)) return;
      const { tokens, error } = await request((signal) => dependencies.getDeviceTokens(claim.recipientUserId, signal));
      if (error) { await complete(claim, 'failed', 'Device lookup failed'); return; }
      if (!tokens.length) { await complete(claim, 'cancelled', 'No registered devices'); return; }
      // Token取得中の状態変化・lease期限切れも検出する。以降の外部通信との競合は残る。
      if (stopped) return;
      if (!await validate(claim) || stopped) return;
      const name = claim.actorName?.trim();
      const result = await request((signal) => dependencies.sendPushNotifications([...new Set(tokens)], {
        title: 'imahima', body: name ? `${name}さんが暇になりました！` : 'メンバーが暇になりました！',
        data: { type: 'member_free', eventId: claim.eventId, notificationId: claim.notificationId },
      }, signal));
      const summary = `temporary=${result.failures.temporary}, permanent=${result.failures.permanent}, unknown=${result.failures.unknown}`;
      if (result.sent > 0) {
        // A方式: 受信者内の部分成功はsent。成功済み端末への再送を避ける。
        await complete(claim, 'sent', summary, result.sent);
      } else {
        await complete(claim, result.error instanceof PushSendError && result.error.permanentOnly ? 'cancelled' : 'failed', summary);
      }
    } catch {
      await complete(claim, 'failed', 'Unexpected worker or transport failure; acceptance may be unknown');
    }
  };

  const cycle = async () => {
    try {
      const { claims, error } = await request((signal) => dependencies.claimNotifications(signal));
      if (error) { console.warn('[member-free] claim unavailable'); return; }
      for (const claim of claims) {
        if (stopped) break;
        await processClaim(claim);
      }
    } catch { console.warn('[member-free] claim failed'); }
  };
  const runOnce = (): Promise<void> => {
    if (stopped || running) return running ?? Promise.resolve();
    running = cycle().finally(() => { running = null; });
    return running;
  };
  const start = () => {
    if (timer || stopped) return;
    timer = setInterval(() => { void runOnce(); }, intervalMs);
    void runOnce();
  };
  const stop = async () => {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (!running) return;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([running, new Promise<void>((resolve) => {
        deadline = setTimeout(() => { shutdown.abort(); resolve(); }, stopTimeoutMs);
      })]);
    } finally {
      clearTimeout(deadline);
    }
  };
  return { runOnce, start, stop };
}
