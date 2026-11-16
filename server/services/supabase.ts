import { createClient } from '@supabase/supabase-js';
import { timeoutFetch } from '../timeouts';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

export const serverSupabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  global: { fetch: timeoutFetch() },
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
