import type { AuthError, Session, User } from '@supabase/supabase-js';
import { logoutFlow } from './logout';
import { supabase } from './supabase';

function requireSupabase() {
    if (!supabase) {
        throw new Error(
            'Supabase の接続設定(EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY)がアプリに含まれていません',
        );
    }
    return supabase;
}

export type SignUpResult = { user: User | null; error: AuthError | Error | null };
export type SignInResult = { session: Session | null; error: AuthError | Error | null };
export type SignOutResult = { error: AuthError | Error | null };
export type GetSessionResult = { session: Session | null; error: AuthError | Error | null };

/**
 * メールアドレスとパスワードでユーザーを新規登録する。
 * @param email メールアドレス
 * @param password パスワード
 * @returns 成功時は user、失敗時は error
 */
export async function signUpUser(email: string, password: string): Promise<SignUpResult> {
    try {
        const { data, error } = await logoutFlow.authenticate(() => requireSupabase().auth.signUp({
            email,
            password,
        }));

        if (error) {
            return { user: null, error };
        }

        return { user: data.user, error: null };
    } catch (error) {
        return { user: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
}

/**
 * メールアドレスとパスワードでサインインする。
 * @param email メールアドレス
 * @param password パスワード
 * @returns 成功時は session、失敗時は error
 */
export async function signInUser(email: string, password: string): Promise<SignInResult> {
    try {
        const { data, error } = await logoutFlow.authenticate(() =>
            requireSupabase().auth.signInWithPassword({ email, password }));

        if (error) {
            return { session: null, error };
        }

        return { session: data.session, error: null };
    } catch (error) {
        return { session: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
}

/**
 * 現在のユーザーをサインアウトする。
 * @returns 失敗時は error、成功時は null
 */
export function signOutUser(): Promise<SignOutResult> {
    return logoutFlow.signOut();
}

/**
 * 現在のセッション情報を取得する。
 * @returns 成功時は session、失敗時は error
 */
export async function getCurrentSession(): Promise<GetSessionResult> {
    try {
        const client = requireSupabase();
        const revision = logoutFlow.revision();
        const availability = await logoutFlow.sessionAvailability();
        if (availability === 'read-failed') throw new Error('Session state unavailable');
        if (availability !== 'ready') return { session: null, error: null };
        const { data, error } = await client.auth.getSession();
        const after = await logoutFlow.sessionAvailability();
        if (after === 'read-failed') throw new Error('Session state unavailable');
        if (after !== 'ready' || revision !== logoutFlow.revision()) {
            return { session: null, error: null };
        }

        if (error) {
            return { session: null, error };
        }

        return { session: data.session, error: null };
    } catch (error) {
        return { session: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
}
