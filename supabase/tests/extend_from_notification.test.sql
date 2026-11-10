
-- extend_profile_is_free_from_notification のDB関数テスト
-- ローカルSupabase専用
-- 全マイグレーション適用済みであること

\set ON_ERROR_STOP on

-- テスト中の変更は最後にすべて取り消す
begin;
set local plpgsql.check_asserts = on;

-- テストユーザーのID
-- 666... : 正常延長・二重延長
-- 777... : 他人のclaim・pending・存在しないclaim
-- 888... : OFF状態

-- 前回のテストデータが残っている場合のクリーンアップ
delete from public.free_end_notification_claims
where user_id in (
  '66666666-6666-6666-6666-666666666666',
  '77777777-7777-7777-7777-777777777777',
  '88888888-8888-8888-8888-888888888888'
);

delete from public.profiles
where id in (
  '66666666-6666-6666-6666-666666666666',
  '77777777-7777-7777-7777-777777777777',
  '88888888-8888-8888-8888-888888888888'
);

delete from auth.users
where id in (
  '66666666-6666-6666-6666-666666666666',
  '77777777-7777-7777-7777-777777777777',
  '88888888-8888-8888-8888-888888888888'
);

-- テストユーザー作成
-- ログインを行わないため確認日時は不要。旧Authのconfirmed_atと、
-- 新Authのemail_confirmed_at/生成列confirmed_atの違いに依存しない。
insert into auth.users (
  id, instance_id, aud, role, email,
  encrypted_password,
  created_at, updated_at
)
values
(
  '66666666-6666-6666-6666-666666666666',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'ext1@example.com', '', now(), now()
),
(
  '77777777-7777-7777-7777-777777777777',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'ext2@example.com', '', now(), now()
),
(
  '88888888-8888-8888-8888-888888888888',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'ext3@example.com', '', now(), now()
);

-- profilesはトリガーによって自動作成される
update public.profiles
set is_free = true,
    free_until = now() + interval '5 minutes'
where id = '66666666-6666-6666-6666-666666666666';

update public.profiles
set is_free = true,
    free_until = now() + interval '5 minutes'
where id = '77777777-7777-7777-7777-777777777777';

update public.profiles
set is_free = false,
    free_until = null
where id = '88888888-8888-8888-8888-888888888888';

-- 1. 正常な延長
do $$
declare
  v_claim_id uuid;
  v_free_until timestamptz;
  v_result record;
begin
  select free_until into v_free_until
  from public.profiles
  where id = '66666666-6666-6666-6666-666666666666';

  insert into public.free_end_notification_claims
    (user_id, free_until, status, sent_at)
  values (
    '66666666-6666-6666-6666-666666666666',
    v_free_until, 'sent', now()
  )
  returning id into v_claim_id;

  select * into v_result
  from public.extend_profile_is_free_from_notification(
    '66666666-6666-6666-6666-666666666666',
    v_claim_id
  );

  assert v_result.is_free = true,
    '延長後のis_freeがtrueではない';

  assert v_result.free_until =
    v_free_until + interval '30 minutes',
    '30分延長されていない';

  raise notice 'PASS: 1. 正常な延長';
end $$;

-- 2. 二重延長の防止
do $$
declare
  v_claim_id uuid;
  v_rejected boolean := false;
begin
  select id into v_claim_id
  from public.free_end_notification_claims
  where user_id = '66666666-6666-6666-6666-666666666666';

  begin
    perform public.extend_profile_is_free_from_notification(
      '66666666-6666-6666-6666-666666666666',
      v_claim_id
    );
  exception when raise_exception then
    if sqlerrm <> 'Cannot extend: free_until has changed since notification' then
      raise;
    end if;
    v_rejected := true;
  end;

  assert v_rejected,
    '二重延長が拒否されていない';

  raise notice 'PASS: 2. 二重延長の防止';
end $$;

-- 3. 他人のclaim拒否
do $$
declare
  v_claim_id uuid;
  v_free_until timestamptz;
  v_rejected boolean := false;
begin
  select free_until into v_free_until
  from public.profiles
  where id = '77777777-7777-7777-7777-777777777777';

  insert into public.free_end_notification_claims
    (user_id, free_until, status, sent_at)
  values (
    '77777777-7777-7777-7777-777777777777',
    v_free_until, 'sent', now()
  )
  returning id into v_claim_id;

  begin
    perform public.extend_profile_is_free_from_notification(
      '66666666-6666-6666-6666-666666666666',
      v_claim_id
    );
  exception when raise_exception then
    if sqlerrm <> 'Cannot extend: notification claim not found' then
      raise;
    end if;
    v_rejected := true;
  end;

  assert v_rejected,
    '他人のclaimが拒否されていない';

  raise notice 'PASS: 3. 他人のclaim拒否';
end $$;

-- 4. sent以外のclaim拒否
do $$
declare
  v_claim_id uuid;
  v_free_until timestamptz;
  v_rejected boolean := false;
begin
  -- 3番とは異なる終了時刻に変更
  update public.profiles
  set free_until = now() + interval '10 minutes'
  where id = '77777777-7777-7777-7777-777777777777'
  returning free_until into v_free_until;

  insert into public.free_end_notification_claims
    (user_id, free_until, status)
  values (
    '77777777-7777-7777-7777-777777777777',
    v_free_until, 'pending'
  )
  returning id into v_claim_id;

  begin
    perform public.extend_profile_is_free_from_notification(
      '77777777-7777-7777-7777-777777777777',
      v_claim_id
    );
  exception when raise_exception then
    if sqlerrm <> 'Cannot extend: notification claim is not sent' then
      raise;
    end if;
    v_rejected := true;
  end;

  assert v_rejected,
    'pendingのclaimが拒否されていない';

  raise notice 'PASS: 4. sent以外のclaim拒否';
end $$;

-- 5. OFF状態の拒否
do $$
declare
  v_rejected boolean := false;
begin
  begin
    perform public.extend_profile_is_free_from_notification(
      '88888888-8888-8888-8888-888888888888',
      gen_random_uuid()
    );
  exception when raise_exception then
    if sqlerrm <> 'Cannot extend: not in an active timed free state' then
      raise;
    end if;
    v_rejected := true;
  end;

  assert v_rejected,
    'OFF状態の延長が拒否されていない';

  raise notice 'PASS: 5. OFF状態拒否';
end $$;

-- 6. 存在しないclaimの拒否
do $$
declare
  v_rejected boolean := false;
begin
  begin
    perform public.extend_profile_is_free_from_notification(
      '77777777-7777-7777-7777-777777777777',
      gen_random_uuid()
    );
  exception when raise_exception then
    if sqlerrm <> 'Cannot extend: notification claim not found' then
      raise;
    end if;
    v_rejected := true;
  end;

  assert v_rejected,
    '存在しないclaimが拒否されていない';

  raise notice 'PASS: 6. 存在しないclaim拒否';
end $$;

-- テスト成功時もDBの変更を残さない
rollback;

select 'ALL TESTS PASSED' as result;
