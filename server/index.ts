import 'dotenv/config';
import { createApp } from './app';
import { serverSupabase } from './services/supabase';

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
    setIsFree: async (userId, isFree) => {
    const { data, error } = await serverSupabase.rpc('set_profile_is_free', {
      target_profile_id: userId,
      new_is_free: isFree,
    });
    const row = Array.isArray(data) ? data[0] : data;
    return { isFree: row?.is_free ?? null, freeUntil: row?.free_until ?? null, error };
  },
});
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
