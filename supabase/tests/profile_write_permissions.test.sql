-- 専用ローカルSupabaseのみ。全マイグレーション適用後、管理ロールでpsqlから実行。
-- psql --dbname=<専用ローカル接続先> -v ON_ERROR_STOP=1 -f supabase/tests/profile_write_permissions.test.sql
-- SET ROLEで実権限を検証する。全データ変更はROLLBACKする。
\set ON_ERROR_STOP on
begin;
set local plpgsql.check_asserts = on;

-- 古いテーブルACL・列ACLと追加PERMISSIVEポリシーを模擬して再適用する。
-- この再適用もfixtureも最後に取り消される（専用テストDBのみ）。
grant insert, update on public.profiles to public, anon, authenticated;
grant insert (id, is_free), update (is_free, free_until, id, created_at)
  on public.profiles to public, anon, authenticated;
create policy "profile ACL test permissive update" on public.profiles
  for update to authenticated using (true) with check (true);
\ir ../migrations/20261111000000_restrict_profile_client_writes.sql

-- ログインを行わないDB権限テストのため、認証確認日時は設定しない。
-- 旧Authのconfirmed_at、新Authのemail_confirmed_at/生成列confirmed_atの差に依存しない。
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values
 ('a6111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'profile-acl-a@example.test', '', now(), now()),
 ('a6222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'profile-acl-b@example.test', '', now(), now());

do $$
declare r text; c text; f text;
begin
  assert (select count(*) = 2 from public.profiles where id in (
    'a6111111-1111-4111-8111-111111111111', 'a6222222-2222-4222-8222-222222222222')),
    'auth trigger did not create profiles';
  foreach r in array array['anon', 'authenticated'] loop
    assert not has_any_column_privilege(r, 'public.profiles', 'INSERT'), 'client INSERT privilege remains';
    foreach c in array array['id', 'created_at', 'is_free', 'free_until'] loop
      assert not has_column_privilege(r, 'public.profiles', c, 'UPDATE'), 'protected column UPDATE privilege remains';
    end loop;
    foreach f in array array[
      'public.toggle_profile_is_free(uuid)',
      'public.set_profile_is_free(uuid,boolean,integer)',
      'public.extend_profile_is_free(uuid)',
      'public.extend_profile_is_free_from_notification(uuid,uuid)',
      'public.auto_expire_free_status()'
    ] loop
      assert not has_function_privilege(r, f, 'EXECUTE'), 'client RPC permission remains';
      assert has_function_privilege('service_role', f, 'EXECUTE'), 'service RPC permission missing';
    end loop;
  end loop;
  foreach c in array array['username', 'coment', 'avatar_url'] loop
    assert has_column_privilege('authenticated', 'public.profiles', c, 'UPDATE'), 'editable column UPDATE missing';
    assert not has_column_privilege('anon', 'public.profiles', c, 'UPDATE'), 'anon editable column UPDATE remains';
  end loop;
end $$;

select set_config('request.jwt.claim.sub', 'a6111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claims', '{"sub":"a6111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n integer; c text;
begin
  update public.profiles set username = 'edited', coment = 'comment', avatar_url = 'https://example.test/avatar'
    where id = 'a6111111-1111-4111-8111-111111111111';
  get diagnostics n = row_count;
  assert n = 1, 'own editable columns were not updated';
  assert (select username = 'edited' and coment = 'comment' and avatar_url = 'https://example.test/avatar'
    from public.profiles where id = 'a6111111-1111-4111-8111-111111111111'), 'edited values were not saved';
  update public.profiles set username = 'forbidden' where id = 'a6222222-2222-4222-8222-222222222222';
  get diagnostics n = row_count;
  assert n = 0, 'another profile was updated';
  foreach c in array array['is_free', 'free_until', 'id', 'created_at'] loop
    begin
      execute format('update public.profiles set %1$I = %1$I where id = %2$L', c, 'a6111111-1111-4111-8111-111111111111');
      raise exception 'protected UPDATE unexpectedly succeeded: %', c;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    -- 既存IDでも、制約違反ではなく権限エラーで拒否されることを確認。
    insert into public.profiles (id, username) values ('a6111111-1111-4111-8111-111111111111', 'forbidden');
    raise exception 'client INSERT unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  begin
    update public.profiles set username = 'forbidden';
    raise exception 'anon UPDATE unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.profiles (id) values ('a6111111-1111-4111-8111-111111111111');
    raise exception 'anon INSERT unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role service_role;
do $$
declare p record; before_until timestamptz; claim record; valid record; accepted boolean;
begin
  select * into p from public.set_profile_is_free('a6111111-1111-4111-8111-111111111111', true, 30);
  assert p.is_free and p.free_until = now() + interval '30 minutes', 'timer ON failed';
  before_until := p.free_until;
  select * into p from public.set_profile_is_free('a6111111-1111-4111-8111-111111111111', true, 60);
  assert p.free_until = before_until, 're-ON overwrote timer';
  select * into p from public.extend_profile_is_free('a6111111-1111-4111-8111-111111111111');
  assert p.free_until = before_until + interval '30 minutes', '30 minute extension failed';
  perform public.set_profile_is_free('a6111111-1111-4111-8111-111111111111', false, null);
  assert public.toggle_profile_is_free('a6111111-1111-4111-8111-111111111111'), 'toggle ON failed';
  assert not public.toggle_profile_is_free('a6111111-1111-4111-8111-111111111111'), 'toggle OFF failed';

  -- 通知対象と期限切れをservice_roleで準備し、実RPCを通す。
  update public.profiles set is_free = true, free_until = now() + interval '4 minutes'
    where id = 'a6111111-1111-4111-8111-111111111111';
  select * into claim from public.claim_free_end_notifications()
    where user_id = 'a6111111-1111-4111-8111-111111111111';
  assert claim.claim_id is not null, 'notification claim failed';
  select * into valid from public.validate_free_end_notification(claim.claim_id, claim.lease_token);
  assert valid.owned and valid.still_valid, 'notification lease validation failed';
  accepted := public.complete_free_end_notification(claim.claim_id, claim.lease_token, 'sent');
  assert accepted, 'notification completion failed';
  select * into p from public.extend_profile_is_free_from_notification(
    'a6111111-1111-4111-8111-111111111111', claim.claim_id);
  assert p.free_until = claim.free_until + interval '30 minutes', 'notification extension failed';
  begin
    perform public.extend_profile_is_free_from_notification('a6111111-1111-4111-8111-111111111111', claim.claim_id);
    raise exception 'duplicate notification extension succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Cannot extend: free_until has changed since notification' then raise; end if;
  end;
  update public.profiles set is_free = true, free_until = now() - interval '1 minute'
    where id = 'a6222222-2222-4222-8222-222222222222';
  perform public.auto_expire_free_status();
  assert (select not is_free and free_until is null from public.profiles
    where id = 'a6222222-2222-4222-8222-222222222222'), 'auto expiry failed';
end $$;
reset role;
rollback;
select 'profile_write_permissions: ALL TESTS PASSED' as result;
