// 暇状態終了5分前通知ポーラー
// Step 1のDB基盤（claim/validate/complete RPC）を使い、既存のExpo Push送信処理を再利用する。
//
// 設計上の制約（Step 1マイグレーションと同じ）:
// - DB再検証とExpo Push API送信の間にはTOCTOU競合が残る。
// - 外部送信のexactly-onceは保証できない（at-least-once）。
//   送信成功後〜sent記録前にプロセスが停止すると、lease期限切れ後の再試行で重複送信しうる。

export type FreeEndNotificationClaim = {
  claimId: string;
  userId: string;
  freeUntil: string;
  attempts: number;
  leaseToken: string;
  leaseExpiresAt: string;
};

export type FreeEndNotificationValidation = {
  owned: boolean;
  stillValid: boolean;
};

export type FreeEndNotificationDependencies = {
  claimNotifications: () => Promise<{ claims: FreeEndNotificationClaim[]; error: unknown | null }>;
  validateNotification: (
    claimId: string,
    leaseToken: string
  ) => Promise<{ validation: FreeEndNotificationValidation | null; error: unknown | null }>;
  getDeviceTokens: (userId: string) => Promise<{ tokens: string[]; error: unknown | null }>;
  sendPushNotifications: (
    tokens: string[],
    message: { title: string; body: string; data?: Record<string, unknown> }
  ) => Promise<{ sent: number; error: unknown | null }>;
  completeNotification: (
    claimId: string,
    leaseToken: string,
    status: 'sent' | 'failed' | 'cancelled',
    error?: string
  ) => Promise<{ completed: boolean; error: unknown | null }>;
};

export type FreeEndNotificationPollerOptions = {
  intervalMs?: number;
  message?: { title: string; body: string };
};

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MESSAGE = {
  title: 'imahima',
  body: '暇状態の終了まであと5分です。延長できます。',
};

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
};

export function createFreeEndNotificationPoller(
  dependencies: FreeEndNotificationDependencies,
  options: FreeEndNotificationPollerOptions = {}
) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const message = options.message ?? DEFAULT_MESSAGE;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let stopped = false;

  const processClaim = async (claim: FreeEndNotificationClaim): Promise<void> => {
    // 送信直前にlease所有権と暇状態を再検証する
    const { validation, error: validateError } = await dependencies.validateNotification(
      claim.claimId,
      claim.leaseToken
    );

    if (validateError) {
      console.error('[free-end-notifications] validate failed:', validateError);
      await dependencies.completeNotification(
        claim.claimId,
        claim.leaseToken,
        'failed',
        `validate: ${formatError(validateError)}`
      );
      return;
    }

    if (!validation || !validation.owned) {
      // 別ワーカーに再確保された、またはキャンセル済み。何もしない
      return;
    }

    if (!validation.stillValid) {
      // 手動OFF・延長・期限切れ。古い通知を送らない
      await dependencies.completeNotification(claim.claimId, claim.leaseToken, 'cancelled');
      return;
    }

    const { tokens, error: tokensError } = await dependencies.getDeviceTokens(claim.userId);

    if (tokensError) {
      console.error('[free-end-notifications] device tokens fetch failed:', tokensError);
      await dependencies.completeNotification(
        claim.claimId,
        claim.leaseToken,
        'failed',
        `tokens: ${formatError(tokensError)}`
      );
      return;
    }

    if (tokens.length === 0) {
      // 登録端末なし。再試行しても変わらないためsent扱いで終了する
      await dependencies.completeNotification(claim.claimId, claim.leaseToken, 'sent');
      return;
    }

    const { error: sendError } = await dependencies.sendPushNotifications(tokens, {
      title: message.title,
      body: message.body,
      data: { type: 'free_end_reminder', freeUntil: claim.freeUntil },
    });

    if (sendError) {
      console.error('[free-end-notifications] push send failed:', sendError);
      await dependencies.completeNotification(
        claim.claimId,
        claim.leaseToken,
        'failed',
        `send: ${formatError(sendError)}`
      );
      return;
    }

    const { completed, error: completeError } = await dependencies.completeNotification(
      claim.claimId,
      claim.leaseToken,
      'sent'
    );

    if (completeError) {
      console.error('[free-end-notifications] complete failed:', completeError);
      return;
    }

    if (!completed) {
      // 所有権喪失（別ワーカー再確保・キャンセル）。重複送信の可能性があるが
      // at-least-onceの制約として許容する
      console.warn('[free-end-notifications] complete rejected (ownership lost):', claim.claimId);
    }
  };

  const runOnce = async (): Promise<void> => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      const { claims, error } = await dependencies.claimNotifications();
      if (error) {
        console.error('[free-end-notifications] claim failed:', error);
        return;
      }
      for (const claim of claims) {
        if (stopped) {
          break;
        }
        await processClaim(claim);
      }
    } catch (error) {
      console.error('[free-end-notifications] unexpected error:', error);
    } finally {
      running = false;
    }
  };

  const start = (): void => {
    if (timer !== null || stopped) {
      return;
    }
    timer = setInterval(() => {
      void runOnce();
    }, intervalMs);
    void runOnce();
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    // 実行中のサイクルがあれば終了を待つ
    while (running) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  return { start, stop, runOnce };
}
