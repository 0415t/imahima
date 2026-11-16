-- REVIEW ONLY: do not apply to production until existing RLS, grants and timer
-- semantics have been reviewed. No existing room, profile or user row is updated.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.rooms
  add column mvp_created_by uuid references auth.users(id) on delete set null,
  add column mvp_archived_at timestamptz;
create index if not exists idx_room_members_user_id_room_id
  on public.room_members(user_id, room_id);

-- UUIDv4 uses cryptographically secure randomness. 32 hexadecimal characters
-- preserve 122 random bits (including fixed version/variant positions).
create or replace function public.generate_room_key()
returns text language sql volatile set search_path = '' as $$
  select replace(pg_catalog.gen_random_uuid()::text, '-', '');
$$;

-- Persisted across API instances; no raw IP, invitation code or token is stored.
create table public.group_mvp_rate_limits (
  key_hash text primary key,
  window_start timestamptz not null,
  attempts integer not null check (attempts > 0)
);
alter table public.group_mvp_rate_limits enable row level security;
revoke all on public.group_mvp_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.group_mvp_rate_limits to service_role;

create function public.group_mvp_consume_rate(p_key text, p_maximum integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_count integer; v_now timestamptz := clock_timestamp();
begin
  if p_key !~ '^[0-9a-f]{64}$' or p_maximum not between 1 and 100 then
    raise exception 'invalid rate parameters';
  end if;
  delete from public.group_mvp_rate_limits where window_start < v_now - interval '1 day';
  insert into public.group_mvp_rate_limits as r(key_hash, window_start, attempts)
  values (p_key, v_now, 1)
  on conflict (key_hash) do update set
    attempts = case when r.window_start <= v_now - interval '60 seconds' then 1 else least(r.attempts + 1, p_maximum + 1) end,
    window_start = case when r.window_start <= v_now - interval '60 seconds' then v_now else r.window_start end
  returning attempts into v_count;
  return v_count <= p_maximum;
end;
$$;

-- Existing client policies are unknown. Fail closed for direct table access;
-- all MVP access is authenticated by Express and rechecked by the service RPC.
-- Inspect impact on any external legacy client before applying these grants.
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
revoke all on public.rooms, public.room_members from public, anon, authenticated;
grant select, insert, update, delete on public.rooms, public.room_members to service_role;

create function public.group_mvp_execute(p_operation text, p_actor uuid, p_args jsonb default '{}'::jsonb)
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
        insert into public.rooms(room_name, room_key, mvp_created_by)
        values (v_name, public.generate_room_key(), p_actor) returning * into v_room;
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
      -- Keep all rows/history. Only newly-created MVP rooms are archived.
      if v_room.mvp_created_by is not null and not exists (select 1 from public.room_members where room_id = v_id) then
        update public.rooms set mvp_archived_at = clock_timestamp() where id = v_id;
      end if;
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

revoke all on function public.group_mvp_execute(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.group_mvp_consume_rate(text, integer) from public, anon, authenticated;
grant execute on function public.group_mvp_execute(text, uuid, jsonb) to service_role;
grant execute on function public.group_mvp_consume_rate(text, integer) to service_role;
commit;
