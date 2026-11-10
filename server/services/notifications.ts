import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';

export type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  categoryId?: string;
};

export type SendPushResult = {
  // Expo受付成功件数。端末への配信完了件数ではない。
  sent: number;
  error: unknown | null;
  failures: { temporary: number; permanent: number; unknown: number };
};

export type PushClient = Pick<Expo, 'chunkPushNotifications' | 'sendPushNotificationsAsync'>;

export class PushSendError extends Error {
  constructor(readonly failures: SendPushResult['failures']) {
    super(`Push acceptance failed: temporary=${failures.temporary}, permanent=${failures.permanent}, unknown=${failures.unknown}`);
    this.name = 'PushSendError';
  }

  get permanentOnly(): boolean {
    return this.failures.permanent > 0 && this.failures.temporary === 0 && this.failures.unknown === 0;
  }
}

export function createPushNotificationService(options: {
  accessToken?: string;
  deleteDeviceToken: (token: string) => Promise<{ error: unknown | null }>;
  client?: PushClient;
}) {
  const expo = options.client ?? new Expo({ accessToken: options.accessToken });
  const { deleteDeviceToken } = options;

  const removeInvalidToken = async (token: string): Promise<void> => {
    try {
      const { error } = await deleteDeviceToken(token);
      if (error) {
        console.error('[push] 無効トークンの削除に失敗しました:', error);
      }
    } catch (error) {
      console.error('[push] 無効トークンの削除中に例外が発生しました:', error);
    }
  };

  const sendPushNotifications = async (
    tokens: string[],
    message: PushMessage
  ): Promise<SendPushResult> => {
    const failures: SendPushResult['failures'] = { temporary: 0, permanent: 0, unknown: 0 };
    const messages: ExpoPushMessage[] = [];
    for (const token of tokens) {
      if (!Expo.isExpoPushToken(token)) {
        console.warn('[push] 不正な形式のトークンをスキップしました');
        failures.permanent += 1;
        continue;
      }
      messages.push({
        to: token,
        sound: 'default',
        title: message.title,
        body: message.body,
        data: message.data ?? {},
        ...(message.categoryId ? { categoryId: message.categoryId } : {}),
      });
    }

    const chunks = expo.chunkPushNotifications(messages);
    // チケットは「Expo Push APIが受け付けた」ことの確認であり、端末への配信成功ではない。
    // TODO: レシート(getPushNotificationReceiptsAsync)による遅延確認と、
    //       配信段階の DeviceNotRegistered に基づくトークン削除は今後の課題。
    let sent = 0;
    const invalidTokens: string[] = [];
    for (const chunk of chunks) {
      let tickets: ExpoPushTicket[];
      try {
        tickets = await expo.sendPushNotificationsAsync(chunk);
      } catch (error) {
        // 応答が得られないチャンクは受付結果不明。先行チャンクの成功は保持する。
        console.error('[push] Expoへの送信に失敗しました:', error);
        failures.unknown += chunk.length;
        continue;
      }
      chunk.forEach((message, index) => {
        const ticket = tickets[index];
        if (ticket?.status === 'ok') {
          sent += 1;
          return;
        }
        const code = ticket?.status === 'error' ? ticket.details?.error : undefined;
        console.error('[push] チケットエラー:', code ?? 'UnknownError');
        if (code === 'MessageRateExceeded') {
          failures.temporary += 1;
        } else if (code === 'DeviceNotRegistered' || code === 'MessageTooBig' ||
                   code === 'InvalidCredentials' || code === 'DeveloperError') {
          failures.permanent += 1;
        } else {
          failures.unknown += 1;
        }
        if (code === 'DeviceNotRegistered') {
          invalidTokens.push(message.to as string);
        }
      });
    }

    if (failures.temporary + failures.permanent + failures.unknown > 0) {
      console.warn('[push] 受付失敗の内訳:', failures);
    }
    for (const token of invalidTokens) {
      await removeInvalidToken(token);
    }

    // A方式: 1件でも受付成功なら再試行しない。失敗端末だけの再試行は将来の課題。
    return { sent, failures, error: sent > 0 ? null : new PushSendError(failures) };
  };

  return { sendPushNotifications };
}
