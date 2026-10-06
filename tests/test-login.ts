import 'dotenv/config';

async function runBackEndTest() {
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

    const [{ getCurrentSession, signInUser, signUpUser }, { hasSupabaseConfig }] = await Promise.all([
        import('../lib/auth'),
        import('../lib/supabase'),
    ]);

    const myEmail = process.env.TEST_EMAIL;
    const myPassword = process.env.TEST_PASSWORD;
    const myUsername = process.env.TEST_USERNAME;

    if (!hasSupabaseConfig) {
        throw new Error('.env に EXPO_PUBLIC_SUPABASE_URL と EXPO_PUBLIC_SUPABASE_ANON_KEY を設定してください');
    }

    if (!myEmail || !myPassword || !myUsername) {
        throw new Error('❌ .env に TEST_EMAIL, TEST_PASSWORD, TEST_USERNAME を設定してください');
    }

    console.log('🚀 --- バックエンド単体テスト開始 ---');

    console.log('\n1. 新規ユーザー登録を実行中...');
    const { user, error: signUpError } = await signUpUser(myEmail, myPassword, myUsername);

    if (signUpError) {
        throw new Error(`新規登録エラー: ${signUpError.message}`);
    }

    if (!user) {
        throw new Error('新規登録結果にユーザーがありません');
    }
    console.log('✅ 新規登録成功! User ID:', user.id);

    console.log('\n2. ログインを実行中...');
    const { session: signInSession, error: signInError } = await signInUser(myEmail, myPassword);

    if (signInError) {
        throw new Error(`ログインエラー: ${signInError.message}`);
    }

    if (!signInSession?.access_token) {
        throw new Error('ログイン結果にアクセストークンを含むセッションがありません');
    }
    console.log('✅ ログイン成功! セッションとアクセストークンを取得しました');

    console.log('\n3. 現在のセッション状態を確認中...');
    const { session, error: sessionError } = await getCurrentSession();

    if (sessionError) {
        throw new Error(`セッション取得失敗: ${sessionError.message}`);
    }

    if (!session?.access_token) {
        throw new Error('getSession() がアクセストークンを含むセッションを返しませんでした');
    }

    if (session.user.id !== user.id) {
        throw new Error('getSession() がサインアップしたユーザーとは異なるユーザーを返しました');
    }
    console.log('✅ getSession() でログイン中のユーザーとアクセストークンを確認しました');

    console.log('\n🏁 --- すべての認証テストに成功しました ---');
}

runBackEndTest().catch((error: unknown) => {
    console.error('❌ 認証テスト失敗:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});