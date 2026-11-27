import { Expo, type ExpoPushTicket } from 'expo-server-sdk';
import { PushSendError, type PushMessage, type SendPushResult } from './notifications';

export type DeliveryTarget = {
  id: string; userId: string; installationId: string | null; generation: string | null;
  revision: string | null; version: string; token: string;
};
type Page = { eligible: boolean; targets: DeliveryTarget[]; cursor: string | null };
export type AuthorizedSend = (id: string, lease: string, message: PushMessage, signal?: AbortSignal,
  onAccepted?: (count: number) => void) => Promise<SendPushResult>;
export type NotificationKind = 'free_end' | 'member_free' | 'chat_message';

export function createAuthorizedNotificationSender(options: {
  authorize(kind: NotificationKind, id: string, lease: string, after: string | null, signal: AbortSignal): Promise<Page>;
  deleteInvalid(target: DeliveryTarget, signal: AbortSignal): Promise<void>;
  accessToken?: string;
}) {
  return (kind: NotificationKind): AuthorizedSend => async (id, lease, message, signal, onAccepted) => {
    const timeout = AbortSignal.timeout(30_000);
    const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const failures = { temporary: 0, permanent: 0, unknown: 0 };
    let sent = 0;
    let cursor: string | null = null;
    do {
      active.throwIfAborted();
      let page: Page;
      try { page = await options.authorize(kind, id, lease, cursor, active); }
      catch { failures.unknown++; break; }
      active.throwIfAborted();
      if (!page.eligible) break;
      if (page.cursor !== null && cursor !== null && page.cursor <= cursor) throw new Error('Invalid delivery cursor');
      cursor = page.cursor;
      const targets = page.targets.filter(target => Expo.isExpoPushToken(target.token));
      failures.permanent += page.targets.length - targets.length;
      if (!targets.length) continue;
      if (message.expiration !== undefined && Date.now() >= message.expiration * 1000) break;
      let tickets: ExpoPushTicket[];
      try {
        // Expo's SDK retries HTTP 429 internally. Each transport attempt here
        // must be authorized by the DB, so use one request per authorized page.
        const response = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST', redirect: 'error', signal: active,
          headers: { 'content-type': 'application/json',
            ...(options.accessToken ? { authorization: 'Bearer ' + options.accessToken } : {}) },
          body: JSON.stringify(targets.map(target => ({ ...message, to: target.token, sound: 'default' }))),
        });
        if (response.status === 429) { failures.temporary += targets.length; continue; }
        if (!response.ok) throw new Error('Expo delivery request failed');
        const body = await response.json();
        if (!Array.isArray(body?.data) || body.data.length !== targets.length) throw new Error('Invalid Expo tickets');
        tickets = body.data;
      } catch {
        active.throwIfAborted();
        failures.unknown += targets.length;
        continue;
      }
      active.throwIfAborted();
      const invalid: DeliveryTarget[] = [];
      tickets.forEach((ticket, index) => {
        if (ticket?.status === 'ok') { sent++; onAccepted?.(sent); return; }
        const code = ticket?.status === 'error' ? ticket.details?.error : undefined;
        if (code === 'MessageRateExceeded') failures.temporary++;
        else if (code === 'DeviceNotRegistered') { failures.permanent++; invalid.push(targets[index]); }
        else if (code === 'MessageTooBig' || code === 'InvalidCredentials' || code === 'DeveloperError') failures.permanent++;
        else failures.unknown++;
      });
      for (const target of invalid) {
        active.throwIfAborted();
        try { await options.deleteInvalid(target, active); }
        catch { console.warn('[push] Registration cleanup unavailable'); }
      }
    } while (cursor !== null);
    if (!sent && !Object.values(failures).some(Boolean)) failures.permanent++;
    return { sent, failures, error: sent ? null : new PushSendError(failures) };
  };
}
