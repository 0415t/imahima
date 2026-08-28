import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export default function HomeScreen() {
  return (
    <ThemedView lightColor="#ffffff" darkColor="#ffffff" style={styles.container}>
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
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
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
  button: {
    width: '45%',
    height: '18%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0a7ea4',
  },
  buttonLabel: {
    fontSize: 48,
    lineHeight: 72,
  },
  buttonPressed: {
    opacity: 0.7,
  },
});
