import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { extendFreeFromNotification } from './extend-free';
import { createFreeEndActionHandler, type ExtendFreeResult } from './free-end-action';
export { FREE_END_CATEGORY, EXTEND_30_ACTION } from './free-end-action';

export const handleFreeEndAction = createFreeEndActionHandler(extendFreeFromNotification);

const BACKGROUND_NOTIFICATION_TASK = 'FREE-END-NOTIFICATION-TASK';

async function notifyExtendResult(result: ExtendFreeResult): Promise<void> {
    await Notifications.scheduleNotificationAsync({
        content: {
            title: 'imahima',
            body: result.ok
                ? '暇状態を30分延長しました。'
                : result.reason === 'conflict'
                    ? 'アプリを開いて現在の暇状態を確認してください。'
                    : '延長できませんでした。アプリを開いて確認してください。',
        },
        trigger: null,
    });
}

// モジュールスコープで定義する必要がある（バックグラウンドでJSバンドルが読み込まれた際に実行される）
TaskManager.defineTask<Notifications.NotificationTaskPayload>(
    BACKGROUND_NOTIFICATION_TASK,
    async ({ data, error }) => {
        if (error) {
            return Notifications.BackgroundNotificationTaskResult.Failed;
        }

        const result = await handleFreeEndAction(normalizeTaskResponse(data));
        if (!result) {
            return Notifications.BackgroundNotificationTaskResult.NoData;
        }
        if (!result.ok && result.reason === 'not-authenticated') {
            return Notifications.BackgroundNotificationTaskResult.NoData;
        }

        // DB側でclaim照合とfree_until一致判定を行うため、
        // フォアグラウンドリスナーと二重に処理されても延長は1回のみ
        try {
            await notifyExtendResult(result);
        } catch (notificationError: unknown) {
            // 結果通知の失敗で、完了した延長操作を失敗に戻さない。
            console.error('[push] 延長結果の通知失敗:', notificationError);
        }

        if (result.ok) return Notifications.BackgroundNotificationTaskResult.NewData;
        return result.reason === 'conflict'
            ? Notifications.BackgroundNotificationTaskResult.NoData
            : Notifications.BackgroundNotificationTaskResult.Failed;
    }
);

// Android headless tasks bypass Expo's foreground response mapper.
function normalizeTaskResponse(value: unknown): unknown {
    if (!value || typeof value !== 'object' || !('notification' in value)) return value;
    const notification = value.notification;
    if (!notification || typeof notification !== 'object' || !('request' in notification)) return value;
    const request = notification.request;
    if (!request || typeof request !== 'object' || !('content' in request)) return value;
    const content = request.content;
    if (!content || typeof content !== 'object' || 'data' in content ||
        !('dataString' in content) || typeof content.dataString !== 'string') return value;
    try {
        const parsed: unknown = JSON.parse(content.dataString);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value;
        return { ...value, notification: { ...notification, request: { ...request, content: { ...content, data: parsed } } } };
    } catch { return value; }
}

if (Platform.OS !== 'web') {
    void Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK).catch((error: unknown) => {
        console.error('[push] バックグラウンドタスク登録失敗:', error);
    });
}
