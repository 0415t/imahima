import 'dotenv/config';
import { serverSupabase } from './services/supabase';
import { createApp } from './app';
import { groupService } from './services/groups';
import { chatService } from './services/chat';

const getUserId = async (accessToken: string) => {
  const { data, error } = await serverSupabase.auth.getUser(accessToken);
  return { userId: data.user?.id ?? null, error };
};

const groups = groupService(serverSupabase, getUserId);
const app = createApp({
  getUserId,
  toggleIsFree: async (userId) => {
    const { data, error } = await serverSupabase.rpc('toggle_profile_is_free', {
      target_profile_id: userId,
    });
    return { isFree: data, error };
  },
}, groups, chatService(serverSupabase, groups));
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
