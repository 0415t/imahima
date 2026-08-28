import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hasSupabaseConfig, supabase } from '@/lib/supabase';

type User = {
  id: string;
  username: string;
  is_free: boolean;
};

export default function HomeScreen() {
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function fetchUsers() {
      if (!hasSupabaseConfig || !supabase) {
        setErrorMessage(
          'Supabaseの設定がありません。.envにEXPO_PUBLIC_SUPABASE_URLとEXPO_PUBLIC_SUPABASE_ANON_KEYを設定してください。'
        );
        setIsLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from('users')
        .select('id, username, is_free')
        .limit(50);

      if (!isMounted) {
        return;
      }

      if (error) {
        console.error('Supabase users取得エラー:', error);
        setErrorMessage(__DEV__ ? error.message : 'ユーザー情報の取得に失敗しました。');
        setIsLoading(false);
        return;
      }

      const fetchedUsers = (data ?? []) as User[];
      if (__DEV__) console.log('Supabase users取得結果:', fetchedUsers);
      setUsers(fetchedUsers);
      setIsLoading(false);
    }

    void fetchUsers();

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <ThemedView lightColor="#ffffff" darkColor="#ffffff" style={styles.container}>
      <ThemedText lightColor="#000000" darkColor="#000000" type="title">
        Supabase users
      </ThemedText>
      {isLoading ? <ActivityIndicator style={styles.status} /> : null}
      {errorMessage ? (
        <ThemedText lightColor="#b42318" darkColor="#b42318" style={styles.status}>
          {errorMessage}
        </ThemedText>
      ) : null}
      {!isLoading && !errorMessage && users.length === 0 ? (
        <ThemedText lightColor="#000000" darkColor="#000000" style={styles.status}>
          usersテーブルにデータがありません。
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
      ) : null}
      <View style={styles.userList}>
        {users.map((user) => (
          <View key={user.id} style={styles.userRow}>
            <ThemedText lightColor="#000000" darkColor="#000000" type="defaultSemiBold">
              {user.username}
            </ThemedText>
            <ThemedText lightColor="#000000" darkColor="#000000">
              id: {user.id}
            </ThemedText>
            <ThemedText lightColor="#000000" darkColor="#000000">
              is_free: {String(user.is_free)}
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
  buttonLabel: {
    fontSize: 48,
    lineHeight: 72,
  },
  buttonPressed: {
    opacity: 0.7,
  },
});
