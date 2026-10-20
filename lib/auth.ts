import type { AuthError, Session, User } from '@supabase/supabase-js';
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
 * メールアドレスとパスワードでユーザーを新規登録する、E
 * @param email メールアドレス
 * @param password パスワーチE
 * @returns 成功時�E user、失敗時は error
 */
export async function signUpUser(email: string, password: string): Promise<SignUpResult> {
    try {
        const { data, error } = await requireSupabase().auth.signUp({
            email,
            password,
        });

        if (error) {
            return { user: null, error };
        }

        return { user: data.user, error: null };
    } catch (error) {
        return { user: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
}

/**
 * メールアドレスとパスワードでサインインする、E
 * @param email メールアドレス
 * @param password パスワーチE
 * @returns 成功時�E session、失敗時は error
 */
export async function signInUser(email: string, password: string): Promise<SignInResult> {
    try {
        const { data, error } = await requireSupabase().auth.signInWithPassword({ email, password });

        if (error) {
            return { session: null, error };
        }

        return { session: data.session, error: null };
    } catch (error) {
        return { session: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
}

/**
 * 現在のユーザーをサインアウトする、E
 * @returns 失敗時は error、�E功時は null
 */
export async function signOutUser(): Promise<SignOutResult> {
    try {
        const { error } = await requireSupabase().auth.signOut();
        return { error };
    } catch (error) {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }
}

/**
 * 現在のセチE��ョン惁E��を取得する、E
 * @returns 成功時�E session、失敗時は error
 */
export async function getCurrentSession(): Promise<GetSessionResult> {
    try {
        const { data, error } = await requireSupabase().auth.getSession();

        if (error) {
            return { session: null, error };
        }

        return { session: data.session, error: null };
    } catch (error) {
        return { session: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
}
