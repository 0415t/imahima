import 'dotenv/config';
import { serverSupabase } from './services/supabase';
import { createApp } from './app';

const app = createApp({
  getUserId: async (accessToken) => {
    const { data, error } = await serverSupabase.auth.getUser(accessToken);
    return { userId: data.user?.id ?? null, error };
  },
  toggleIsFree: async (userId) => {
    const { data, error } = await serverSupabase.rpc('toggle_profile_is_free', {
      target_profile_id: userId,
    });
    return { isFree: data, error };
  },
});
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
