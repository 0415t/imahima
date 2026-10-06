import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { signInUser, signUpUser } from '@/lib/auth';

export default function SignInScreen() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSubmit() {
    setIsSubmitting(true);
    setErrorMessage(null);
    setNotice(null);

    try {
      if (isSignUp) {
        const { user, error } = await signUpUser(email.trim(), password);
        if (error) {
          setErrorMessage(error.message);
        } else if (!user) {
          setErrorMessage('アカウントを作成できませんでした。入力内容を確認してください。');
        } else {
          setNotice('登録しました。確認メールが届いた場合は、メール内のリンクから登録を完了してください。');
        }
      } else {
        const { session, error } = await signInUser(email.trim(), password);
        if (error) {
          setErrorMessage(error.message);
        } else if (!session) {
          setErrorMessage('ログインセッションを取得できませんでした。もう一度お試しください。');
        }
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  function changeMode() {
    setIsSignUp((current) => !current);
    setErrorMessage(null);
    setNotice(null);
  }

  return (
    <ThemedView lightColor="#ffffff" darkColor="#ffffff" style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardView}>
        <View style={styles.form}>
          <ThemedText lightColor="#11181C" darkColor="#11181C" type="title">
            いまひま？
          </ThemedText>
          <ThemedText lightColor="#52616B" darkColor="#52616B" style={styles.subtitle}>
            {isSignUp ? 'アカウントを作成して始めましょう' : 'ログインして続けましょう'}
          </ThemedText>

          <TextInput
            accessibilityLabel="メールアドレス"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            onChangeText={setEmail}
            placeholder="メールアドレス"
            placeholderTextColor="#74818A"
            style={styles.input}
            textContentType="emailAddress"
            value={email}
          />
          <TextInput
            accessibilityLabel="パスワード"
            autoCapitalize="none"
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            onChangeText={setPassword}
            placeholder="パスワード"
            placeholderTextColor="#74818A"
            secureTextEntry
            style={styles.input}
            textContentType={isSignUp ? 'newPassword' : 'password'}
            value={password}
          />

          {errorMessage ? (
            <ThemedText accessibilityRole="alert" lightColor="#B42318" darkColor="#B42318">
              {errorMessage}
            </ThemedText>
          ) : null}
          {notice ? (
            <ThemedText accessibilityRole="alert" lightColor="#176B45" darkColor="#176B45">
              {notice}
            </ThemedText>
          ) : null}

          <Pressable
            accessibilityRole="button"
            disabled={isSubmitting || !email.trim() || !password}
            onPress={() => void handleSubmit()}
            style={({ pressed }) => [
              styles.submitButton,
              pressed && styles.pressed,
              (isSubmitting || !email.trim() || !password) && styles.disabled,
            ]}>
            {isSubmitting ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <ThemedText lightColor="#ffffff" darkColor="#ffffff" type="defaultSemiBold">
                {isSignUp ? '新規登録' : 'ログイン'}
              </ThemedText>
            )}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={isSubmitting}
            onPress={changeMode}
            style={styles.modeButton}>
            <ThemedText lightColor="#176B82" darkColor="#176B82">
              {isSignUp ? 'すでにアカウントをお持ちの方はログイン' : 'アカウントをお持ちでない方は新規登録'}
            </ThemedText>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  form: {
    gap: 16,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  subtitle: {
    marginBottom: 12,
  },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: '#C8D0D5',
    borderRadius: 12,
    color: '#11181C',
    paddingHorizontal: 16,
    fontSize: 16,
  },
  submitButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#11181C',
    paddingHorizontal: 16,
  },
  modeButton: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  pressed: {
    opacity: 0.75,
  },
  disabled: {
    opacity: 0.45,
  },
});
