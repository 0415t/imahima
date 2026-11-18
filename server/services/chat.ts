import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatDependencies } from '../chat';
import type { GroupResult } from '../groups';

export function chatService(client: SupabaseClient, identity: Pick<ChatDependencies, 'getUserId' | 'isMember'>): ChatDependencies {
  const names = { send: 'chat_send_message', delete: 'chat_delete_message', history: 'chat_list_messages', events: 'chat_list_message_events' };
  return {
    ...identity,
    execute: async (operation, actor, args) => {
      const { data, error } = await client.rpc(names[operation], { ...args, p_actor: actor });
      if (error) throw new Error('Chat operation failed');
      return data as GroupResult;
    },
  };
}
