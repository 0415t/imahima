-- Dedicated local DB only, after ALL repository migrations and Auth prerequisites.
-- Unlike the group-only fixture tests, this exercises the actual timer/Push RPCs
-- together with group management and the profile ACL migration. All data rolls back.
\set ON_ERROR_STOP on
begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id) values ('a7111111-1111-4111-8111-111111111111');

create function pg_temp.expect_group_availability(actor uuid, room uuid, expected boolean)
returns void language plpgsql as $$
declare before_state jsonb; result jsonb;
begin
  select to_jsonb(p) into before_state from public.profiles p where id = actor;
  result := public.group_mvp_execute('members', actor, jsonb_build_object('room_id', room));
  assert (result->>'status')::integer = 200, 'group member read failed';
  assert (result#>>'{data,members,0,is_free}')::boolean = expected, 'wrong effective group availability';
  assert (select to_jsonb(p) = before_state from public.profiles p where id = actor),
    'group member read changed profile or timer state';
end $$;

set local role service_role;
do $$
declare
  actor uuid := 'a7111111-1111-4111-8111-111111111111';
  room uuid;
  result jsonb;
  state record;
  claim record;
  validation record;
  deadline timestamptz;
  started_at timestamptz;
begin
  result := public.group_mvp_execute('create', actor, '{"name":"Timer and notifications"}');
  assert (result->>'status')::integer = 201, 'group creation failed with merged grants';
  room := (result#>>'{data,group,id}')::uuid;

  started_at := clock_timestamp();
  select * into state from public.set_profile_is_free(actor, true, null);
  assert state.is_free and state.free_until is null, 'unlimited ON failed';
  perform pg_temp.expect_group_availability(actor, room, true);
  started_at := clock_timestamp();
  select * into state from public.set_profile_is_free(actor, true, 30);
  assert state.free_until is null, 're-ON replaced unlimited state';
  raise notice 'PASS: unlimited ON and preserved state visible in groups';

  perform public.set_profile_is_free(actor, false, null);
  started_at := clock_timestamp();
  select * into state from public.set_profile_is_free(actor, true, 30);
  deadline := state.free_until;
  assert deadline between started_at + interval '30 minutes' and clock_timestamp() + interval '30 minutes', 'timed ON failed';
  started_at := clock_timestamp();
  select * into state from public.set_profile_is_free(actor, true, 60);
  assert state.free_until = deadline, 're-ON overwrote the existing timer';
  select * into state from public.extend_profile_is_free(actor);
  assert state.free_until = deadline + interval '30 minutes', 'manual extension failed';
  perform pg_temp.expect_group_availability(actor, room, true);
  raise notice 'PASS: timed ON, repeated ON and extension visible without group-side writes';

  update public.profiles set free_until = now() + interval '4 minutes' where id = actor;
  select * into claim from public.claim_free_end_notifications() where user_id = actor;
  assert claim.claim_id is not null, 'notification claim failed with group/profile grants';
  select * into validation from public.validate_free_end_notification(claim.claim_id, claim.lease_token);
  assert validation.owned and validation.still_valid, 'notification validation failed';
  assert public.complete_free_end_notification(claim.claim_id, claim.lease_token, 'sent'),
    'notification completion failed';
  select * into state from public.extend_profile_is_free_from_notification(actor, claim.claim_id);
  assert state.free_until = claim.free_until + interval '30 minutes', 'notification extension failed';
  begin
    perform public.extend_profile_is_free_from_notification(actor, claim.claim_id);
    raise exception 'duplicate notification extension succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Cannot extend: free_until has changed since notification' then raise; end if;
  end;
  perform pg_temp.expect_group_availability(actor, room, true);
  raise notice 'PASS: notification claim/validation/completion/extension and duplicate rejection';

  perform public.set_profile_is_free(actor, false, null);
  perform pg_temp.expect_group_availability(actor, room, false);
  update public.profiles set is_free = true, free_until = now() - interval '1 minute' where id = actor;
  perform pg_temp.expect_group_availability(actor, room, false);
  assert (select is_free from public.profiles where id = actor), 'member read performed expiration';
  raise notice 'PASS: OFF and expired timers are displayed without mutation';

  perform public.auto_expire_free_status();
  assert (select not is_free and free_until is null from public.profiles where id = actor),
    'automatic expiration failed';
  started_at := clock_timestamp();
  select * into state from public.set_profile_is_free(actor, true, 60);
  assert state.is_free and state.free_until between started_at + interval '60 minutes' and clock_timestamp() + interval '60 minutes', 're-ON after expiry failed';
  perform pg_temp.expect_group_availability(actor, room, true);
  raise notice 'PASS: auto-expiry and renewed timer coexist with group membership';

  result := public.group_mvp_execute('leave', actor, jsonb_build_object('room_id', room));
  assert (result->>'status')::integer = 204, 'group leave failed';
  assert (select mvp_archived_at is not null from public.rooms where id = room), 'empty MVP room not archived';
  assert (select is_free and free_until = state.free_until from public.profiles where id = actor),
    'group departure changed availability';
  raise notice 'PASS: group departure archives the room without changing the timer';
end $$;
reset role;
rollback;
select 'ALL GROUP/TIMER/NOTIFICATION TESTS PASSED' as result;
