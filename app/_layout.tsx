import { registerForPushNotificationsAsync, registerNotificationCategories, saveDeviceToken } from '@/lib/push-notifications';
import type { Session } from '@supabase/supabase-js';
import * as Notifications from 'expo-notifications';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet } from 'react-native';
import 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useColorScheme } from '@/hooks/use-color-scheme';
// バックグラウンドタスクの定義・登録のためモジュールスコープで読み込む
import { handleFreeEndAction } from '@/lib/notification-task';
import { hasSupabaseConfig, supabase } from '@/lib/supabase';

export const unstable_settings = {
  anchor: 'sign-in',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(hasSupabaseConfig && supabase));
  const [authError, setAuthError] = useState<string | null>(null);
  const userId = session?.user.id;

  useEffect(() => {
    if (!hasSupabaseConfig || !supabase) {
      return;
    }

    let isMounted = true;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (isMounted) {
        setSession(nextSession);
        setAuthError(null);
        setIsLoading(false);
      }
    });

    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!isMounted) {
          return;
        }

        if (error) {
          setAuthError(error.message);
        } else {
          setSession(data.session);
        }
        setIsLoading(false);
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setAuthError(error instanceof Error ? error.message : String(error));
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

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
      if (isActive && result && (result.ok || result.reason === 'conflict')) {
        const last = await Notifications.getLastNotificationResponseAsync();
        if (last?.notification.request.identifier === response.notification.request.identifier &&
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
  }, [userId]);

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

        const { error } = await saveDeviceToken(token);
        if (error) {
          throw error;
        }
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
  }, [userId]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {isLoading ? (
        <ThemedView style={styles.loading}>
          <ActivityIndicator size="large" />
        </ThemedView>
      ) : authError ? (
        <ThemedView style={styles.loading}>
          <ThemedText>ログイン状態を確認できませんでした: {authError}</ThemedText>
        </ThemedView>
      ) : (
        <Stack>
          <Stack.Protected guard={!session}>
            <Stack.Screen name="sign-in" options={{ headerShown: false }} />
          </Stack.Protected>
          <Stack.Protected guard={Boolean(session)}>
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
