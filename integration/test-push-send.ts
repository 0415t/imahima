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

    if (!body || typeof body !== 'object' || !('sent' in body) ||
        typeof body.sent !== 'number' || !Number.isInteger(body.sent) || body.sent <= 0) {
        throw new Error('Expo受付を確認できませんでした。実機で通知を許可し、端末トークンを登録してください。');
    }
    console.log(`\n🏁 --- Expo受付成功: ${body.sent}件（端末への配信完了は実機で確認してください） ---`);
}

runPushSendTest().catch((error: unknown) => {
    console.error('❌ テスト通知送信失敗:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
