import 'dotenv/config';

const API_BASE = 'http://localhost:3000';

async function runPushSendTest() {
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

    const [{ signInUser }, { hasSupabaseConfig }] = await Promise.all([
        import('../lib/auth'),
        import('../lib/supabase'),
    ]);

    const myEmail = process.env.TEST_EMAIL;
    const myPassword = process.env.TEST_PASSWORD;

    if (!hasSupabaseConfig) {
        throw new Error('.env に EXPO_PUBLIC_SUPABASE_URL と EXPO_PUBLIC_SUPABASE_ANON_KEY を設定してください');
    }

    if (!myEmail || !myPassword) {
        throw new Error('❌ .env に TEST_EMAIL と TEST_PASSWORD を設定してください');
    }

    console.log('🚀 --- テスト通知送信 開始 ---');

    console.log('\n1. 既存ユーザーでログイン中...');
    const { session, error: signInError } = await signInUser(myEmail, myPassword);

    if (signInError) {
        throw new Error(`ログインエラー: ${signInError.message}`);
    }

    if (!session?.access_token) {
        throw new Error('ログイン結果にアクセストークンを含むセッションがありません');
    }
    console.log('✅ ログイン成功! User ID:', session.user.id);

    console.log('\n2. テスト通知APIを呼び出し中...');
    const response = await fetch(`${API_BASE}/notifications/test`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${session.access_token}`,
        },
    });

    const body: unknown = await response.json().catch(() => null);
    console.log('HTTPステータス:', response.status);
    console.log('レスポンス:', JSON.stringify(body));

    if (!response.ok) {
        throw new Error(`通知API呼び出し失敗: HTTP ${response.status}`);
    }

    console.log('\n🏁 --- テスト通知の送信に成功しました ---');
}

runPushSendTest().catch((error: unknown) => {
    console.error('❌ テスト通知送信失敗:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
