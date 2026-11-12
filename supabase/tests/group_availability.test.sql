-- Isolated fixture DB only, after group_mvp_schema.sql and the group migration.
-- Exercises states from the user-confirmed timer contract, NOT replicas of the
-- production timer functions. Does not establish Push/job integration coverage.
begin;
insert into auth.users(id) values ('66666666-6666-4666-8666-666666666666');
insert into public.profiles(id, username) values ('66666666-6666-4666-8666-666666666666', 'Timer test');
create temporary table availability_test_room as
select (public.group_mvp_execute('create', '66666666-6666-4666-8666-666666666666', '{"name":"Timer test"}')#>>'{data,group,id}')::uuid as id;

create function pg_temp.expect_availability(expected boolean) returns void language plpgsql as $$
declare before_state jsonb; after_state jsonb; result jsonb;
begin
 select to_jsonb(p) into before_state from public.profiles p where id = '66666666-6666-4666-8666-666666666666';
 select public.group_mvp_execute('members', '66666666-6666-4666-8666-666666666666', jsonb_build_object('room_id',id))
   into result from availability_test_room;
 assert (result->>'status')::integer = 200;
 assert (result#>>'{data,members,0,is_free}')::boolean = expected, 'wrong effective availability';
 assert (result#>>'{data,evaluated_at}')::timestamptz = now(), 'inconsistent evaluation time';
 select to_jsonb(p) into after_state from public.profiles p where id = '66666666-6666-4666-8666-666666666666';
 assert before_state = after_state, 'member read mutated timer state';
end $$;

-- Unlimited ON; exact expiry; microsecond boundaries; stale flag before cleanup.
update public.profiles set is_free=true, free_until=null;
select pg_temp.expect_availability(true);
update public.profiles set free_until=now();
select pg_temp.expect_availability(false);
update public.profiles set free_until=now() + interval '1 microsecond';
select pg_temp.expect_availability(true);
update public.profiles set free_until=now() - interval '1 microsecond';
select pg_temp.expect_availability(false);
update public.profiles set free_until=now() - interval '1 hour';
select pg_temp.expect_availability(false);

-- Confirmed auto-expiry output, then re-ON with a fresh one-hour deadline.
update public.profiles set is_free=false, free_until=null;
select pg_temp.expect_availability(false);
update public.profiles set is_free=true, free_until=now() + interval '1 hour';
select pg_temp.expect_availability(true);
-- Confirmed extension output adds 30 minutes to the scheduled deadline.
update public.profiles set free_until=free_until + interval '30 minutes';
select pg_temp.expect_availability(true);
do $$ begin
 assert (select free_until = now() + interval '90 minutes' from public.profiles where id='66666666-6666-4666-8666-666666666666');
end $$;
update public.profiles set is_free=false;
select pg_temp.expect_availability(false);
update public.profiles set is_free=null;
select pg_temp.expect_availability(false);

-- Separate SQL statements distinguish now() (transaction start) from statement
-- time. Even after wall-clock expiry, a single transaction uses its fixed epoch.
update public.profiles set is_free=true, free_until=now() + interval '5 milliseconds';
select pg_sleep(0.03);
do $$ begin
 assert statement_timestamp() > now() + interval '5 milliseconds';
end $$;
select pg_temp.expect_availability(true);
rollback;
