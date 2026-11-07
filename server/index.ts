import 'dotenv/config';
import { createApp } from './app';
import {
  createFreeEndNotificationPoller,
  type FreeEndNotificationClaim,
  type FreeEndNotificationValidation,
} from './jobs/free-end-notifications';
import { createPushNotificationService } from './services/notifications';
import { serverSupabase } from './services/supabase';

const pushNotifications = createPushNotificationService({
  accessToken: process.env.EXPO_ACCESS_TOKEN,
  deleteDeviceToken: async (token) => {
    const { error } = await serverSupabase
      .from('user_device_tokens')
      .delete()
      .eq('expo_push_token', token);
    return { error };
  },
});

const app = createApp({
  getUserId: async (accessToken) => {
    const { data, error } = await serverSupabase.auth.getUser(accessToken);
    return { userId: data.user?.id ?? null, error };
  },
  toggleIsFree: async (userId) => {
    const { data, error } = await serverSupabase.rpc('toggle_profile_is_free', {
      target_profile_id: userId,
    });
    return { isFree: data, error };
  },  
    setIsFree: async (userId, isFree, durationMinutes) => {
    const { data, error } = await serverSupabase.rpc('set_profile_is_free', {
      target_profile_id: userId,
      new_is_free: isFree,
        duration_minutes: durationMinutes ?? null,
    });
    const row = Array.isArray(data) ? data[0] : data;
    return { isFree: row?.is_free ?? null, freeUntil: row?.free_until ?? null, error };
  },
  extendIsFree: async (userId) => {
    const { data, error } = await serverSupabase.rpc('extend_profile_is_free', {
      target_profile_id: userId,
    });
    const row = Array.isArray(data) ? data[0] : data;
    return { isFree: row?.is_free ?? null, freeUntil: row?.free_until ?? null, error };
  },
}, {
  getDeviceTokens: async (userId) => {
    const { data, error } = await serverSupabase
      .from('user_device_tokens')
      .select('expo_push_token')
      .eq('user_id', userId);
    return { tokens: (data ?? []).map((row) => row.expo_push_token), error };
  },
  sendPushNotifications: (tokens, message) =>
    pushNotifications.sendPushNotifications(tokens, message),
});
const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});

// 暇状態終了5分前通知ポーラー（環境変数で有効化。デフォルト無効）
if (process.env.FREE_END_NOTIFICATIONS_ENABLED === 'true') {
  const poller = createFreeEndNotificationPoller({
    claimNotifications: async () => {
      const { data, error } = await serverSupabase.rpc('claim_free_end_notifications');
      const rows = (data ?? []) as Record<string, unknown>[];
      const claims: FreeEndNotificationClaim[] = rows.map((row) => ({
        claimId: String(row.claim_id),
        userId: String(row.user_id),
        freeUntil: String(row.free_until),
        attempts: Number(row.attempts),
        leaseToken: String(row.lease_token),
        leaseExpiresAt: String(row.lease_expires_at),
      }));
      return { claims, error };
    },
    validateNotification: async (claimId, leaseToken) => {
      const { data, error } = await serverSupabase.rpc('validate_free_end_notification', {
        p_claim_id: claimId,
        p_lease_token: leaseToken,
      });
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      const validation: FreeEndNotificationValidation | null = row
        ? { owned: Boolean(row.owned), stillValid: Boolean(row.still_valid) }
        : null;
      return { validation, error };
    },
    getDeviceTokens: async (userId) => {
      const { data, error } = await serverSupabase
        .from('user_device_tokens')
        .select('expo_push_token')
        .eq('user_id', userId);
      return { tokens: (data ?? []).map((row) => row.expo_push_token), error };
    },
    sendPushNotifications: (tokens, message) =>
      pushNotifications.sendPushNotifications(tokens, message),
    completeNotification: async (claimId, leaseToken, status, errorMessage) => {
      const { data, error } = await serverSupabase.rpc('complete_free_end_notification', {
        p_claim_id: claimId,
        p_lease_token: leaseToken,
        p_status: status,
        p_error: errorMessage ?? null,
      });
      return { completed: data === true, error };
    },
  }, {
    intervalMs: Number(process.env.FREE_END_NOTIFICATIONS_INTERVAL_MS ?? 60_000),
  });

  poller.start();
  console.log('Free-end notification poller started');

  const shutdown = () => {
    void poller.stop().finally(() => {
      server.close(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
