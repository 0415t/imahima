-- Uses the production device-token migration and the isolated Auth fixture.
begin;
revoke all on public.user_device_tokens from public, anon, authenticated, service_role;
grant select, delete on public.user_device_tokens to authenticated;

insert into auth.users(id) values
  ('10000000-0000-0000-0000-000000000018'),
  ('20000000-0000-0000-0000-000000000018');
insert into public.profiles(id, is_free) values ('10000000-0000-0000-0000-000000000018', true);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000018', true);
select public.upsert_device_token('current-device', 'android');
select public.upsert_device_token('other-device', 'ios');
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000018', true);
select public.upsert_device_token('b-device', 'ios');
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000018', true);

do $$
declare affected integer;
begin
  delete from public.user_device_tokens
    where user_id = '10000000-0000-0000-0000-000000000018' and expo_push_token = 'current-device';
  get diagnostics affected = row_count;
  assert affected = 1, 'Expected exactly one current-device deletion';
  delete from public.user_device_tokens
    where user_id = '10000000-0000-0000-0000-000000000018' and expo_push_token = 'current-device';
  get diagnostics affected = row_count;
  assert affected = 0, 'Expected idempotent deletion';
  delete from public.user_device_tokens
    where user_id = '20000000-0000-0000-0000-000000000018' and expo_push_token = 'b-device';
  get diagnostics affected = row_count;
  assert affected = 0, 'RLS must prevent deletion of another user’s token';
end $$;

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000018', true);
select public.upsert_device_token('current-device', 'android');
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000018', true);
delete from public.user_device_tokens
  where user_id = '10000000-0000-0000-0000-000000000018' and expo_push_token = 'current-device';

set local role anon;
do $$
begin
  begin
    delete from public.user_device_tokens where expo_push_token = 'current-device';
    raise exception 'Anonymous deletion unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
do $$
begin
  assert (select count(*) from public.user_device_tokens where expo_push_token in ('current-device','b-device')
    and user_id = '20000000-0000-0000-0000-000000000018') = 2, 'B must keep both tokens';
  assert (select count(*) from public.user_device_tokens where expo_push_token = 'other-device'
    and user_id = '10000000-0000-0000-0000-000000000018') = 1, 'A must keep its other device';
  assert (select is_free from public.profiles where id = '10000000-0000-0000-0000-000000000018'),
    'Logout must not change is_free';
end $$;
rollback;
