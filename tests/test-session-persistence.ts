import 'dotenv/config';

async function runSessionPersistenceTest() {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            localStorage: {
                get length() {
                    return storage.size;
                },
                clear: () => storage.clear(),
                getItem: (key: string) => storage.get(key) ?? null,
                key: (index: number) => [...storage.keys()][index] ?? null,
                removeItem: (key: string) => storage.delete(key),
                setItem: (key: string, value: string) => storage.set(key, String(value)),
            },
        },
    });

    const { createSupabaseClient } = await import('../lib/supabase');
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    const email = process.env.TEST_EMAIL;
    const password = process.env.TEST_PASSWORD;

    if (!url || !anonKey) {
        throw new Error('.env に EXPO_PUBLIC_SUPABASE_URL と EXPO_PUBLIC_SUPABASE_ANON_KEY を設定してください');
    }

    if (!email || !password) {
        throw new Error('.env に TEST_EMAIL と TEST_PASSWORD を設定してください');
    }

    console.log('ログインしてセッションを保存します...');
    const initialClient = createSupabaseClient(url, anonKey);
    const { data: signInData, error: signInError } = await initialClient.auth.signInWithPassword({
        email,
        password,
    });

    if (signInError) {
        throw new Error(`ログイン失敗: ${signInError.message}`);
    }

    if (!signInData.session?.access_token) {
        throw new Error('ログイン結果にアクセストークンを含むセッションがありません');
    }

    console.log('新しいクライアントで保存済みセッションを復元します...');
    const restartedClient = createSupabaseClient(url, anonKey);
    const { data: sessionData, error: sessionError } = await restartedClient.auth.getSession();

    if (sessionError) {
        throw new Error(`セッション復元失敗: ${sessionError.message}`);
    }

    if (!sessionData.session?.access_token) {
        throw new Error('新しいクライアントでアクセストークンを復元できませんでした');
    }

    if (
        sessionData.session.user.id !== signInData.session.user.id ||
        sessionData.session.access_token !== signInData.session.access_token
    ) {
        throw new Error('復元したセッションがログイン直後のセッションと一致しません');
    }

    console.log('✅ 新しいSupabaseクライアントで同じユーザーのセッションを復元できました');
}

runSessionPersistenceTest().catch((error: unknown) => {
    console.error('❌ セッション永続化テスト失敗:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
