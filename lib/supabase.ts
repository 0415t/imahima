import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

export function createSupabaseClient(url: string, anonKey: string) {
    return createClient(url, anonKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: true,
            detectSessionInUrl: false,
            storage: AsyncStorage,
        },
    });
}

export const supabase = hasSupabaseConfig
    ? createSupabaseClient(supabaseUrl!, supabaseAnonKey!)
    : null;