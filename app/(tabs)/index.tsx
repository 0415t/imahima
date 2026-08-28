import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

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
        .select('id, username, is_free');

      if (!isMounted) {
        return;
      }

      if (error) {
        console.error('Supabase users取得エラー:', error);
        setErrorMessage(error.message);
        setIsLoading(false);
        return;
      }

      const fetchedUsers = (data ?? []) as User[];
      console.log('Supabase users取得結果:', fetchedUsers);
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
});
