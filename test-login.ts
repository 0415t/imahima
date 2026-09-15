import 'dotenv/config';
import { getCurrentSession, signInUser, signUpUser } from './lib/auth';

async function runBackEndTest() {
    // .env からテスト情報を取得
    const myEmail = process.env.TEST_EMAIL;
    const myPassword = process.env.TEST_PASSWORD;
    const myUsername = process.env.TEST_USERNAME;

    if (!myEmail || !myPassword || !myUsername) {
        throw new Error('❌ .env に TEST_EMAIL, TEST_PASSWORD, TEST_USERNAME を設定してください');
    }

    console.log('🚀 --- バックエンド単体テスト開始 ---');

    // 1. 新規登録（SignUp）テスト
    console.log('\n1. 新規ユーザー登録を実行中...');
    const { user: signUpUser_, error: signUpError } = await signUpUser(myEmail, myPassword, myUsername);

    if (signUpError) {
        console.error('❌ 新規登録エラー:', signUpError.message);
    } else {
        console.log('✅ 新規登録成功! User ID:', signUpUser_?.id);
    }

    // 2. ログイン（SignIn）テスト
    console.log('\n2. ログインを実行中...');
    const { error: signInError } = await signInUser(myEmail, myPassword);

    if (signInError) {
        console.error('❌ ログインエラー:', signInError.message);
    } else {
        console.log('✅ ログイン成功! アクセストークンを取得しました');
    }

    // 3. セッション確認（現在のログイン状態）
    console.log('\n3. 現在のセッション状態を確認中...');
    const { session, error: sessionError } = await getCurrentSession();

    if (sessionError || !session) {
        console.error('❌ セッション取得失敗:', sessionError?.message);
    } else {
        console.log('✅ セッション保持確認成功! ログイン中のユーザー:', session.user.email);
    }

    console.log('\n🏁 --- テスト終了 ---');
}

runBackEndTest();