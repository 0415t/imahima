-- 専用ローカルDBのみ。全マイグレーション適用後、管理ロールで実行する。
-- 外部Pushは送らない。BEGIN/ROLLBACKで全fixtureと障害注入を取り消す。
\set ON_ERROR_STOP on
begin;
set local plpgsql.check_asserts = on;

create function pg_temp.test_user(n integer) returns uuid language sql immutable as $$
  select ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
$$;
insert into auth.users (id, email, role, aud, created_at, updated_at)
select pg_temp.test_user(i), 'member-free-' || i || '@example.test', 'authenticated', 'authenticated', now(), now()
from generate_series(1, 8) i;
-- receivers: 2=timed ON, 3=indefinite ON, 4=OFF, 5=expired, 6=other room, 7=late ON, 8=no room
update public.profiles set username = '太郎' where id = pg_temp.test_user(1);
update public.profiles set is_free = true, free_until = now() + interval '1 hour'
where id in (pg_temp.test_user(2), pg_temp.test_user(6), pg_temp.test_user(8));
update public.profiles set is_free = true, free_until = null where id = pg_temp.test_user(3);
update public.profiles set is_free = true, free_until = now() - interval '1 minute' where id = pg_temp.test_user(5);
insert into public.rooms (id, room_name) values
 ('b0000000-0000-4000-8000-000000000001', 'one'),
 ('b0000000-0000-4000-8000-000000000002', 'two'),
 ('b0000000-0000-4000-8000-000000000003', 'other');
insert into public.room_members (room_id, user_id)
select 'b0000000-0000-4000-8000-000000000001'::uuid, pg_temp.test_user(i) from generate_series(1, 5) i;
insert into public.room_members (room_id, user_id) values
 ('b0000000-0000-4000-8000-000000000002', pg_temp.test_user(1)),
 ('b0000000-0000-4000-8000-000000000002', pg_temp.test_user(2)),
 ('b0000000-0000-4000-8000-000000000003', pg_temp.test_user(6)),
 ('b0000000-0000-4000-8000-000000000001', pg_temp.test_user(7));

create function pg_temp.new_test_event() returns uuid language plpgsql as $$
declare event_uuid uuid;
begin
  perform public.set_profile_is_free(pg_temp.test_user(1), false, null);
  perform public.set_profile_is_free(pg_temp.test_user(1), true, 30);
  select e.id into strict event_uuid from public.member_free_events e join public.profiles p
    on p.id = e.actor_user_id and p.free_period_id = e.actor_period_id where p.id = pg_temp.test_user(1);
  return event_uuid;
end $$;

do $$
declare e uuid; old_period uuid; n integer;
begin
  e := pg_temp.new_test_event();
  select count(*) into n from public.member_free_notifications where event_id = e;
  assert n = 2, 'expected only recipients 2 and 3 (deduplicated, self/OFF/expired/other/no-room excluded)';
  assert not exists (select 1 from public.member_free_notifications where event_id = e
    and recipient_user_id not in (pg_temp.test_user(2), pg_temp.test_user(3))), 'wrong recipient';
  begin
    insert into public.member_free_notifications(event_id, recipient_user_id, recipient_period_id)
      select event_id, recipient_user_id, recipient_period_id from public.member_free_notifications
      where event_id = e and recipient_user_id = pg_temp.test_user(2);
    raise exception 'duplicate recipient registration succeeded';
  exception when unique_violation then null;
  end;
  assert (select actor_name = '太郎' from public.member_free_events where id = e), 'name snapshot missing';
  select free_period_id into old_period from public.profiles where id = pg_temp.test_user(1);
  perform public.set_profile_is_free(pg_temp.test_user(1), true, 60);
  perform public.extend_profile_is_free(pg_temp.test_user(1));
  assert (select free_period_id = old_period from public.profiles where id = pg_temp.test_user(1)), 'extension changed ON period';
  assert (select count(*) = 1 from public.member_free_events where actor_user_id = pg_temp.test_user(1)), 're-ON/extension generated event';
  perform public.set_profile_is_free(pg_temp.test_user(1), false, null);
  assert (select count(*) = 1 from public.member_free_events where actor_user_id = pg_temp.test_user(1)), 'OFF generated event';
  assert public.toggle_profile_is_free(pg_temp.test_user(1)), 'toggle ON failed';
  assert (select count(*) = 2 from public.member_free_events where actor_user_id = pg_temp.test_user(1)), 'toggle ON did not generate event';
  update public.profiles set is_free = true, free_until = now() - interval '1 minute' where id = pg_temp.test_user(1);
  perform public.set_profile_is_free(pg_temp.test_user(1), true, 30);
  assert (select count(*) = 3 from public.member_free_events where actor_user_id = pg_temp.test_user(1)), 'expired re-ON missing';
  perform pg_temp.new_test_event();
  assert (select count(*) = 4 from public.member_free_events where actor_user_id = pg_temp.test_user(1)), 'cooldown incorrectly suppressed event';
  raise notice 'PASS: transitions, expiry, extension, recipients and deduplication';
end $$;

-- イベント/受信者INSERT失敗はプロフィール更新もロールバックする。
create function pg_temp.reject_outbox() returns trigger language plpgsql as $$
begin raise exception 'injected outbox failure'; end $$;
create trigger reject_outbox before insert on public.member_free_notifications
for each row execute function pg_temp.reject_outbox();
do $$
declare old_count bigint;
begin
  perform public.set_profile_is_free(pg_temp.test_user(1), false, null);
  select count(*) into old_count from public.member_free_events;
  begin
    perform public.set_profile_is_free(pg_temp.test_user(1), true, 30);
    raise exception 'outbox failure was swallowed';
  exception when raise_exception then
    if sqlerrm <> 'injected outbox failure' then raise; end if;
  end;
  assert (select is_free = false and free_period_id is null from public.profiles where id = pg_temp.test_user(1)), 'ON was not rolled back';
  assert (select count(*) = old_count from public.member_free_events), 'partial event persisted';
  raise notice 'PASS: atomic rollback on outbox failure';
end $$;
drop trigger reject_outbox on public.member_free_notifications;

-- 各条件の変化と古いON期間を検証。候補は後から追加しない。
do $$
declare e uuid; id uuid;
begin
  e := pg_temp.new_test_event();
  perform public.set_profile_is_free(pg_temp.test_user(7), true, 30);
  assert not exists (select 1 from public.member_free_notifications where event_id = e and recipient_user_id = pg_temp.test_user(7)), 'late user added';
  perform public.set_profile_is_free(pg_temp.test_user(7), false, null);
  select n.id into strict id from public.member_free_notifications n where event_id = e and recipient_user_id = pg_temp.test_user(2);
  assert public.member_free_notification_is_valid(id), 'valid notification rejected';
  perform public.set_profile_is_free(pg_temp.test_user(1), false, null);
  assert not public.member_free_notification_is_valid(id), 'actor OFF accepted';
  perform public.set_profile_is_free(pg_temp.test_user(1), true, 30);
  assert not public.member_free_notification_is_valid(id), 'old actor period accepted after re-ON';
  e := pg_temp.new_test_event();
  select n.id into strict id from public.member_free_notifications n where event_id = e and recipient_user_id = pg_temp.test_user(2);
  update public.profiles set free_until = now() - interval '1 minute' where profiles.id = pg_temp.test_user(1);
  assert not public.member_free_notification_is_valid(id), 'expired actor accepted';
  e := pg_temp.new_test_event();
  select n.id into strict id from public.member_free_notifications n where event_id = e and recipient_user_id = pg_temp.test_user(2);
  perform public.set_profile_is_free(pg_temp.test_user(2), false, null);
  assert not public.member_free_notification_is_valid(id), 'recipient OFF accepted';
  perform public.set_profile_is_free(pg_temp.test_user(2), true, 60);
  assert not public.member_free_notification_is_valid(id), 'old recipient period accepted';
  e := pg_temp.new_test_event();
  select n.id into strict id from public.member_free_notifications n where event_id = e and recipient_user_id = pg_temp.test_user(2);
  update public.profiles set free_until = now() - interval '1 minute' where profiles.id = pg_temp.test_user(2);
  assert not public.member_free_notification_is_valid(id), 'expired recipient accepted';
  perform public.set_profile_is_free(pg_temp.test_user(2), true, 60);
  e := pg_temp.new_test_event();
  select n.id into strict id from public.member_free_notifications n where event_id = e and recipient_user_id = pg_temp.test_user(2);
  delete from public.room_members where user_id = pg_temp.test_user(2);
  assert not public.member_free_notification_is_valid(id), 'unrelated recipients accepted';
  insert into public.room_members (room_id, user_id) values ('b0000000-0000-4000-8000-000000000001', pg_temp.test_user(2));
  raise notice 'PASS: snapshot and pre-send eligibility';
end $$;

-- claim/lease/再試行の実SQL検証。DB時刻は固定なので期限列を明示的に動かす。
do $$
declare e uuid; c record; c2 record; v record; old_token uuid;
begin
  -- 前段のfixtureイベントを取消して、このイベントだけをclaim対象にする。
  update public.member_free_notifications set status = 'cancelled';
  e := pg_temp.new_test_event();
  select * into strict c from public.claim_member_free_notifications(1000, 120, 2) where event_id = e and recipient_user_id = pg_temp.test_user(2);
  assert c.attempts = 1 and c.lease_token is not null, 'claim failed';
  assert not exists (select 1 from public.claim_member_free_notifications(1000, 120, 2) where event_id = e), 'live lease double claimed';
  select * into v from public.validate_member_free_notification(c.notification_id, c.lease_token);
  assert v.owned and v.still_valid, 'lease validation failed';
  old_token := c.lease_token;
  update public.member_free_notifications set lease_expires_at = now() - interval '1 second' where id = c.notification_id;
  select * into strict c2 from public.claim_member_free_notifications(1000, 120, 2) where notification_id = c.notification_id;
  assert c2.attempts = 2 and c2.lease_token <> old_token, 'expired lease not reclaimed';
  assert not public.complete_member_free_notification(c.notification_id, old_token, 'sent', null, 1), 'stale lease completed';
  assert public.complete_member_free_notification(c2.notification_id, c2.lease_token, 'failed', 'temporary', 0), 'failure not recorded';
  assert (select status = 'exhausted' from public.member_free_notifications where id = c2.notification_id), 'attempt limit not terminal';
  assert (select is_free is true from public.profiles where id = pg_temp.test_user(1)), 'send failure rolled back actor ON';

  update public.member_free_notifications set status = 'cancelled';
  e := pg_temp.new_test_event();
  select * into strict c from public.claim_member_free_notifications(1000, 120, 3) where event_id = e and recipient_user_id = pg_temp.test_user(2);
  assert public.complete_member_free_notification(c.notification_id, c.lease_token, 'failed', 'unknown', 0), 'failure not stored';
  assert (select next_attempt_at > now() from public.member_free_notifications where id = c.notification_id), 'backoff not scheduled';
  assert not exists (select 1 from public.claim_member_free_notifications(1000, 120, 3) where notification_id = c.notification_id), 'backoff ignored';
  update public.member_free_notifications set next_attempt_at = now() where id = c.notification_id;
  select * into strict c2 from public.claim_member_free_notifications(1000, 120, 3) where notification_id = c.notification_id;
  assert public.complete_member_free_notification(c2.notification_id, c2.lease_token, 'sent', 'one device failed', 1), 'acceptance not recorded';
  assert (select status = 'sent' and accepted_count = 1 and last_error = 'one device failed' from public.member_free_notifications where id = c.notification_id), 'partial acceptance missing';
  raise notice 'PASS: claims, lease recovery, stale owner, backoff, max attempts and partial acceptance';
end $$;

do $$
declare r text; f record;
begin
  foreach r in array array['anon', 'authenticated'] loop
    assert not has_table_privilege(r, 'public.member_free_events', 'INSERT,UPDATE,DELETE'), 'event writes exposed';
    assert not has_table_privilege(r, 'public.member_free_notifications', 'INSERT,UPDATE,DELETE'), 'outbox writes exposed';
    assert not has_column_privilege(r, 'public.profiles', 'free_period_id', 'UPDATE'), 'period ID writable';
    for f in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('member_free_recipients', 'member_free_notification_is_valid',
        'claim_member_free_notifications', 'validate_member_free_notification', 'complete_member_free_notification') loop
      assert not has_function_privilege(r, f.oid, 'EXECUTE'), 'worker RPC exposed';
      assert has_function_privilege('service_role', f.oid, 'EXECUTE'), 'worker RPC inaccessible';
    end loop;
  end loop;
end $$;

set local role authenticated;
do $$
begin
  begin
    insert into public.member_free_events(actor_user_id, actor_period_id) values(gen_random_uuid(), gen_random_uuid());
    raise exception 'client event insertion succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.member_free_notifications set status = 'sent';
    raise exception 'client outbox update succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.member_free_notifications;
    raise exception 'client outbox deletion succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_member_free_notifications();
    raise exception 'client worker RPC succeeded';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role service_role;
do $$
declare n bigint;
begin
  select count(*) into n from public.member_free_notifications;
  perform public.claim_member_free_notifications(20, 120, 3);
end $$;
reset role;
rollback;
select 'member_free_notifications: ALL TESTS PASSED' as result;
