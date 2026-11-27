import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { EXTEND_30_ACTION, FREE_END_CATEGORY } from './free-end-action';
import type { LogoutSession } from './logout-flow';
import { createSessionDataClient } from './supabase';

Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
    }),
});

// 終了5分前通知のカテゴリ（「30分延長」アクション付き）を登録する
export async function registerNotificationCategories(): Promise<void> {
    if (Platform.OS === 'web') {
        return;
    }

    await Notifications.setNotificationCategoryAsync(FREE_END_CATEGORY, [
        {
            identifier: EXTEND_30_ACTION,
            buttonTitle: '30分延長',
            options: {
                opensAppToForeground: Platform.OS === 'ios',
            },
        },
    ]);
}

export async function registerForPushNotificationsAsync(): Promise<string | null> {
    if (Platform.OS === 'web') {
        console.log('[push] web ではスキップします');
        return null;
    }

    if (!Device.isDevice) {
        console.log('[push] 実機ではないためスキップします');
        return null;
    }

    if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('default', {
            name: 'default',
            importance: Notifications.AndroidImportance.MAX,
        });
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
    }

    console.log('[push] permission status:', finalStatus);

    if (finalStatus !== 'granted') {
        return null;
    }

    return getCurrentDeviceToken();
}

// Resolve a legacy registration without prompting at logout.
export async function getCurrentDeviceToken(): Promise<string | null> {
    if (Platform.OS === 'web' || !Device.isDevice) return null;
    const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

    if (!projectId) {
        throw new Error('Expo project ID is missing');
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });

    return token;
}

function observeLegacyTokenRequest(session: LogoutSession) {
    let ambiguous404 = false;
    const client = createSessionDataClient(session.access_token, async (input, init) => {
        const response = await fetch(input, init);
        ambiguous404 = response.status === 404;
        return response;
    });
    return { client, hadAmbiguous404: () => ambiguous404 };
}

export async function registerDeviceToken(session: LogoutSession, token: string) {
    const { client, hadAmbiguous404 } = observeLegacyTokenRequest(session);
    const { error, status } = await client.rpc('upsert_device_token', {
        p_token: token,
        p_platform: Platform.OS,
        p_device_name: Device.deviceName,
    }).retry(false);

    if (!error && hadAmbiguous404()) throw new Error('Push registration outcome is unknown');
    if (!error) return { rejected: null };
    // PostgREST maps some transaction aborts, including query cancellation, to 5xx.
    const structured = typeof error.message === 'string'
        && (error.details === null || typeof error.details === 'string')
        && (error.hint === null || typeof error.hint === 'string');
    const transactionAborted = status === 500 && /^(40[0-9A-Z]{3}|55P03|57014)$/.test(error.code);
    const rejected = status >= 400 && status < 500 && status !== 408 && status !== 429
        && /^(PGRST[1-9]\d{2}|[0-9A-Z]{5})$/.test(error.code);
    const notExecuted = (status === 503 && (error.code === 'PGRST000' || error.code === 'PGRST002'))
        || (status === 504 && error.code === 'PGRST003');
    if (structured && (transactionAborted || rejected || notExecuted)) {
        return { rejected: new Error(error.message) };
    }
    throw new Error('Push registration outcome is unknown');
}

export async function removeDeviceToken(session: LogoutSession, token: string): Promise<void> {
    const { client, hadAmbiguous404 } = observeLegacyTokenRequest(session);
    const { error } = await client
        .from('user_device_tokens')
        .delete()
        .eq('user_id', session.user.id)
        .eq('expo_push_token', token)
        .retry(false);
    if (hadAmbiguous404()) throw new Error('Push removal outcome is unknown');
    if (error) throw new Error(error.message);
}
