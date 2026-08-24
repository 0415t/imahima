import { StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export default function ExploreScreen() {
  return (
    <ThemedView lightColor="#ffffff" darkColor="#ffffff" style={styles.container}>
      <ThemedText lightColor="#000000" darkColor="#000000" type="title">
        Explore
      </ThemedText>
      <ThemedText lightColor="#000000" darkColor="#000000" style={styles.description}>
        ここから機能を追加していきます。
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  description: {
    marginTop: 12,
  },
});
