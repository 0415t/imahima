import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase } from './supabase';

Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
    }),
});

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

    const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

    if (!projectId) {
        console.log('[push] projectId が見つかりません');
        return null;
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    console.log('[push] token:', token);

    return token;
}

export async function saveDeviceToken(token: string): Promise<{ error: Error | null }> {
    if (!supabase) {
        return { error: new Error('Supabase が設定されていません') };
    }

    const { error } = await supabase.rpc('upsert_device_token', {
        p_token: token,
        p_platform: Platform.OS,
        p_device_name: Device.deviceName,
    });

    if (error) {
        console.log('[push] 保存に失敗しました:', error.message);
        return { error };
    }

    console.log('[push] 保存に成功しました');
    return { error: null };
}