import 'dotenv/config';
import { createApp } from './app';
import {
  createFreeEndNotificationPoller,
  type FreeEndNotificationClaim,
  type FreeEndNotificationValidation,
} from './jobs/free-end-notifications';
import { createPushNotificationService } from './services/notifications';
import { groupService } from './services/groups';
import { chatService } from './services/chat';
import { serverSupabase } from './services/supabase';
import { createMemberFreeNotificationPoller, parseMemberFreeMaxAttempts, type MemberFreeClaim } from './jobs/member-free-notifications';
import { createChatMessageNotificationPoller, parseChatNotificationOptions, type ChatMessageClaim } from './jobs/chat-message-notifications';

const memberFreeMaxAttempts = process.env.MEMBER_FREE_NOTIFICATIONS_ENABLED === 'true'
  ? parseMemberFreeMaxAttempts(process.env.MEMBER_FREE_NOTIFICATIONS_MAX_ATTEMPTS) : 3;
const chatNotificationOptions = process.env.CHAT_MESSAGE_NOTIFICATIONS_ENABLED === 'true'
  ? parseChatNotificationOptions(process.env) : null;

const pushNotifications = createPushNotificationService({
  accessToken: process.env.EXPO_ACCESS_TOKEN,
  deleteDeviceToken: async (token, signal) => {
    const query = serverSupabase
      .from('user_device_tokens')
      .delete()
      .eq('expo_push_token', token);
    const { error } = await (signal ? query.abortSignal(signal) : query);
    return { error };
  },
});
const getUserId = async (accessToken: string) => {
  const { data, error } = await serverSupabase.auth.getUser(accessToken);
  return { userId: data.user?.id ?? null, error };
};

const groups = groupService(serverSupabase, getUserId);
const app = createApp({
  getUserId,
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
  extendIsFreeFromNotification: async (userId, claimId) => {
    const { data, error } = await serverSupabase.rpc('extend_profile_is_free_from_notification', {
      target_profile_id: userId,
      claim_id: claimId,
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
}, groups, chatService(serverSupabase, groups));
const port = Number(process.env.PORT ?? 3000);

const server = app.listen({ port, ...(process.env.HOST ? { host: process.env.HOST } : {}) }, () => {
  console.log(`API server listening on http://localhost:${port}`);
});

const notificationPollers: { stop: () => Promise<void> }[] = [];

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
  notificationPollers.push(poller);
  console.log('Free-end notification poller started');
}

if (process.env.MEMBER_FREE_NOTIFICATIONS_ENABLED === 'true') {
  const poller = createMemberFreeNotificationPoller({
    claimNotifications: async (signal) => {
      const { data, error } = await serverSupabase.rpc('claim_member_free_notifications', {
        p_limit: 20, p_lease_seconds: 120,
        p_max_attempts: memberFreeMaxAttempts,
      }).abortSignal(signal!);
      const claims: MemberFreeClaim[] = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        notificationId: String(row.notification_id), eventId: String(row.event_id),
        recipientUserId: String(row.recipient_user_id), actorName: typeof row.actor_name === 'string' ? row.actor_name : null,
        attempts: Number(row.attempts), leaseToken: String(row.lease_token),
      }));
      return { claims, error };
    },
    validateNotification: async (id, lease, signal) => {
      const { data, error } = await serverSupabase.rpc('validate_member_free_notification', {
        p_notification: id, p_lease_token: lease,
      }).abortSignal(signal!);
      const row = Array.isArray(data) ? data[0] : data;
      return { validation: row ? { owned: row.owned === true, stillValid: row.still_valid === true } : null, error };
    },
    getDeviceTokens: async (userId, signal) => {
      const { data, error } = await serverSupabase.from('user_device_tokens').select('expo_push_token').eq('user_id', userId).abortSignal(signal!);
      return { tokens: (data ?? []).map((row) => row.expo_push_token), error };
    },
    sendPushNotifications: pushNotifications.sendPushNotifications,
    completeNotification: async (id, lease, status, errorMessage, acceptedCount, signal) => {
      const { data, error } = await serverSupabase.rpc('complete_member_free_notification', {
        p_notification: id, p_lease_token: lease, p_status: status,
        p_error: errorMessage ?? null, p_accepted_count: acceptedCount ?? 0,
      }).abortSignal(signal!);
      return { completed: data === true, error };
    },
  }, { intervalMs: Number(process.env.MEMBER_FREE_NOTIFICATIONS_INTERVAL_MS ?? 5_000) });
  poller.start();
  notificationPollers.push(poller);
  console.log('Member-free notification poller started');
}

if (chatNotificationOptions) {
  const poller = createChatMessageNotificationPoller({
    claimNotifications: async (signal) => {
      const { data, error } = await serverSupabase.rpc('claim_chat_message_notifications', {
        p_limit: 1, p_lease_seconds: 120, p_max_attempts: chatNotificationOptions.maxAttempts,
      }).abortSignal(signal);
      const claims: ChatMessageClaim[] = ((data ?? []) as Record<string, unknown>[]).map(row => ({
        notificationId: String(row.notification_id), roomId: String(row.room_id), messageId: String(row.message_id),
        recipientUserId: String(row.recipient_user_id), leaseToken: String(row.lease_token),
      }));
      return { claims, error };
    },
    validateNotification: async (id, lease, signal) => {
      const { data, error } = await serverSupabase.rpc('validate_chat_message_notification', {
        p_notification: id, p_lease_token: lease,
      }).abortSignal(signal);
      const row = Array.isArray(data) ? data[0] : data;
      return { validation: row ? {
        owned: row.owned === true, stillValid: row.still_valid === true,
        senderName: typeof row.sender_name === 'string' ? row.sender_name : 'メンバー',
        messageBody: typeof row.message_body === 'string' ? row.message_body : null,
        remainingMs: Number(row.remaining_ms), expiration: Number(row.expiration),
      } : null, error };
    },
    getDeviceTokens: async (userId, signal) => {
      const { data, error } = await serverSupabase.from('user_device_tokens').select('expo_push_token').eq('user_id', userId).abortSignal(signal);
      return { tokens: (data ?? []).map(row => row.expo_push_token), error };
    },
    sendPushNotifications: pushNotifications.sendPushNotifications,
    completeNotification: async (id, lease, status, reason, acceptedCount, signal) => {
      const { data, error } = await serverSupabase.rpc('complete_chat_message_notification', {
        p_notification: id, p_lease_token: lease, p_status: status, p_error: reason, p_accepted_count: acceptedCount,
      }).abortSignal(signal);
      return { completed: data === true, error };
    },
  }, { intervalMs: chatNotificationOptions.intervalMs });
  poller.start();
  notificationPollers.push(poller);
  console.log('Chat message notification poller started');
}

if (notificationPollers.length) {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Bound the entire shutdown as well, including other pollers and HTTP clients.
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 10_000);
    deadline.unref();
    void Promise.all(notificationPollers.map((poller) => poller.stop())).finally(() => {
      server.close(() => { clearTimeout(deadline); process.exit(0); });
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
