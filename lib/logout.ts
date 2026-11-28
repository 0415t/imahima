import { isAuthApiError, isAuthSessionMissingError } from '@supabase/supabase-js';
import authStorage from './auth-storage';
import { createLogoutFlow } from './logout-flow';
import { createManagedLogout } from './managed-logout';
import { createDeviceRecoveryApi } from './device-recovery-api';
import { supabase } from './supabase';
import { jwtSessionId } from './session-identity';

const project = process.env.EXPO_PUBLIC_SUPABASE_URL;
const apiUrl = process.env.EXPO_PUBLIC_API_URL;
const prefix = 'imahima:' + project;

async function session(recover = false) {
    if (!supabase) throw new Error('Supabase is not configured');
    let { data, error } = await supabase.auth.getSession();
    const rejectedRefresh = isAuthApiError(error) && [
        'session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used',
    ].includes(error.code ?? '');
    if (recover && (isAuthSessionMissingError(error) || rejectedRefresh)) {
        // The SDK may have cleared local storage while returning the refresh error.
        // A missing local session is not proof of server revocation. The saved
        // logout checkpoint still decides whether cleanup is allowed.
        ({ data, error } = await supabase.auth.getSession());
    }
    if (error) throw error;
    return data.session;
}

const recoverySession = () => session(true);

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
        storage: authStorage, prefix, session, recoverySession, revoke, api: createDeviceRecoveryApi(apiUrl, project),
        async clean(scope) {
            const current = await recoverySession();
            if (current) {
                if (current.user.id !== scope.userId || jwtSessionId(current.access_token) !== scope.sessionId) {
                    throw new Error('Logout session changed');
                }
                await signOut();
            }
        },
    }),
});
