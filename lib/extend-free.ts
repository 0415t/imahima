import { supabase } from './supabase';
import { notifyAvailabilityChanged } from './availability-events';
import { createExtendClient, type ExtendFreeResult } from './free-end-action';
import { logoutFlow } from './logout';
import { jwtSessionId } from './session-identity';
export type { ExtendFreeResult } from './free-end-action';

const apiUrl = process.env.EXPO_PUBLIC_API_URL;

function postExtend(notification?: { receivedAt?: number }) {
    const revision = logoutFlow.revision();
    let original: { userId: string; sessionId: string | undefined } | undefined;
    const canUse = () => notification
        ? logoutFlow.canUseNotification(notification.receivedAt)
        : logoutFlow.canUseSession();
    return createExtendClient({
        apiUrl: supabase ? apiUrl : undefined,
        getAccessToken: async () => {
            if (!supabase || !await canUse()) return null;
            const { data, error } = await supabase.auth.getSession();
            if (error || !data.session || !await canUse()
                || revision !== logoutFlow.revision()) return null;
            original = { userId: data.session.user.id, sessionId: jwtSessionId(data.session.access_token) };
            return data.session.access_token;
        },
        canUseToken: async (token) => {
            if (!supabase || !await canUse()) return false;
            const { data, error } = await supabase.auth.getSession();
            const session = data.session;
            if (error || !session || !original || session.user.id !== original.userId) return false;
            const sameSession = original.sessionId
                ? jwtSessionId(session.access_token) === original.sessionId
                : session.access_token === token;
            return sameSession && revision === logoutFlow.revision();
        },
        fetch: (...args) => fetch(...args),
        onChanged: notifyAvailabilityChanged,
    });
}

/**
 * 暇状態を30分延長する（アプリ内ボタン用）。
 */
export async function extendFree(): Promise<ExtendFreeResult> {
    return postExtend()('/profiles/me/is-free/extend');
}

/**
 * 終了5分前通知の「30分延長」アクションから延長する。
 * claimIdをDB側で照合し、通知時の終了予定と現在の終了予定が一致する場合のみ延長される
 * （同じ通知からの二重延長はDB側で防止される）。
 */
export async function extendFreeFromNotification(notificationId: string, receivedAt?: number): Promise<ExtendFreeResult> {
    return postExtend({ receivedAt })('/profiles/me/is-free/extend-from-notification', { claim_id: notificationId });
}
