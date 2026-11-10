import { supabase } from './supabase';
import { notifyAvailabilityChanged } from './availability-events';
import { createExtendClient, type ExtendFreeResult } from './free-end-action';
export type { ExtendFreeResult } from './free-end-action';

const apiUrl = process.env.EXPO_PUBLIC_API_URL;

const postExtend = createExtendClient({
    apiUrl: supabase ? apiUrl : undefined,
    getAccessToken: async () => {
        if (!supabase) return null;
        const { data, error } = await supabase.auth.getSession();
        if (error || !data.session) return null;
        if (data.session.expires_at && data.session.expires_at <= Date.now() / 1000 + 30) {
            const refreshed = await supabase.auth.refreshSession();
            return refreshed.error ? null : refreshed.data.session?.access_token ?? null;
        }
        return data.session.access_token;
    },
    fetch: (...args) => fetch(...args),
    onChanged: notifyAvailabilityChanged,
});

/**
 * 暇状態を30分延長する（アプリ内ボタン用）。
 */
export async function extendFree(): Promise<ExtendFreeResult> {
    return postExtend('/profiles/me/is-free/extend');
}

/**
 * 終了5分前通知の「30分延長」アクションから延長する。
 * claimIdをDB側で照合し、通知時の終了予定と現在の終了予定が一致する場合のみ延長される
 * （同じ通知からの二重延長はDB側で防止される）。
 */
export async function extendFreeFromNotification(notificationId: string): Promise<ExtendFreeResult> {
    return postExtend('/profiles/me/is-free/extend-from-notification', { claim_id: notificationId });
}
