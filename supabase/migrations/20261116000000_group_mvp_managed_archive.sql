-- Generic schema migration. No environment-specific room IDs are embedded.
-- Caller MUST set imahima.room_classification to a reviewed JSON array in this
-- same SQL session: [{room_id: UUID, mvp_managed: boolean, evidence: string}].
-- Missing/duplicate/unknown IDs or incomplete classification abort everything.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Serialize classification against room/membership writes; do not infer legacy
-- status from creator NULL, code length, message presence or an empty room.
lock table public.rooms, public.room_members in access exclusive mode;
do $$
declare entries jsonb; t record;
begin
  entries := nullif(current_setting('imahima.room_classification', true), '')::jsonb;
  if entries is null or jsonb_typeof(entries)<>'array' then
    raise exception 'Reviewed room classification array is required';
  end if;
  if exists(select 1 from jsonb_array_elements(entries) e where
    jsonb_typeof(e)<>'object'
    or jsonb_typeof(e->'room_id') is distinct from 'string'
    or coalesce(e->>'room_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(e->'mvp_managed') is distinct from 'boolean'
    or jsonb_typeof(e->'evidence') is distinct from 'string'
    or coalesce(btrim(e->>'evidence'),'')=''
    or (e-array['room_id','mvp_managed','evidence'])<>'{}'::jsonb) then
    raise exception 'Invalid room classification entry';
  end if;
  if jsonb_array_length(entries)<>(select count(*) from public.rooms)
    or (select count(distinct e->>'room_id') from jsonb_array_elements(entries) e)<>jsonb_array_length(entries)
    or exists(select 1 from jsonb_array_elements(entries) e left join public.rooms r on r.id=(e->>'room_id')::uuid where r.id is null)
    or exists(select 1 from public.rooms r where not exists(select 1 from jsonb_array_elements(entries) e where (e->>'room_id')::uuid=r.id)) then
    raise exception 'Room classification does not exactly match existing room IDs';
  end if;
  -- Trigger definer must have audited, unfiltered membership visibility and room UPDATE.
  if not has_table_privilege(current_user,'public.rooms','SELECT')
    or not has_table_privilege(current_user,'public.rooms','UPDATE')
    or not has_table_privilege(current_user,'public.room_members','SELECT') then
    raise exception 'Migration owner lacks required lifecycle privileges';
  end if;
  for t in select relowner,relforcerowsecurity from pg_class
    where oid in ('public.rooms'::regclass,'public.room_members'::regclass) loop
    if not exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls))
      and not (pg_has_role(current_user,t.relowner,'USAGE') and not t.relforcerowsecurity) then
      raise exception 'Migration owner requires audited unfiltered membership access';
    end if;
  end loop;
end $$;

alter table public.rooms add column mvp_managed boolean;
update public.rooms r set mvp_managed=(e->>'mvp_managed')::boolean
from jsonb_array_elements(current_setting('imahima.room_classification')::jsonb) e
where r.id=(e->>'room_id')::uuid;
alter table public.rooms alter column mvp_managed set not null;
-- No implicit default: non-MVP inserts must explicitly declare their status.

create schema group_mvp_private;
revoke all on schema group_mvp_private from public,anon,authenticated,service_role;
create function group_mvp_private.archive_empty_membership_rooms() returns trigger
language plpgsql volatile security definer set search_path='' set row_security=off set lock_timeout='5s' as $$
declare candidate uuid; managed boolean; archived timestamptz;
begin
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Membership lifecycle requires READ COMMITTED';
  end if;
  -- removed_members is the trigger-bound transition relation, not a schema table.
  -- Batch OLD room IDs in deterministic order (also covers UPDATE room_id).
  for candidate in select distinct room_id from removed_members order by room_id loop
    select r.mvp_managed,r.mvp_archived_at into managed,archived
      from public.rooms r where r.id=candidate for update;
    if found and managed and archived is null then
      -- Separate command AFTER the room lock: use fresh READ COMMITTED visibility.
      if not exists(select 1 from public.room_members where room_id=candidate) then
        update public.rooms set mvp_archived_at=clock_timestamp()
          where id=candidate and mvp_managed and mvp_archived_at is null;
      end if;
    end if;
  end loop;
  return null;
end $$;
revoke all on function group_mvp_private.archive_empty_membership_rooms() from public,anon,authenticated,service_role;
create trigger group_mvp_archive_after_membership_delete
  after delete on public.room_members referencing old table as removed_members
  for each statement execute function group_mvp_private.archive_empty_membership_rooms();
-- Transition relations cannot be combined with an UPDATE OF column list.
create trigger group_mvp_archive_after_membership_update
  after update on public.room_members referencing old table as removed_members
  for each statement execute function group_mvp_private.archive_empty_membership_rooms();

create or replace function public.group_mvp_execute(p_operation text, p_actor uuid, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_room public.rooms%rowtype;
  v_id uuid;
  v_data jsonb;
  v_name text;
  v_code text;
  v_constraint text;
  v_inserted integer;
  v_limit integer := coalesce((p_args->>'limit')::integer, 50);
  v_offset integer := coalesce((p_args->>'offset')::integer, 0);
begin
  if p_actor is null or not exists (select 1 from public.profiles where id = p_actor) then
    return jsonb_build_object('status', 409, 'data', jsonb_build_object('error', 'Profile required'));
  end if;
  if v_limit not between 1 and 100 or v_offset not between 0 and 100000 then
    return jsonb_build_object('status', 400, 'data', jsonb_build_object('error', 'Invalid pagination'));
  end if;
  if p_operation = 'create' then
    v_name := btrim(p_args->>'name');
    if v_name is null or char_length(v_name) not between 1 and 100 then
      return jsonb_build_object('status', 400, 'data', jsonb_build_object('error', 'Invalid name'));
    end if;
    for attempt in 1..3 loop
      begin
        insert into public.rooms(room_name, room_key, mvp_created_by, mvp_managed)
        values (v_name, public.generate_room_key(), p_actor, true) returning * into v_room;
        exit;
      exception when unique_violation then
        get stacked diagnostics v_constraint = CONSTRAINT_NAME;
        if v_constraint <> 'rooms_room_key_unique' or attempt = 3 then raise; end if;
      end;
    end loop;
    insert into public.room_members(room_id, user_id, role) values (v_room.id, p_actor, 'member');
    return jsonb_build_object('status', 201, 'data', jsonb_build_object(
      'group', jsonb_build_object('id', v_room.id, 'name', v_room.room_name), 'invite_code', v_room.room_key));
  elsif p_operation = 'join' then
    v_code := p_args->>'invite_code';
    if v_code is null or v_code !~ '^[A-Za-z0-9]{6,64}$' then
      return jsonb_build_object('status', 400, 'data', jsonb_build_object('error', 'Invalid invitation code'));
    end if;
    select * into v_room from public.rooms where room_key = v_code and mvp_archived_at is null for update;
    if not found then
      return jsonb_build_object('status', 400, 'data', jsonb_build_object('error', 'Invalid invitation code'));
    end if;
    insert into public.room_members(room_id, user_id, role) values (v_room.id, p_actor, 'member')
      on conflict (room_id, user_id) do nothing;
    get diagnostics v_inserted = ROW_COUNT;
    return jsonb_build_object('status', case when v_inserted = 1 then 201 else 200 end,
      'data', jsonb_build_object('group', jsonb_build_object('id', v_room.id, 'name', v_room.room_name)));
  elsif p_operation = 'list' then
    select coalesce(jsonb_agg(x.item order by x.room_id), '[]'::jsonb) into v_data from (
      select r.id as room_id, jsonb_build_object('id', r.id, 'name', r.room_name) as item
      from public.room_members m join public.rooms r on r.id = m.room_id
      where m.user_id = p_actor and r.mvp_archived_at is null
      order by r.id limit v_limit + 1 offset v_offset
    ) x;
    return jsonb_build_object('status', 200, 'data', jsonb_build_object(
      'groups', (select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb) from jsonb_array_elements(v_data) with ordinality where ordinality <= v_limit),
      'next_offset', case when jsonb_array_length(v_data) > v_limit then v_offset + v_limit else null end));
  elsif p_operation in ('members', 'invite', 'leave') then
    v_id := (p_args->>'room_id')::uuid;
    select * into v_room from public.rooms where id = v_id and mvp_archived_at is null for update;
    if not found or not exists (select 1 from public.room_members where room_id = v_id and user_id = p_actor) then
      return jsonb_build_object('status', 404, 'data', jsonb_build_object('error', 'Group not found'));
    end if;
    if p_operation = 'invite' then
      if v_room.mvp_created_by is distinct from p_actor then
        return jsonb_build_object('status', 403, 'data', jsonb_build_object('error', 'Creator access required'));
      end if;
      return jsonb_build_object('status', 200, 'data', jsonb_build_object('invite_code', v_room.room_key));
    elsif p_operation = 'leave' then
      delete from public.room_members where room_id = v_id and user_id = p_actor;
      -- The membership statement trigger handles explicit leave and Auth CASCADE.
      return jsonb_build_object('status', 204, 'data', null);
    else
      -- Match the confirmed timer contract: NULL deadline is unlimited ON,
      -- <= now() is expired. Use transaction time, as auto_expire_free_status does.
      select coalesce(jsonb_agg(x.item order by x.user_id), '[]'::jsonb) into v_data from (
        select m.user_id, jsonb_build_object('id', p.id,
          'username', coalesce(nullif(btrim(p.username), ''), '名前未設定'),
          'is_free', coalesce(p.is_free, false) and (p.free_until is null or p.free_until > now()),
          'free_until', p.free_until) as item
        from public.room_members m join public.profiles p on p.id = m.user_id
        where m.room_id = v_id order by m.user_id limit v_limit + 1 offset v_offset
      ) x;
      return jsonb_build_object('status', 200, 'data', jsonb_build_object(
        'members', (select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb) from jsonb_array_elements(v_data) with ordinality where ordinality <= v_limit),
        'next_offset', case when jsonb_array_length(v_data) > v_limit then v_offset + v_limit else null end,
        'evaluated_at', now()));
    end if;
  end if;
  return jsonb_build_object('status', 400, 'data', jsonb_build_object('error', 'Unknown operation'));
end;
$$;

revoke all on function public.group_mvp_execute(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.group_mvp_execute(text,uuid,jsonb) to service_role;
-- Preserve existing archives/data/ACL/RLS/publications. Existing empty/reopened
-- rooms require an explicit remediation decision; no automatic historical repair.
commit;
