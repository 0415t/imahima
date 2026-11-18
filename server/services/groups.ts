import type { SupabaseClient } from '@supabase/supabase-js';
import type { GroupDependencies, GroupResult } from '../groups';

export function groupService(client: SupabaseClient, getUserId: GroupDependencies['getUserId']): GroupDependencies {
  return {
    getUserId,
    rateSecret: process.env.GROUP_RATE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY!,
    isMember: async (userId, roomId) => {
      const { data, error } = await client.from('room_members').select('room_id')
        .eq('room_id', roomId).eq('user_id', userId).maybeSingle();
      if (error) throw new Error('Membership query failed');
      return Boolean(data);
    },
    consumeRate: async (key, maximum) => {
      const { data, error } = await client.rpc('group_mvp_consume_rate', { p_key: key, p_maximum: maximum });
      if (error) throw new Error('Rate limiter unavailable');
      return data === true;
    },
    execute: async (operation, userId, args) => {
      const { data, error } = await client.rpc('group_mvp_execute', {
        p_operation: operation, p_actor: userId, p_args: args,
      });
      if (error) throw new Error('Group operation failed');
      return data as GroupResult;
    },
  };
}
