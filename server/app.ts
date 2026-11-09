import express from 'express';

export type AvailabilityDependencies = {
  getUserId: (accessToken: string) => Promise<{ userId: string | null; error: unknown | null }>;
  toggleIsFree: (userId: string) => Promise<{ isFree: boolean | null; error: unknown | null }>;
  setIsFree: (
    userId: string,
    newIsFree: boolean,
    durationMinutes?: number
  ) => Promise<{ isFree: boolean | null; freeUntil: string | null; error: unknown | null }>;
  extendIsFree: (
    userId: string
  ) => Promise<{ isFree: boolean | null; freeUntil: string | null; error: unknown | null }>;
};

export type NotificationDependencies = {
  getDeviceTokens: (userId: string) => Promise<{ tokens: string[]; error: unknown | null }>;
  sendPushNotifications: (
    tokens: string[],
    message: { title: string; body: string }
  ) => Promise<{ sent: number; error: unknown | null }>;
};

const TEST_NOTIFICATION_COOLDOWN_MS = 60_000;

export function createApp(
  dependencies: AvailabilityDependencies,
  notifications?: NotificationDependencies
) {
  const app = express();

  app.use(express.json());

  const lastTestNotificationAt = new Map<string, number>();

  app.get('/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.post('/profiles/me/is-free/toggle', async (request, response) => {
    const authorization = request.get('authorization');
    const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!bearerToken) {
      response.status(401).json({ error: 'Bearer token is required' });
      return;
    }

    try {
      const { userId, error: authError } = await dependencies.getUserId(bearerToken);

      if (authError || !userId) {
        response.status(401).json({ error: 'Invalid or expired access token' });
        return;
      }

      const { isFree, error: toggleError } = await dependencies.toggleIsFree(userId);

      if (toggleError) {
        console.error('profiles.is_free toggle failed:', toggleError);
        response.status(500).json({ error: 'Unable to update availability' });
        return;
      }

      if (typeof isFree !== 'boolean') {
        response.status(404).json({ error: 'Profile not found' });
        return;
      }

      response.json({ is_free: isFree });
    } catch (error) {
      console.error('profiles.is_free toggle request failed:', error);
      response.status(500).json({ error: 'Unable to update availability' });
    }
  });

  app.put('/profiles/me/is-free', async (request, response) => {
    const authorization = request.get('authorization');
    const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!bearerToken) {
      response.status(401).json({ error: 'Bearer token is required' });
      return;
    }

    const requestedIsFree = request.body?.is_free;
    if (typeof requestedIsFree !== 'boolean') {
      response.status(400).json({ error: 'is_free (boolean) is required' });
      return;
    }

    const durationMinutes = request.body?.duration_minutes;
    if (durationMinutes !== undefined && durationMinutes !== null && ![30, 60, 120, 180].includes(durationMinutes)) {
      response.status(400).json({ error: 'duration_minutes must be one of: 30, 60, 120, 180, or null' });
      return;
    }

    try {
      const { userId, error: authError } = await dependencies.getUserId(bearerToken);

      if (authError || !userId) {
        response.status(401).json({ error: 'Invalid or expired access token' });
        return;
      }

      const { isFree, freeUntil, error: setError } = await dependencies.setIsFree(
        userId,
        requestedIsFree,
        durationMinutes ?? null
      );

      if (setError) {
        console.error('profiles.is_free set failed:', setError);
        response.status(500).json({ error: 'Unable to update availability' });
        return;
      }

      if (typeof isFree !== 'boolean') {
        response.status(404).json({ error: 'Profile not found' });
        return;
      }

      // 有効判定: is_free = true AND (free_until IS NULL OR free_until > now())
      const effectiveIsFree =
        isFree && (freeUntil === null || new Date(freeUntil).getTime() > Date.now());

      response.json({ is_free: effectiveIsFree, free_until: freeUntil });
    } catch (error) {
      console.error('profiles.is_free set request failed:', error);
      response.status(500).json({ error: 'Unable to update availability' });
    }
  });

  app.post('/profiles/me/is-free/extend', async (request, response) => {
    const authorization = request.get('authorization');
    const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!bearerToken) {
      response.status(401).json({ error: 'Bearer token is required' });
      return;
    }

    try {
      const { userId, error: authError } = await dependencies.getUserId(bearerToken);

      if (authError || !userId) {
        response.status(401).json({ error: 'Invalid or expired access token' });
        return;
      }

      const { isFree, freeUntil, error: extendError } = await dependencies.extendIsFree(userId);

      if (extendError) {
        // OFF・無期限ON・期限切れの場合は409（厳密なメッセージ一致）
        let errorMessage: string;
        if (extendError instanceof Error) {
          errorMessage = extendError.message;
        } else if (typeof extendError === 'object' && extendError !== null && 'message' in extendError) {
          errorMessage = String(extendError.message);
        } else {
          errorMessage = String(extendError);
        }

        if (errorMessage === 'Cannot extend: not in an active timed free state') {
          response.status(409).json({ error: 'Cannot extend: not in an active timed free state' });
          return;
        }
        console.error('profiles.is_free extend failed:', errorMessage);
        response.status(500).json({ error: 'Unable to extend availability' });
        return;
      }

      if (typeof isFree !== 'boolean') {
        response.status(404).json({ error: 'Profile not found' });
        return;
      }

      response.json({ is_free: isFree, free_until: freeUntil });
    } catch (error) {
      console.error('profiles.is_free extend request failed:', error);
      response.status(500).json({ error: 'Unable to extend availability' });
    }
  });

  app.post('/notifications/test', async (request, response) => {
    const authorization = request.get('authorization');
    const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!bearerToken) {
      response.status(401).json({ error: 'Bearer token is required' });
      return;
    }

    if (!notifications) {
      response.status(503).json({ error: 'Notifications are not configured' });
      return;
    }

    try {
      const { userId, error: authError } = await dependencies.getUserId(bearerToken);

      if (authError || !userId) {
        response.status(401).json({ error: 'Invalid or expired access token' });
        return;
      }

      // 認証済みユーザー単位のレート制限（連続送信防止）
      const now = Date.now();
      const lastSentAt = lastTestNotificationAt.get(userId);
      if (lastSentAt !== undefined && now - lastSentAt < TEST_NOTIFICATION_COOLDOWN_MS) {
        response.status(429).json({ error: 'Please wait before sending another test notification' });
        return;
      }

      // 宛先は認証ユーザー自身のトークンのみ。ボディの宛先指定は一切受け付けない
      const { tokens, error: tokensError } = await notifications.getDeviceTokens(userId);

      if (tokensError) {
        console.error('device tokens fetch failed:', tokensError);
        response.status(500).json({ error: 'Unable to fetch device tokens' });
        return;
      }

      if (tokens.length === 0) {
        response.json({ sent: 0, message: 'No registered devices' });
        return;
      }

      // 送信を試みる場合のみレート制限を消費する
      lastTestNotificationAt.set(userId, now);
      const clearRateLimit = () => {
        if (lastTestNotificationAt.get(userId) === now) {
          lastTestNotificationAt.delete(userId);
        }
      };

      try {
        const { sent, error: sendError } = await notifications.sendPushNotifications(tokens, {
          title: 'imahima テスト通知',
          body: 'サーバーからのテスト通知です。',
        });

        if (sendError) {
          clearRateLimit();
          response.status(502).json({ error: 'Unable to send notification' });
          return;
        }

        response.json({ sent });
      } catch (error) {
        clearRateLimit();
        throw error;
      }
    } catch (error) {
      console.error('test notification request failed:', error);
      response.status(500).json({ error: 'Unable to send notification' });
    }
  });

  return app;
}
