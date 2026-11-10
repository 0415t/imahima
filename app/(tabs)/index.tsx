import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, AppState, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hasSupabaseConfig, supabase } from '@/lib/supabase';
import { subscribeAvailabilityChanged } from '@/lib/availability-events';

type User = {
  id: string;
  username: string | null;
  is_free: boolean | null;
  free_until: string | null;
};

export default function HomeScreen() {
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [ownUserId, setOwnUserId] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    let isMounted = true;
    let requestId = 0;

    async function fetchUsers() {
      const currentRequest = ++requestId;
      if (!hasSupabaseConfig || !supabase) {
        setErrorMessage(
          'Supabaseの設定がありません。.envにEXPO_PUBLIC_SUPABASE_URLとEXPO_PUBLIC_SUPABASE_ANON_KEYを設定してください。'
        );
        setIsLoading(false);
        return;
      }

      try {
        const { data: auth, error: authError } = await supabase.auth.getSession();
        if (authError || !auth.session) throw new Error('ログイン状態を確認できませんでした。');
        const id = auth.session.user.id;
        const [list, own] = await Promise.all([
          supabase.from('profiles').select('id, username, is_free, free_until').limit(50),
          supabase.from('profiles').select('id, username, is_free, free_until').eq('id', id).maybeSingle(),
        ]);
        if (!isMounted || currentRequest !== requestId) return;
        if (list.error || own.error) throw list.error ?? own.error;
        // 一覧の上限にかかわらず、自分の更新後の状態を先頭に表示する。
        const others = ((list.data ?? []) as User[]).filter((user) => user.id !== id);
        setUsers(own.data ? [own.data as User, ...others] : others);
        setOwnUserId(id);
        setErrorMessage(null);
        setIsLoading(false);
      } catch {
        if (isMounted && currentRequest === requestId) {
          setErrorMessage('暇状態の取得に失敗しました。');
          setIsLoading(false);
        }
      }
    }

    void fetchUsers();
    const unsubscribe = subscribeAvailabilityChanged(() => { void fetchUsers(); });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void fetchUsers();
    });
    // 期限を過ぎた表示も更新する。バックグラウンド中は問い合わせない。
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void fetchUsers();
    }, 30_000);

    return () => {
      isMounted = false;
      unsubscribe();
      subscription.remove();
      clearInterval(timer);
    };
  }, []));

  return (
    <ThemedView lightColor="#ffffff" darkColor="#ffffff" style={styles.container}>
      <ThemedText lightColor="#000000" darkColor="#000000" type="title">
        暇状態
      </ThemedText>
      {isLoading ? <ActivityIndicator style={styles.status} /> : null}
      {errorMessage ? (
        <ThemedText lightColor="#b42318" darkColor="#b42318" style={styles.status}>
          {errorMessage}
        </ThemedText>
      ) : null}
      {!isLoading && !errorMessage && users.length === 0 ? (
        <ThemedText lightColor="#000000" darkColor="#000000" style={styles.status}>
          プロフィールがありません。
        </ThemedText>
      ) : null}
      <View style={styles.header}>
        <ThemedText
          lightColor="#11181C"
          darkColor="#11181C"
          type="subtitle"
          style={styles.headerTitle}>
          いまひま？
        </ThemedText>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityLabel="通知"
            accessibilityRole="button"
            style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}>
            <MaterialIcons name="notifications-none" size={33} color="#11181C" />
          </Pressable>
          <Pressable
            accessibilityLabel="設定"
            accessibilityRole="button"
            style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}>
            <MaterialIcons name="settings" size={31.5} color="#11181C" />
          </Pressable>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
        <ThemedText
          lightColor="#ffffff"
          darkColor="#ffffff"
          type="defaultSemiBold"
          style={styles.buttonLabel}>
          いまひま！
        </ThemedText>
      </Pressable>
      <View style={styles.userList}>
        {users.map((user) => (
          <View key={user.id} style={styles.userRow}>
            <ThemedText lightColor="#000000" darkColor="#000000" type="defaultSemiBold">
              {user.username ?? '名無し'}{user.id === ownUserId ? '（自分）' : ''}
            </ThemedText>
            <ThemedText lightColor="#000000" darkColor="#000000">
              id: {user.id}
            </ThemedText>
            <ThemedText lightColor="#000000" darkColor="#000000">
              暇状態: {user.is_free && (!user.free_until || Date.parse(user.free_until) > Date.now()) ? 'ON' : 'OFF'}
            </ThemedText>
            <ThemedText lightColor="#000000" darkColor="#000000">
              終了予定: {user.is_free ? (user.free_until ? new Date(user.free_until).toLocaleString() : '無期限') : 'なし'}
            </ThemedText>
          </View>
        ))}
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    padding: 24,
    paddingTop: 60,
  },
  header: {
    position: 'absolute',
    top: 24,
    left: 24,
    right: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: 40,
    lineHeight: 48,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 18,
  },
  iconButton: {
    width: 66,
    height: 66,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 33,
    backgroundColor: '#F1F4F5',
  },
  status: {
    marginTop: 12,
  },
  userList: {
    marginTop: 24,
    gap: 12,
  },
  userRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#cccccc',
    paddingBottom: 12,
    gap: 2,
  },
  button: {
    marginTop: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: '#11181C',
    paddingVertical: 12,
  },
  buttonLabel: {
    fontSize: 48,
    lineHeight: 72,
  },
  buttonPressed: {
    opacity: 0.7,
  },
});
