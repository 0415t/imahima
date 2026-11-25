import { isAuthApiError, isAuthSessionMissingError } from '@supabase/supabase-js';
import authStorage from './auth-storage';
import { createLogoutFlow } from './logout-flow';
import { createSessionDataClient, supabase } from './supabase';

export const logoutFlow = createLogoutFlow({
    storage: authStorage,
    prefix: 'imahima:' + process.env.EXPO_PUBLIC_SUPABASE_URL,
    async session() {
        if (!supabase) throw new Error('Supabase is not configured');
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        return data.session;
    },
    resolveToken: async () => (await import('./push-notifications')).getCurrentDeviceToken(),
    async hasRegistrations(session) {
        const { data, error } = await createSessionDataClient(session.access_token)
            .from('user_device_tokens').select('id').eq('user_id', session.user.id).limit(1);
        if (error) throw error;
        return data.length > 0;
    },
    register: async (session, token) => (await import('./push-notifications')).registerDeviceToken(session, token),
    remove: async (session, token) => (await import('./push-notifications')).removeDeviceToken(session, token),
    async revoke(session) {
        if (!supabase) throw new Error('Supabase is not configured');
        const { error } = await supabase.auth.admin.signOut(session.access_token, 'local');
        // This explicit-JWT endpoint maps session_not_found to AuthSessionMissingError in Auth JS.
        if (error && !isAuthSessionMissingError(error)
            && !(isAuthApiError(error) && error.code === 'session_not_found')) throw error;
    },
    async signOut() {
        if (!supabase) throw new Error('Supabase is not configured');
        const { error } = await supabase.auth.signOut({ scope: 'local' });
        if (error) throw error;
    },
});
