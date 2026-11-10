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

// 同じJS実行環境内の同時応答をまとめる。プロセスをまたぐ二重実行防止は既存DB RPCが担う。
export function createFreeEndActionHandler(extend: (id: string) => Promise<ExtendFreeResult>) {
  const pending = new Map<string, Promise<ExtendFreeResult>>();
  return (response: unknown): Promise<ExtendFreeResult | null> => {
    const id = extractNotificationId(response);
    if (!id) return Promise.resolve(null);
    const current = pending.get(id);
    if (current) return current;
    const operation = Promise.resolve().then(() => extend(id))
      .catch((): ExtendFreeResult => ({ ok: false, reason: 'server-error' }))
      .finally(() => pending.delete(id));
    pending.set(id, operation);
    return operation;
  };
}

export function createExtendClient(options: {
  apiUrl?: string;
  getAccessToken: () => Promise<string | null>;
  fetch: typeof fetch;
  onChanged: () => void;
}) {
  return async (path: string, body?: Record<string, unknown>): Promise<ExtendFreeResult> => {
    if (!options.apiUrl) return { ok: false, reason: 'not-configured' };
    try {
      const token = await options.getAccessToken();
      if (!token) return { ok: false, reason: 'not-authenticated' };
      const response = await options.fetch(`${options.apiUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 401) return { ok: false, reason: 'not-authenticated' };
      if (response.status === 409) {
        // 別ハンドラで処理済みの場合もDBから再取得する。
        options.onChanged();
        return { ok: false, reason: 'conflict' };
      }
      if (!response.ok) return { ok: false, reason: 'server-error' };
      const json = await response.json();
      if (json?.is_free !== true || typeof json.free_until !== 'string' || !Number.isFinite(Date.parse(json.free_until))) {
        return { ok: false, reason: 'server-error' };
      }
      options.onChanged();
      return { ok: true, freeUntil: json.free_until };
    } catch {
      return { ok: false, reason: 'server-error' };
    }
  };
}
