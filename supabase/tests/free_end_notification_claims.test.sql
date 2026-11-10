-- free_end_notification_claims のDB関数テスト
-- 実行方法（ローカルDBのみ。リモートへは実行しないこと）:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/free_end_notification_claims.test.sql
-- 前提: 全マイグレーション適用済みのローカルDB
-- 注意: encrypted_password は認証しないため空文字（pgcryptoへの依存を避ける）

\set ON_ERROR_STOP on

-- テスト用データのクリーンアップ（冪等）
delete from public.free_end_notification_claims
where user_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
                  '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
                  '55555555-5555-5555-5555-555555555555');
delete from public.profiles
where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
             '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
             '55555555-5555-5555-5555-555555555555');
delete from auth.users
where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
             '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
             '55555555-5555-5555-5555-555555555555');

-- テストユーザー作成（ローカルSupabase標準のinstance_idを使用）
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test1@example.com', '', now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test2@example.com', '', now(), now(), now()),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test3@example.com', '', now(), now(), now()),
  ('44444444-4444-4444-4444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test4@example.com', '', now(), now(), now()),
  ('55555555-5555-5555-5555-555555555555', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test5@example.com', '', now(), now(), now());

-- 注意: profiles に id/is_free/free_until 以外の NOT NULL 列がある場合は値を追加すること
-- （profiles作成マイグレーションがリポジトリに無く全列構成は未確認）
insert into public.profiles (id, is_free, free_until) values
  ('11111111-1111-1111-1111-111111111111', true, now() + interval '4 minutes'),  -- 通常対象
  ('22222222-2222-2222-2222-222222222222', true, now() + interval '4 minutes'),  -- 延長テスト用
  ('33333333-3333-3333-3333-333333333333', true, now() - interval '1 minute'),   -- 期限切れ: 対象外
  ('44444444-4444-4444-4444-444444444444', true, null),                          -- 無期限ON: 対象外
  ('55555555-5555-5555-5555-555555555555', true, now() + interval '4 minutes');  -- 手動OFFテスト用

-- 1. 通常の通知対象取得 + 期限切れ/無期限ONの除外
do $$
declare
  v_count integer;
begin
  perform public.claim_free_end_notifications();
  select count(*) into v_count from public.free_end_notification_claims;
  assert v_count = 3, format('期待3件(111,222,555)、実際%s件', v_count);
  assert not exists (
    select 1 from public.free_end_notification_claims c
    where c.user_id in ('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444')
  ), '期限切れ/無期限ONが登録されている';
  assert exists (
    select 1 from public.free_end_notification_claims c
    where c.user_id = '11111111-1111-1111-1111-111111111111'
      and c.status = 'processing' and c.attempts = 1
      and c.lease_token is not null and c.lease_expires_at > now()
  ), 'クレーム確保結果が不正';
  raise notice 'PASS: 1. 通常取得・除外';
end $$;

-- 2. 二重確保防止（再呼び出しで0件・重複行なし）
do $$
declare
  v_claimed integer;
  v_total integer;
begin
  select count(*) into v_claimed from public.claim_free_end_notifications();
  select count(*) into v_total from public.free_end_notification_claims;
  assert v_claimed = 0, format('2回目の確保で%s件返却された（全てprocessing中のはず）', v_claimed);
  assert v_total = 3, 'UNIQUE(user_id, free_until)違反：重複行が存在する';
  raise notice 'PASS: 2. 二重確保防止';
end $$;

-- 3. 手動OFF後の通知抑止
update public.profiles set is_free = false, free_until = null
where id = '55555555-5555-5555-5555-555555555555';
do $$
declare
  v_status text;
begin
  perform public.claim_free_end_notifications(); -- cancelステップが走る
  select c.status into v_status from public.free_end_notification_claims c
    where c.user_id = '55555555-5555-5555-5555-555555555555';
  assert v_status = 'cancelled', format('手動OFF後のstatusが%s', v_status);
  raise notice 'PASS: 3. 手動OFF抑止';
end $$;

-- 4. 30分延長後の再通知（旧claimはcancelled、新free_untilで新規claim可能）
do $$
declare
  v_old_until timestamptz;
  v_new_until timestamptz;
  v_old_status text;
  v_new record;
begin
  select p.free_until into v_old_until from public.profiles p
    where p.id = '22222222-2222-2222-2222-222222222222';
  -- 延長を模倣（窓の外へ）
  update public.profiles p set free_until = v_old_until + interval '30 minutes'
    where p.id = '22222222-2222-2222-2222-222222222222';
  perform public.claim_free_end_notifications();
  select c.status into v_old_status from public.free_end_notification_claims c
    where c.user_id = '22222222-2222-2222-2222-222222222222' and c.free_until = v_old_until;
  assert v_old_status = 'cancelled', format('延長前の古いclaimが%s', v_old_status);
  -- 新しい終了時刻が窓に入った状態を模倣
  update public.profiles p set free_until = now() + interval '4 minutes'
    where p.id = '22222222-2222-2222-2222-222222222222';
  select p.free_until into v_new_until from public.profiles p
    where p.id = '22222222-2222-2222-2222-222222222222';
  perform public.claim_free_end_notifications();
  select c.* into v_new from public.free_end_notification_claims c
    where c.user_id = '22222222-2222-2222-2222-222222222222' and c.free_until = v_new_until;
  assert v_new.status = 'processing' and v_new.attempts = 1, '延長後の新free_untilで再通知できていない';
  raise notice 'PASS: 4. 延長後の再通知';
end $$;

-- 5. lease期限切れ後の再試行 + 古いlease tokenによる状態更新拒否
do $$
declare
  v_claim record;
  v_reclaim record;
  v_val record;
  v_ok boolean;
begin
  select c.* into v_claim from public.free_end_notification_claims c
    where c.user_id = '11111111-1111-1111-1111-111111111111';
  -- ワーカー停止を模倣: leaseを期限切れにする
  update public.free_end_notification_claims c
    set lease_expires_at = now() - interval '1 minute'
    where c.id = v_claim.id;
  -- lease期限切れの間は validate が owned=false を返す（lease有効期限チェック）
  select v.* into v_val from public.validate_free_end_notification(v_claim.id, v_claim.lease_token) v;
  assert v_val.owned = false, 'lease期限切れなのにowned=trueが返された';
  -- 再確保できる
  select r.* into v_reclaim from public.claim_free_end_notifications() r
    where r.user_id = '11111111-1111-1111-1111-111111111111';
  assert v_reclaim.claim_id = v_claim.id, 'lease期限切れの再確保に失敗';
  assert v_reclaim.attempts = 2, format('attemptsが%s（2のはず）', v_reclaim.attempts);
  assert v_reclaim.lease_token <> v_claim.lease_token, 'lease tokenが再生成されていない';
  -- 再確保後は新tokenで owned=true
  select v.* into v_val from public.validate_free_end_notification(v_claim.id, v_reclaim.lease_token) v;
  assert v_val.owned = true and v_val.still_valid = true, '再確保後のvalidateが不正';
  -- 古いtokenでの完了は拒否
  select public.complete_free_end_notification(v_claim.id, v_claim.lease_token, 'sent') into v_ok;
  assert v_ok = false, '古いlease tokenでの更新が拒否されていない';
  -- 新しいtokenでの完了は成功
  select public.complete_free_end_notification(v_claim.id, v_reclaim.lease_token, 'sent') into v_ok;
  assert v_ok = true, '正当なlease tokenでの更新が失敗';
  raise notice 'PASS: 5. lease再試行・古いtoken拒否・lease期限チェック';
end $$;

-- 6. 失敗記録・再試行・最大試行回数
do $$
declare
  v_claim record;
  v_retry record;
  v_ok boolean;
  v_status text;
  v_attempts integer;
  v_error text;
begin
  select c.* into v_claim from public.free_end_notification_claims c
    where c.user_id = '22222222-2222-2222-2222-222222222222' and c.status = 'processing';
  -- 失敗記録
  select public.complete_free_end_notification(v_claim.id, v_claim.lease_token, 'failed', 'expo timeout') into v_ok;
  assert v_ok = true, 'failed記録に失敗';
  select c.status, c.last_error into v_status, v_error
    from public.free_end_notification_claims c where c.id = v_claim.id;
  assert v_status = 'failed' and v_error = 'expo timeout', '失敗時の状態・エラー記録が不正';
  -- 再試行できる
  select r.* into v_retry from public.claim_free_end_notifications() r
    where r.user_id = '22222222-2222-2222-2222-222222222222';
  assert v_retry.claim_id = v_claim.id and v_retry.attempts = 2, 'failedの再試行に失敗';
  -- 最大試行回数に到達したら再確保されない
  update public.free_end_notification_claims c set attempts = 3 where c.id = v_claim.id;
  select public.complete_free_end_notification(v_claim.id, v_retry.lease_token, 'failed', 'expo timeout') into v_ok;
  assert v_ok = true, '2回目のfailed記録に失敗';
  perform public.claim_free_end_notifications();
  select c.status, c.attempts into v_status, v_attempts
    from public.free_end_notification_claims c where c.id = v_claim.id;
  assert v_status = 'failed' and v_attempts = 3, '最大試行回数後も再確保されている';
  raise notice 'PASS: 6. 失敗記録・再試行・最大試行回数';
end $$;

-- 7. 送信前再検証RPC（positive caseと手動OFF検出）
do $$
declare
  v_claim record;
  v_val record;
  v_ok boolean;
begin
  -- 有効なクレームの再検証（positive case）
  update public.profiles p set is_free = true, free_until = now() + interval '4 minutes'
    where p.id = '55555555-5555-5555-5555-555555555555';
  select r.* into v_claim from public.claim_free_end_notifications() r
    where r.user_id = '55555555-5555-5555-5555-555555555555';
  select v.* into v_val from public.validate_free_end_notification(v_claim.claim_id, v_claim.lease_token) v;
  assert v_val.owned = true and v_val.still_valid = true, '有効なclaimの再検証に失敗';
  -- 送信直前に手動OFFされた場合を模倣
  update public.profiles p set is_free = false, free_until = null
    where p.id = '55555555-5555-5555-5555-555555555555';
  select v.* into v_val from public.validate_free_end_notification(v_claim.claim_id, v_claim.lease_token) v;
  assert v_val.owned = true and v_val.still_valid = false, '手動OFF後の再検証がstill_validを検出できていない';
  -- ワーカーは送信せずcancelledで完了できる
  select public.complete_free_end_notification(v_claim.claim_id, v_claim.lease_token, 'cancelled') into v_ok;
  assert v_ok = true, 'cancelled完了に失敗';
  raise notice 'PASS: 7. 送信前再検証';
end $$;

-- 8. RPC引数バリデーション
do $$
begin
  begin
    perform public.claim_free_end_notifications(0);
    assert false, 'p_limit=0 が拒否されていない';
  exception when raise_exception then
    null;
  end;
  begin
    perform public.complete_free_end_notification(
      gen_random_uuid(), gen_random_uuid(), 'invalid_status');
    assert false, '不正なp_status が拒否されていない';
  exception when raise_exception then
    null;
  end;
  raise notice 'PASS: 8. 引数バリデーション';
end $$;

-- クリーンアップ
delete from public.free_end_notification_claims
where user_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
                  '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
                  '55555555-5555-5555-5555-555555555555');
delete from public.profiles
where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
             '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
             '55555555-5555-5555-5555-555555555555');
delete from auth.users
where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
             '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
             '55555555-5555-5555-5555-555555555555');

select 'ALL TESTS PASSED' as result;
