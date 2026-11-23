export const FREE_END_CATEGORY = 'free_end';
export const EXTEND_30_ACTION = 'extend_30';

export type ExtendFreeResult =
  | { ok: true; freeUntil: string }
  | { ok: false; reason: 'not-configured' | 'not-authenticated' | 'conflict' | 'server-error' };

export function extractNotificationId(response: unknown): string | null {
  if (!response || typeof response !== 'object' || !('actionIdentifier' in response) ||
      response.actionIdentifier !== EXTEND_30_ACTION || !('notification' in response)) return null;
  const notification = response.notification;
  if (!notification || typeof notification !== 'object' || !('request' in notification)) return null;
  const request = notification.request;
  if (!request || typeof request !== 'object' || !('content' in request)) return null;
  const content = request.content;
  if (!content || typeof content !== 'object' || !('data' in content)) return null;
  const data = content.data;
  if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'free_end' ||
      !('notificationId' in data) || typeof data.notificationId !== 'string' || !data.notificationId.trim()) return null;
  return data.notificationId;
}

export function notificationReceivedAt(response: unknown): number | undefined {
  if (!response || typeof response !== 'object' || !('notification' in response)) return;
  const notification = response.notification;
  if (!notification || typeof notification !== 'object' || !('date' in notification)) return;
  const date = notification.date;
  // Expo uses seconds on iOS and milliseconds on Android.
  if (typeof date === 'number' && Number.isFinite(date)) return date < 1e12 ? date * 1000 : date;
  if (date instanceof Date && Number.isFinite(date.getTime())) return date.getTime();
}

// 同じJS実行環境内の同時応答をまとめる。プロセスをまたぐ二重実行防止は既存DB RPCが担う。
export function createFreeEndActionHandler(extend: (id: string, receivedAt?: number) => Promise<ExtendFreeResult>) {
  const pending = new Map<string, Promise<ExtendFreeResult>>();
  return (response: unknown): Promise<ExtendFreeResult | null> => {
    const id = extractNotificationId(response);
    if (!id) return Promise.resolve(null);
    const current = pending.get(id);
    if (current) return current;
    const operation = Promise.resolve().then(() => extend(id, notificationReceivedAt(response)))
      .catch((): ExtendFreeResult => ({ ok: false, reason: 'server-error' }))
      .finally(() => pending.delete(id));
    pending.set(id, operation);
    return operation;
  };
}

export function createExtendClient(options: {
  apiUrl?: string;
  getAccessToken: () => Promise<string | null>;
  canUseToken?: (token: string) => Promise<boolean>;
  fetch: typeof fetch;
  onChanged: () => void;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  return async (path: string, body?: Record<string, unknown>): Promise<ExtendFreeResult> => {
    if (!options.apiUrl) return { ok: false, reason: 'not-configured' };
    try {
      const token = await options.getAccessToken();
      if (!token) return { ok: false, reason: 'not-authenticated' };
      const retryDelays = [250, 500, 1000];
      for (let attempt = 0; ; attempt += 1) {
        if (options.canUseToken && !await options.canUseToken(token)) return { ok: false, reason: 'not-authenticated' };
        const response = await options.fetch(`${options.apiUrl.replace(/\/$/, '')}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (options.canUseToken && !await options.canUseToken(token)) return { ok: false, reason: 'not-authenticated' };
        if (response.status === 401) return { ok: false, reason: 'not-authenticated' };
        if (response.status === 409) {
          const errorBody: unknown = await response.json().catch(() => null);
          if (path === '/profiles/me/is-free/extend-from-notification' && errorBody &&
              typeof errorBody === 'object' && 'code' in errorBody && errorBody.code === 'notification-processing') {
            if (attempt >= retryDelays.length) return { ok: false, reason: 'server-error' };
            // Each request finishes its DB transaction before waiting; no row locks are held.
            await (options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(retryDelays[attempt]);
            continue;
          }
          // 別ハンドラで処理済みの場合もDBから再取得する。
          if (options.canUseToken && !await options.canUseToken(token)) return { ok: false, reason: 'not-authenticated' };
          options.onChanged();
          return { ok: false, reason: 'conflict' };
        }
        if (!response.ok) return { ok: false, reason: 'server-error' };
        const json = await response.json();
        if (json?.is_free !== true || typeof json.free_until !== 'string' || !Number.isFinite(Date.parse(json.free_until))) {
          return { ok: false, reason: 'server-error' };
        }
        if (options.canUseToken && !await options.canUseToken(token)) return { ok: false, reason: 'not-authenticated' };
        options.onChanged();
        return { ok: true, freeUntil: json.free_until };
      }
    } catch {
      return { ok: false, reason: 'server-error' };
    }
  };
}
