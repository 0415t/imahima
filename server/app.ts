import express from 'express';

export type AvailabilityDependencies = {
  getUserId: (accessToken: string) => Promise<{ userId: string | null; error: unknown | null }>;
  toggleIsFree: (userId: string) => Promise<{ isFree: boolean | null; error: unknown | null }>;
  setIsFree: (
    userId: string,
    newIsFree: boolean
  ) => Promise<{ isFree: boolean | null; freeUntil: string | null; error: unknown | null }>;
};

export function createApp(dependencies: AvailabilityDependencies) {
  const app = express();

  app.use(express.json());

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

    try {
      const { userId, error: authError } = await dependencies.getUserId(bearerToken);

      if (authError || !userId) {
        response.status(401).json({ error: 'Invalid or expired access token' });
        return;
      }

      const { isFree, freeUntil, error: setError } = await dependencies.setIsFree(
        userId,
        requestedIsFree
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

      // 有効判定: is_free = true AND free_until > now()
      const effectiveIsFree =
        isFree && freeUntil !== null && new Date(freeUntil).getTime() > Date.now();

      response.json({ is_free: effectiveIsFree, free_until: freeUntil });
    } catch (error) {
      console.error('profiles.is_free set request failed:', error);
      response.status(500).json({ error: 'Unable to update availability' });
    }
  });

  return app;
}
