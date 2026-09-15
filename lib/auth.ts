import type { AuthError, Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type SignUpResult = { user: User | null; error: AuthError | Error | null };
export type SignInResult = { session: Session | null; error: AuthError | Error | null };
export type SignOutResult = { error: AuthError | Error | null };
export type GetSessionResult = { session: Session | null; error: AuthError | Error | null };

/**
 * ユーザーを新規登録する。username は profiles テーブル自動挿入用のトリガーに渡される。
 * @param email メールアドレス
 * @param password パスワード
 * @param username ユーザー名
 * @returns 成功時は user、失敗時は error
 */
export async function signUpUser(email: string, password: string, username: string): Promise<SignUpResult> {
    try {
        const { data, error } = await supabase!.auth.signUp({
            email,
            password,
            options: {
                data: { username },
            },
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
 * メールアドレスとパスワードでサインインする。
 * @param email メールアドレス
 * @param password パスワード
 * @returns 成功時は session、失敗時は error
 */
export async function signInUser(email: string, password: string): Promise<SignInResult> {
    try {
        const { data, error } = await supabase!.auth.signInWithPassword({ email, password });

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
export async function signOutUser(): Promise<SignOutResult> {
    try {
        const { error } = await supabase!.auth.signOut();
        return { error };
    } catch (error) {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }
}

/**
 * 現在のセッション情報を取得する。
 * @returns 成功時は session、失敗時は error
 */
export async function getCurrentSession(): Promise<GetSessionResult> {
    try {
        const { data, error } = await supabase!.auth.getSession();

        if (error) {
            return { session: null, error };
        }

        return { session: data.session, error: null };
    } catch (error) {
        return { session: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
}
