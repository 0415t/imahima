import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';

export type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

export type SendPushResult = {
  sent: number;
  error: unknown | null;
};

export function createPushNotificationService(options: {
  accessToken?: string;
  deleteDeviceToken: (token: string) => Promise<{ error: unknown | null }>;
}) {
  const expo = new Expo({ accessToken: options.accessToken });
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
    const messages: ExpoPushMessage[] = [];
    for (const token of tokens) {
      if (!Expo.isExpoPushToken(token)) {
        console.warn('[push] 不正な形式のトークンをスキップしました');
        continue;
      }
      messages.push({
        to: token,
        sound: 'default',
        title: message.title,
        body: message.body,
        data: message.data ?? {},
      });
    }

    if (messages.length === 0) {
      return { sent: 0, error: null };
    }

    const chunks = expo.chunkPushNotifications(messages);
    const tickets: ExpoPushTicket[] = [];
    try {
      for (const chunk of chunks) {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      }
    } catch (error) {
      console.error('[push] Expoへの送信に失敗しました:', error);
      return { sent: 0, error };
    }

    // チケットは「Expo Push APIが受け付けた」ことの確認であり、端末への配信成功ではない。
    // TODO: レシート(getPushNotificationReceiptsAsync)による遅延確認と、
    //       配信段階の DeviceNotRegistered に基づくトークン削除は今後の課題。
    let sent = 0;
    const invalidTokens: string[] = [];
    tickets.forEach((ticket, index) => {
      if (ticket.status === 'ok') {
        sent += 1;
        return;
      }
      console.error('[push] チケットエラー:', ticket.details?.error ?? ticket.message);
      if (ticket.details?.error === 'DeviceNotRegistered') {
        invalidTokens.push(messages[index].to as string);
      }
    });

    for (const token of invalidTokens) {
      await removeInvalidToken(token);
    }

    return { sent, error: null };
  };

  return { sendPushNotifications };
}
