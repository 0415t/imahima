import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { EXTEND_30_ACTION, FREE_END_CATEGORY } from './free-end-action';

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

async function getCurrentDeviceToken(): Promise<string | null> {
    if (Platform.OS === 'web' || !Device.isDevice) return null;
    const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

    if (!projectId) {
        throw new Error('Expo project ID is missing');
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });

    return token;
}
