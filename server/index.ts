import 'dotenv/config';
import express from 'express';
import { serverSupabase } from './services/supabase';

const app = express();
const port = Number(process.env.PORT ?? 3000);

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
    const { data: authData, error: authError } = await serverSupabase.auth.getUser(bearerToken);

    if (authError || !authData.user) {
      response.status(401).json({ error: 'Invalid or expired access token' });
      return;
    }

    const { data: isFree, error: toggleError } = await serverSupabase.rpc('toggle_profile_is_free', {
      target_profile_id: authData.user.id,
    });

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

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
