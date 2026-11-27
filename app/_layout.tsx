import { registerForPushNotificationsAsync, registerNotificationCategories } from '@/lib/push-notifications';
import type { Session } from '@supabase/supabase-js';
import * as Notifications from 'expo-notifications';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Button, Platform, StyleSheet } from 'react-native';
import 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useColorScheme } from '@/hooks/use-color-scheme';
// バックグラウンドタスクの定義・登録のためモジュールスコープで読み込む
import { handleFreeEndAction } from '@/lib/notification-task';
import { logoutFlow } from '@/lib/logout';
import { jwtSessionId } from '@/lib/session-identity';
import { hasSupabaseConfig, supabase } from '@/lib/supabase';

export const unstable_settings = {
  anchor: 'sign-in',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(hasSupabaseConfig && supabase));
  const blocked = useSyncExternalStore(logoutFlow.subscribe, logoutFlow.isBlocked, logoutFlow.isBlocked);
  const logoutError = useSyncExternalStore(logoutFlow.subscribe, logoutFlow.getError, logoutFlow.getError);
  const [checkedSession, setCheckedSession] = useState<{ identity: string | Session | null; revision: number } | null>(null);
  const [storageReadFailed, setStorageReadFailed] = useState(false);
  const [storageRetry, setStorageRetry] = useState(0);
  const sessionUser = session?.user.id;
  const sessionId = session ? jwtSessionId(session.access_token) : undefined;
  const identity = sessionId ? `${sessionUser}:${sessionId}` : session;
  const revision = useSyncExternalStore(logoutFlow.subscribe, logoutFlow.revision, logoutFlow.revision);
  const authenticating = logoutFlow.isAuthenticating();
  const authorized = !supabase || (!blocked && !storageReadFailed
    && checkedSession?.identity === identity && (!session || (!authenticating && checkedSession.revision === revision)));
  const userId = authorized ? sessionUser : undefined;

  useEffect(() => {
    if (!hasSupabaseConfig || !supabase) {
      return;
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setIsLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (isLoading || blocked || authenticating || !supabase) return;
    let active = true;
    void logoutFlow.sessionAvailability().then(async availability => {
      if (!active) return;
      if (availability === 'ready' && session) await logoutFlow.prepareSession(session);
      if (!active) return;
      setStorageReadFailed(availability === 'read-failed');
      setCheckedSession(availability === 'ready' ? { identity, revision } : null);
      if (availability === 'logout-pending') void logoutFlow.signOut();
    }).catch(() => {
      if (!active) return;
      setCheckedSession(null);
      setStorageReadFailed(true);
    });
    return () => { active = false; };
  }, [authenticating, blocked, isLoading, revision, identity, session, storageRetry]);

  useEffect(() => {
    void registerNotificationCategories().catch((error: unknown) => {
      console.error('[push] 通知カテゴリ登録失敗:', error);
    });
  }, []);

  useEffect(() => {
    if (!userId || Platform.OS === 'web') return;
    let isActive = true;
    const processResponse = async (response: Notifications.NotificationResponse) => {
      if (!isActive) return;
      const result = await handleFreeEndAction(response);
      if (isActive && logoutFlow.revision() === revision && result && (result.ok || result.reason === 'conflict' || result.reason === 'not-authenticated')) {
        const last = await Notifications.getLastNotificationResponseAsync();
        if (isActive && logoutFlow.revision() === revision &&
            last?.notification.request.identifier === response.notification.request.identifier &&
            last.actionIdentifier === response.actionIdentifier) {
          await Notifications.clearLastNotificationResponseAsync();
        }
      }
    };
    const processSafely = (response: Notifications.NotificationResponse) => {
      void processResponse(response).catch((error: unknown) => console.error('[push] 通知アクション処理失敗:', error));
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(processSafely);
    // 通知からの起動時はリスナー登録前に応答が届いている場合がある。
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) processSafely(response);
    }).catch((error: unknown) => console.error('[push] 起動時の通知取得失敗:', error));

    return () => {
      isActive = false;
      subscription.remove();
    };
  }, [userId, identity, revision]);

  useEffect(() => {
    if (!userId) {
      return;
    }

    let isActive = true;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;

    const register = async () => {
      try {
        const token = await registerForPushNotificationsAsync();
        if (!isActive || !token) {
          return;
        }

        await logoutFlow.save(userId, token);
      } catch (error: unknown) {
        console.log('[push] 取得・保存に失敗しました:', error);

        if (isActive) {
          retryTimeout = setTimeout(() => {
            void register();
          }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 60_000);
        }
      }
    };

    void register();

    return () => {
      isActive = false;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
    };
  }, [userId, identity, revision]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {blocked && logoutError ? (
        <ThemedView style={styles.loading}>
          <ThemedText accessibilityRole="alert">ログアウトを完了できませんでした。</ThemedText>
          <Button title="再試行" onPress={() => { void logoutFlow.signOut(); }} />
        </ThemedView>
      ) : storageReadFailed && !blocked ? (
        <ThemedView style={styles.loading}>
          <ThemedText accessibilityRole="alert">ログイン状態を確認できませんでした。</ThemedText>
          <Button title="再確認" onPress={() => { setStorageRetry(attempt => attempt + 1); }} />
        </ThemedView>
      ) : isLoading || !authorized || blocked ? (
        <ThemedView style={styles.loading}>
          <ActivityIndicator size="large" />
        </ThemedView>
      ) : (
        <Stack key={session ? `${sessionUser}:${sessionId ?? revision}` : 'signed-out'}>
          <Stack.Protected guard={!session}>
            <Stack.Screen name="sign-in" options={{ headerShown: false }} />
          </Stack.Protected>
          <Stack.Protected guard={Boolean(userId)}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
          </Stack.Protected>
        </Stack>
      )}
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
});
