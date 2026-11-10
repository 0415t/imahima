/**
 * 30分延長機能の統合テスト
 * 実際のExpress APIとSupabaseを使用
 *
 * 実行方法: node --env-file=.env --import tsx tests/test-extend-integration.ts
 * 前提: Expressサーバーが localhost:3000 で起動していること
 *
 * 注意: このファイルはコミット対象外です
 */

const API_BASE = 'http://localhost:3000';

type ProfileState = {
  is_free: boolean;
  free_until: string | null;
};

async function runExtendIntegrationTest() {
  // 1. 環境変数チェック
  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;

  if (!email || !password) {
    throw new Error('TEST_EMAIL と TEST_PASSWORD を .env に設定してください');
  }

  // テスト用アカウントであることを確認（明示的に許可されたメールアドレスのみ）
  const allowedTestEmails = (process.env.ALLOWED_TEST_EMAILS ?? '').split(',').map((e) => e.trim());
  if (!allowedTestEmails.includes(email)) {
    throw new Error(
      `テスト用アカウントではありません: ${email}\n` +
      `ALLOWED_TEST_EMAILS に許可されたテスト用メールアドレスを設定してください。`
    );
  }

  // 2. Supabaseクライアントでログイン（アクセストークン取得）
  const { createClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('EXPO_PUBLIC_SUPABASE_URL と EXPO_PUBLIC_SUPABASE_ANON_KEY を設定してください');
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (authError || !authData.session?.access_token) {
    throw new Error(`ログイン失敗: ${authError?.message}`);
  }

  const accessToken = authData.session.access_token;
  const userId = authData.user.id;
  console.log('✅ ログイン成功（User ID:', userId, ')');

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  // 3. テスト前の状態を確認（OFFであることを確認）
  console.log('\n📋 テスト前の状態を確認中...');
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('is_free, free_until')
    .eq('id', userId)
    .single();

  if (profileError) {
    throw new Error(`プロフィール取得失敗: ${profileError.message}`);
  }

  const initialState: ProfileState = {
    is_free: profile.is_free,
    free_until: profile.free_until,
  };

  console.log('  現在の状態: is_free =', initialState.is_free, ', free_until =', initialState.free_until);

  if (initialState.is_free !== false || initialState.free_until !== null) {
    throw new Error(
      'テスト開始前に is_free === false かつ free_until === null である必要があります。\n' +
      `現在の状態: is_free = ${initialState.is_free}, free_until = ${initialState.free_until}\n` +
      'データを変更せずに中止します。'
    );
  }

  console.log('✅ テスト前の状態はOFF（is_free === false かつ free_until === null）です');

  let testError: Error | null = null;
  let cleanupError: Error | null = null;

  try {
    // 4. 30分間ONにする
    console.log('\n⏱️  30分間ONに設定中...');
    const onRes = await fetch(`${API_BASE}/profiles/me/is-free`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ is_free: true, duration_minutes: 30 }),
    });

    if (!onRes.ok) {
      throw new Error(`ON設定失敗: HTTP ${onRes.status}`);
    }

    const onData = await onRes.json();
    if (onData.is_free !== true) {
      throw new Error(`ON設定後の状態が不正です: is_free = ${onData.is_free}`);
    }
    if (typeof onData.free_until !== 'string') {
      throw new Error(`ON設定後のfree_untilが不正です: ${onData.free_until}`);
    }
    const originalFreeUntil = onData.free_until;
    console.log('✅ ON設定成功。free_until:', originalFreeUntil);

    // 5. 30分延長
    console.log('\n➕ 30分延長を実行中...');
    const extendRes = await fetch(`${API_BASE}/profiles/me/is-free/extend`, {
      method: 'POST',
      headers,
    });

    if (!extendRes.ok) {
      throw new Error(`延長失敗: HTTP ${extendRes.status}`);
    }

    const extendData = await extendRes.json();
    if (extendData.is_free !== true) {
      throw new Error(`延長後の状態が不正です: is_free = ${extendData.is_free}`);
    }
    if (typeof extendData.free_until !== 'string') {
      throw new Error(`延長後のfree_untilが不正です: ${extendData.free_until}`);
    }
    const extendedFreeUntil = extendData.free_until;
    console.log('✅ 延長成功。free_until:', extendedFreeUntil);

    // 6. 差分検証（1800秒 = 30分）
    const diffMs = new Date(extendedFreeUntil).getTime() - new Date(originalFreeUntil).getTime();
    const diffSeconds = diffMs / 1000;

    console.log('\n🔍 差分検証:');
    console.log('  期待値: 1800秒（30分）');
    console.log('  実際値:', diffSeconds, '秒');

    if (diffSeconds !== 1800) {
      throw new Error(`差分が1800秒ではありません: ${diffSeconds}秒`);
    }
    console.log('✅ 差分は正確に1800秒です');

    // 7. OFF状態での延長が409になることを確認
    console.log('\n🚫 OFF状態での延長テスト...');
    const offRes = await fetch(`${API_BASE}/profiles/me/is-free`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ is_free: false }),
    });

    if (!offRes.ok) {
      throw new Error(`OFF設定失敗: HTTP ${offRes.status}`);
    }

    const offExtendRes = await fetch(`${API_BASE}/profiles/me/is-free/extend`, {
      method: 'POST',
      headers,
    });

    if (offExtendRes.status !== 409) {
      throw new Error(`OFF状態での延長が409ではありません: HTTP ${offExtendRes.status}`);
    }
    console.log('✅ OFF状態での延長は正しく409を返しました');

    console.log('\n🏁 すべての統合テストに成功しました');
  } catch (error) {
    testError = error instanceof Error ? error : new Error(String(error));
  } finally {
    // 8. クリーンアップ（ON操作を開始した後は、途中失敗してもOFFへの復元を試みる）
    console.log('\n🧹 クリーンアップ中...');

    try {
      const cleanupRes = await fetch(`${API_BASE}/profiles/me/is-free`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ is_free: false }),
      });

      if (!cleanupRes.ok) {
        throw new Error(`HTTP ${cleanupRes.status}`);
      }

      const cleanupData = await cleanupRes.json();
      if (cleanupData.is_free !== false || cleanupData.free_until !== null) {
        throw new Error(
          `クリーンアップ後の状態が不正です: is_free = ${cleanupData.is_free}, free_until = ${cleanupData.free_until}`
        );
      }

      console.log('✅ 状態をOFF（is_free === false かつ free_until === null）に戻しました');
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
  }

  // 結果の集約
  if (testError && cleanupError) {
    console.error('\n❌ テスト本体とクリーンアップの両方が失敗しました');
    console.error('テスト本体:', testError.message);
    console.error('クリーンアップ:', cleanupError.message);
    process.exitCode = 1;
  } else if (testError) {
    console.error('\n❌ テスト本体が失敗しました');
    console.error('原因:', testError.message);
    process.exitCode = 1;
  } else if (cleanupError) {
    console.error('\n❌ クリーンアップが失敗しました');
    console.error('原因:', cleanupError.message);
    console.error('手動で状態を確認し、必要に応じてOFFに戻してください。');
    process.exitCode = 1;
  }
}

runExtendIntegrationTest().catch((error: unknown) => {
  // テスト開始前の状態確認に失敗した場合は、クリーンアップによる変更を一切行わない
  const message = error instanceof Error ? error.message : String(error);
  console.error('❌ 統合テスト失敗:', message);
  process.exitCode = 1;
});
