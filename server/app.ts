import express, { type ErrorRequestHandler, type Router } from 'express';
import { groupRouter, type GroupDependencies } from './groups';
import { chatRouter, isChatPath, type ChatDependencies } from './chat';
import { requestDeadline } from './timeouts';

export type AvailabilityDependencies = {
  getUserId: (accessToken: string) => Promise<{ userId: string | null; error: unknown | null }>;
  authenticateNotificationSession?: (accessToken: string) => Promise<{
    userId: string | null; sessionId?: string; status: 200 | 401 | 503;
  }>;
  toggleIsFree: (userId: string) => Promise<{ isFree: boolean | null; error: unknown | null }>;
  setIsFree: (
    userId: string,
    newIsFree: boolean,
    durationMinutes?: number
  ) => Promise<{ isFree: boolean | null; freeUntil: string | null; error: unknown | null }>;
  extendIsFree: (
    userId: string
  ) => Promise<{ isFree: boolean | null; freeUntil: string | null; error: unknown | null }>;
  extendIsFreeFromNotification: (
    userId: string,
    claimId: string,
    sessionId?: string
  ) => Promise<{ isFree: boolean | null; freeUntil: string | null; error: unknown | null; status?: 401 | 503 }>;
};

export function createApp(
  dependencies: AvailabilityDependencies,
  groups?: GroupDependencies,
  chat?: ChatDependencies,
  requestTimeoutMs?: number,
  deviceVerifier?: Router,
  logoutRecovery?: Router
) {
  const app = express();

  app.use(requestDeadline(requestTimeoutMs));
  app.use('/device-recovery/recovery', logoutRecovery ?? ((_request, response) => {
    response.set('Cache-Control', 'no-store').status(503).json({ error: 'Logout recovery request failed' });
  }));
  if (deviceVerifier) app.use('/device-recovery', deviceVerifier);
  app.use(express.json());
  app.use((_request, response, next) => { if (!response.headersSent && !response.destroyed) next(); });
  if (chat) app.use('/groups', chatRouter(chat));
  if (groups) app.use('/groups', groupRouter(groups));


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

  app.post('/profiles/me/is-free/extend-from-notification', async (request, response) => {
    const authorization = request.get('authorization');
    const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!bearerToken) {
      response.status(401).json({ error: 'Bearer token is required' });
      return;
    }

    const claimId = request.body?.claim_id;
    if (typeof claimId !== 'string' || claimId.length === 0) {
      response.status(400).json({ error: 'claim_id (string) is required' });
      return;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claimId)) {
      response.status(400).json({ error: 'claim_id must be a UUID' });
      return;
    }

    try {
      const identity = await dependencies.authenticateNotificationSession?.(bearerToken);
      if (identity?.status !== 200 || !identity.userId) {
        const status = identity?.status === 401 ? 401 : 503;
        response.status(status).json({ error: status === 401 ? 'Invalid or expired access token' : 'Session verification unavailable' });
        return;
      }

      const { isFree, freeUntil, error: extendError, status: extendStatus } = await dependencies.extendIsFreeFromNotification(
        identity.userId,
        claimId,
        identity.sessionId
      );
      if (extendStatus) {
        response.status(extendStatus).json({ error: extendStatus === 401
          ? 'Invalid or expired access token' : 'Session verification unavailable' });
        return;
      }

      if (extendError) {
        let errorMessage: string;
        if (extendError instanceof Error) {
          errorMessage = extendError.message;
        } else if (typeof extendError === 'object' && extendError !== null && 'message' in extendError) {
          errorMessage = String(extendError.message);
        } else {
          errorMessage = String(extendError);
        }

        if (errorMessage === 'Cannot extend: notification claim is processing') {
          response.status(409).json({ error: errorMessage, code: 'notification-processing' });
          return;
        }
        // 延長できない状態は全て409（厳密なメッセージ一致）
        const conflictMessages = [
          'Cannot extend: not in an active timed free state',
          'Cannot extend: notification claim not found',
          'Cannot extend: notification claim is not sent',
          'Cannot extend: free_until has changed since notification',
        ];
        if (conflictMessages.includes(errorMessage)) {
          response.status(409).json({ error: errorMessage });
          return;
        }
        console.error('profiles.is_free extend-from-notification failed:', errorMessage);
        response.status(500).json({ error: 'Unable to extend availability' });
        return;
      }

      if (typeof isFree !== 'boolean') {
        response.status(404).json({ error: 'Profile not found' });
        return;
      }

      response.json({ is_free: isFree, free_until: freeUntil });
    } catch (error) {
      console.error('profiles.is_free extend-from-notification request failed:', error);
      response.status(500).json({ error: 'Unable to extend availability' });
    }
  });

  const groupParseError: ErrorRequestHandler = (error, request, response, next) => {
    if (response.headersSent || response.destroyed) return;
    if (!/^\/groups(?:\/|$)/i.test(request.path)) { next(error); return; }
    const status = error?.status === 413 ? 413 : error?.status === 400 ? 400 : 503;
    if (chat && isChatPath(request.path)) {
      response.set('Cache-Control', 'no-store').status(status).json({
        error: status === 413 ? 'Request too large' : status === 400 ? 'Invalid JSON body' : 'Chat service unavailable',
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 400 ? 'INVALID_INPUT' : 'CHAT_UNAVAILABLE',
      });
      return;
    }
    response.set('Cache-Control', 'no-store').status(status).json({
      error: status === 413 ? 'Request too large' : status === 400 ? 'Invalid JSON body' : 'Group service unavailable',
    });
  };
  app.use(groupParseError);
  return app;
}
