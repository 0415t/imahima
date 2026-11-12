-- Run against an isolated database after fixture + migration. All test writes roll back.
begin;
insert into auth.users(id) values
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222'),
 ('33333333-3333-4333-8333-333333333333');
insert into public.profiles(id, username, is_free, free_until) values
 ('11111111-1111-4111-8111-111111111111', 'Creator', true, now() + interval '1 hour'),
 ('22222222-2222-4222-8222-222222222222', 'Expired', true, now() - interval '1 hour'),
 ('33333333-3333-4333-8333-333333333333', 'Other', false, null);
do $$
declare
 a uuid := '11111111-1111-4111-8111-111111111111';
 b uuid := '22222222-2222-4222-8222-222222222222';
 c uuid := '33333333-3333-4333-8333-333333333333';
 r jsonb; v_room_id uuid; code text; profiles_before jsonb;
begin
 select jsonb_agg(to_jsonb(p) order by p.id) into profiles_before from public.profiles p;
 r := public.group_mvp_execute('create', a, '{"name":"Friends"}');
 assert (r->>'status')::integer = 201, 'create failed';
 v_room_id := (r#>>'{data,group,id}')::uuid; code := r#>>'{data,invite_code}';
 assert code ~ '^[0-9a-f]{32}$', 'insecure new key format';
 assert exists(select 1 from public.room_members where room_id=v_room_id and user_id=a), 'creator not joined';
 assert (public.group_mvp_execute('invite', a, jsonb_build_object('room_id',v_room_id))#>>'{data,invite_code}') = code;
 assert (public.group_mvp_execute('members', c, jsonb_build_object('room_id',v_room_id))->>'status')::integer = 404;
 assert (public.group_mvp_execute('list', c)->'data'->'groups') = '[]'::jsonb;
 assert (public.group_mvp_execute('join', b, jsonb_build_object('invite_code',code))->>'status')::integer = 201;
 assert (public.group_mvp_execute('join', b, jsonb_build_object('invite_code',code))->>'status')::integer = 200;
 assert (public.group_mvp_execute('invite', b, jsonb_build_object('room_id',v_room_id))->>'status')::integer = 403;
 r := public.group_mvp_execute('members', a, jsonb_build_object('room_id',v_room_id,'limit',1));
 assert (r#>>'{data,members,0,is_free}')::boolean = true;
 assert (r#>>'{data,next_offset}')::integer = 1;
 r := public.group_mvp_execute('members', a, jsonb_build_object('room_id',v_room_id,'offset',1));
 assert (r#>>'{data,members,0,is_free}')::boolean = false, 'expired state leaked';
 perform public.group_mvp_execute('leave', a, jsonb_build_object('room_id',v_room_id));
 assert (public.group_mvp_execute('invite', a, jsonb_build_object('room_id',v_room_id))->>'status')::integer = 404;
 perform public.group_mvp_execute('leave', b, jsonb_build_object('room_id',v_room_id));
 assert exists(select 1 from public.rooms where rooms.id=v_room_id and mvp_archived_at is not null), 'history deleted or room not archived';
 assert (public.group_mvp_execute('join', a, jsonb_build_object('invite_code',code))->>'status')::integer = 400;
 assert (select count(*)=2 from public.rooms where room_key in ('Legacy1','Legacy2') and mvp_archived_at is null and mvp_created_by is null), 'legacy rooms changed';
 assert (select jsonb_agg(to_jsonb(p) order by p.id) = profiles_before from public.profiles p), 'availability modified';
 assert public.group_mvp_consume_rate(repeat('a',64),1);
 assert not public.group_mvp_consume_rate(repeat('a',64),1);
 assert not has_function_privilege('authenticated','public.group_mvp_execute(text,uuid,jsonb)','execute');
 assert not has_function_privilege('anon','public.group_mvp_consume_rate(text,integer)','execute');
 assert not has_table_privilege('authenticated','public.rooms','select');
 assert not has_table_privilege('authenticated','public.room_members','insert');
 assert has_function_privilege('service_role','public.group_mvp_execute(text,uuid,jsonb)','execute');
end $$;
-- Inject a deterministic first collision; retry must recover without changing legacy keys.
create sequence pg_temp.group_key_attempt;
create or replace function public.generate_room_key() returns text language sql as $$
  select case when nextval('pg_temp.group_key_attempt') = 1 then 'Legacy1'
    else replace(gen_random_uuid()::text, '-', '') end;
$$;
do $$
declare r jsonb;
begin
 r := public.group_mvp_execute('create', '11111111-1111-4111-8111-111111111111', '{"name":"Retry"}');
 assert (r->>'status')::integer = 201;
 assert currval('pg_temp.group_key_attempt') = 2, 'key collision not retried';
end $$;
-- A membership failure must roll back the room insert as well.
create function pg_temp.reject_membership() returns trigger language plpgsql as $$
begin raise exception 'injected membership failure'; end $$;
create trigger test_reject_membership before insert on public.room_members
for each row execute function pg_temp.reject_membership();
do $$
declare count_before integer;
begin
 select count(*) into count_before from public.rooms;
 begin
  perform public.group_mvp_execute('create', '11111111-1111-4111-8111-111111111111', '{"name":"Atomic"}');
  raise exception 'expected failure';
 exception when raise_exception then
  if sqlerrm <> 'injected membership failure' then raise; end if;
 end;
 assert (select count(*) = count_before from public.rooms), 'orphan room after failed membership';
end $$;
drop trigger test_reject_membership on public.room_members;
-- Exercise actual service-role permissions, not only superuser behavior.
set local role service_role;
select public.group_mvp_execute('list', '11111111-1111-4111-8111-111111111111');
reset role;
rollback;
