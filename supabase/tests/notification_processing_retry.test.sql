-- Disposable DB only, after all migrations. Every fixture is rolled back.
\set ON_ERROR_STOP on
begin;
set local plpgsql.check_asserts = on;
insert into auth.users(id) values
 ('a8141111-1111-4111-8111-111111111111'),
 ('a8142222-2222-4222-8222-222222222222');
set local role service_role;
do $$
declare actor uuid := 'a8141111-1111-4111-8111-111111111111'; c record; state record;
begin
  update public.profiles set is_free=true, free_until=clock_timestamp()+interval '4 minutes' where id=actor;
  select * into c from public.claim_free_end_notifications() where user_id=actor;
  assert c.claim_id is not null, 'claim was not created';
  begin
    perform public.extend_profile_is_free_from_notification(actor,c.claim_id);
    raise exception 'processing claim was extended';
  exception when raise_exception then
    if sqlerrm <> 'Cannot extend: notification claim is processing' then raise; end if;
  end;
  assert (select free_until=c.free_until from public.profiles where id=actor), 'processing changed the timer';
  update public.profiles set free_until=clock_timestamp()+interval '5 minutes' where id=actor;
  begin
    perform public.extend_profile_is_free_from_notification(actor,c.claim_id);
    raise exception 'stale processing claim was extended';
  exception when raise_exception then
    if sqlerrm <> 'Cannot extend: notification claim is not sent' then raise; end if;
  end;
  update public.profiles set free_until=c.free_until where id=actor;
  assert public.complete_free_end_notification(c.claim_id,c.lease_token,'sent'), 'sender cannot complete claim';
  select * into state from public.extend_profile_is_free_from_notification(actor,c.claim_id);
  assert state.free_until=c.free_until+interval '30 minutes', 'retry after sent did not extend exactly 30 minutes';
  begin
    perform public.extend_profile_is_free_from_notification(actor,c.claim_id);
    raise exception 'duplicate extension succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Cannot extend: free_until has changed since notification' then raise; end if;
  end;
  update public.profiles set is_free=true,free_until=c.free_until where id='a8142222-2222-4222-8222-222222222222';
  begin
    perform public.extend_profile_is_free_from_notification('a8142222-2222-4222-8222-222222222222',c.claim_id);
    raise exception 'another user used the claim';
  exception when raise_exception then
    if sqlerrm <> 'Cannot extend: notification claim not found' then raise; end if;
  end;
  raise notice 'PASS: processing, stale claim, sent retry, duplicate and ownership';
end $$;
reset role;
rollback;
