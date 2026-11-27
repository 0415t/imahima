import { isAuthApiError, isAuthSessionMissingError } from '@supabase/supabase-js';
import authStorage from './auth-storage';
import { createLogoutFlow } from './logout-flow';
import { createManagedLogout } from './managed-logout';
import { createDeviceRecoveryApi } from './device-recovery-api';
import { createSessionDataClient, supabase } from './supabase';
import { jwtSessionId } from './session-identity';

const project = process.env.EXPO_PUBLIC_SUPABASE_URL;
const apiUrl = process.env.EXPO_PUBLIC_API_URL;
const prefix = 'imahima:' + project;

async function session() {
    if (!supabase) throw new Error('Supabase is not configured');
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session;
}

async function revoke(current: { access_token: string }) {
    if (!supabase) throw new Error('Supabase is not configured');
    const { error } = await supabase.auth.admin.signOut(current.access_token, 'local');
    if (error && !isAuthSessionMissingError(error)
        && !(isAuthApiError(error) && error.code === 'session_not_found')) throw error;
}

async function signOut() {
    if (!supabase) throw new Error('Supabase is not configured');
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) throw error;
}

export const logoutFlow = createLogoutFlow({
    storage: authStorage,
    prefix,
    session,
    managed: createManagedLogout({
        storage: authStorage, prefix, session, revoke, api: createDeviceRecoveryApi(apiUrl, project),
        enableNew: Boolean(apiUrl && project && process.env.EXPO_PUBLIC_DEVICE_RECOVERY_ENABLED === 'true'),
        async clean(scope) {
            const current = await session();
            if (current) {
                if (current.user.id !== scope.userId || jwtSessionId(current.access_token) !== scope.sessionId) {
                    throw new Error('Logout session changed');
                }
                await signOut();
            }
        },
    }),
    resolveToken: async () => (await import('./push-notifications')).getCurrentDeviceToken(),
    async hasRegistrations(session) {
        const { data, error } = await createSessionDataClient(session.access_token)
            .from('user_device_tokens').select('id').eq('user_id', session.user.id).limit(1);
        if (error) throw error;
        return data.length > 0;
    },
    register: async (session, token) => (await import('./push-notifications')).registerDeviceToken(session, token),
    remove: async (session, token) => (await import('./push-notifications')).removeDeviceToken(session, token),
    revoke,
    signOut,
});
