import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = hasSupabaseConfig
    ? createClient(supabaseUrl!, supabaseAnonKey!, {
          auth: {
              autoRefreshToken: false,
              persistSession: true,
              detectSessionInUrl: false,
              storage: AsyncStorage,
          },
      })
    : null;