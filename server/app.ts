import express from 'express';

export type AvailabilityDependencies = {
  getUserId: (accessToken: string) => Promise<{ userId: string | null; error: unknown | null }>;
  toggleIsFree: (userId: string) => Promise<{ isFree: boolean | null; error: unknown | null }>;
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

  return app;
}
