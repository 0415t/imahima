-- Group chat DB layer only. Apply ONLY after separate deployment approval.
-- Does not replace existing functions, policies, grants, timers or Push code.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare t record;
begin
  if current_setting('server_encoding') <> 'UTF8' then raise exception 'Chat requires UTF8'; end if;
  if to_regprocedure('auth.uid()') is null then raise exception 'Supabase auth.uid() required'; end if;
  if not exists(select 1 from pg_publication where pubname='supabase_realtime' and pubinsert) then
    raise exception 'Reviewed supabase_realtime INSERT publication required';
  end if;
  if exists(select 1 from pg_publication where puballtables)
    or exists(select 1 from pg_publication_namespace where pnnspid='public'::regnamespace) then
    raise exception 'Broad publication could expose message bodies; review before applying';
  end if;
  -- The definer below must read memberships without silently being filtered.
  if not has_table_privilege(current_user,'public.rooms','SELECT')
    or not has_table_privilege(current_user,'public.room_members','SELECT') then
    raise exception 'Migration owner requires membership SELECT privileges';
  end if;
  for t in select c.relowner,c.relforcerowsecurity from pg_class c
    where c.oid in ('public.rooms'::regclass,'public.room_members'::regclass) loop
    if not exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls))
      and not (pg_has_role(current_user,t.relowner,'USAGE') and not t.relforcerowsecurity) then
      raise exception 'Migration owner must have audited unfiltered membership access';
    end if;
  end loop;
end $$;

-- A new, unexposed namespace; a collision intentionally aborts rather than reuse it.
create schema chat_private;
revoke all on schema chat_private from public,anon,authenticated,service_role;
grant usage on schema chat_private to authenticated,service_role;

-- Unicode White_Space, not locale-dependent POSIX space. No trimming of content.
create function chat_private.valid_body(p_body text) returns boolean
language sql immutable strict security invoker set search_path='' as $$
  select char_length(p_body) between 1 and 500
    and position(E'\r\n' in p_body)=0
    and translate(p_body,U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000','') <> '';
$$;

create table public.messages (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  sender_id uuid references public.profiles(id) on delete set null,
  room_seq bigint not null check(room_seq>0),
  body text,
  client_message_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  last_event_seq bigint not null check(last_event_seq>0),
  unique(room_id,room_seq),
  unique(sender_id,client_message_id),
  unique(room_id,id),
  constraint messages_body_state check (
    (deleted_at is null and body is not null and chat_private.valid_body(body))
    or (deleted_at is not null and body is null)
  )
);
create index messages_sender_created_at_idx on public.messages(sender_id,created_at desc);

create table public.room_message_events (
  room_id uuid not null references public.rooms(id) on delete restrict,
  event_seq bigint not null check(event_seq>0),
  message_id uuid not null,
  event_type text not null check(event_type in ('created','deleted')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(room_id,event_seq),
  unique(room_id,message_id,event_type),
  foreign key(room_id,message_id) references public.messages(room_id,id) on delete restrict
);
alter table public.messages enable row level security;
alter table public.room_message_events enable row level security;
revoke all on public.messages,public.room_message_events from public,anon,authenticated,service_role;
grant select,insert on public.messages to service_role;
grant update(body,deleted_at,last_event_seq) on public.messages to service_role;
grant select,insert on public.room_message_events to service_role;
grant select on public.room_message_events to authenticated;

create function chat_private.can_read_room(p_room uuid) returns boolean
language sql stable security definer set search_path='' set row_security=off as $$
  select auth.uid() is not null and exists (
    select 1 from public.rooms r join public.room_members m on m.room_id=r.id
    where r.id=p_room and r.mvp_archived_at is null and m.user_id=auth.uid()
  );
$$;
-- Owner is the audited migration execution role; no general role gets ownership.
create policy chat_events_member_select on public.room_message_events
  for select to authenticated using (chat_private.can_read_room(room_id));

create function chat_private.guard_message() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if TG_OP='DELETE' then raise exception 'Physical message deletion is not supported'; end if;
  if (new.id,new.room_id,new.room_seq,new.client_message_id,new.created_at)
       is distinct from (old.id,old.room_id,old.room_seq,old.client_message_id,old.created_at)
    or (new.sender_id is distinct from old.sender_id and new.sender_id is not null) then
    raise exception 'Immutable message metadata';
  end if;
  if old.deleted_at is not null then
    if new.body is not null or new.deleted_at is distinct from old.deleted_at
      or new.last_event_seq is distinct from old.last_event_seq then
      raise exception 'Deleted message cannot be restored or changed';
    end if;
  elsif new.deleted_at is null then
    if new.body is distinct from old.body or new.last_event_seq is distinct from old.last_event_seq then
      raise exception 'Message editing is not supported';
    end if;
  elsif new.body is not null or new.last_event_seq<=old.last_event_seq then
    raise exception 'Invalid tombstone transition';
  end if;
  return new;
end $$;
create trigger chat_message_immutable before update or delete on public.messages
  for each row execute function chat_private.guard_message();
create function chat_private.guard_event() returns trigger
language plpgsql security invoker set search_path='' as $$
begin raise exception 'Message events are append-only'; end $$;
create trigger chat_event_append_only before update or delete on public.room_message_events
  for each row execute function chat_private.guard_event();

create function chat_private.error(p_status integer,p_code text,p_error text) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('status',p_status,'data',jsonb_build_object('code',p_code,'error',p_error));
$$;
create function chat_private.actor_error(p_actor uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
  -- Service RPCs cannot validate an end-user JWT themselves: Express must verify
  -- it and derive p_actor. No end-user role may execute these RPCs directly.
  if current_user<>'service_role' or p_actor is null then
    return chat_private.error(401,'UNAUTHENTICATED','Verified server identity required');
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Chat RPCs require READ COMMITTED isolation';
  end if;
  if not exists(select 1 from public.profiles where id=p_actor) then
    return chat_private.error(409,'PROFILE_REQUIRED','Profile required');
  end if;
  return null;
end $$;
create function chat_private.sequence_value(p_value text) returns bigint
language plpgsql immutable strict security invoker set search_path='' as $$
begin
  if p_value !~ '^(0|[1-9][0-9]*)$' or length(p_value)>19 then return null; end if;
  if p_value::numeric>9223372036854775807::numeric then return null; end if;
  return p_value::bigint;
end $$;
create function chat_private.message_json(p_message public.messages) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'id',p_message.id,'room_id',p_message.room_id,'room_seq',p_message.room_seq::text,
    'last_event_seq',p_message.last_event_seq::text,
    'sender',case when p.id is null then null else jsonb_build_object('id',p.id,
      'username',coalesce(nullif(btrim(p.username),''),'名前未設定')) end,
    'body',case when p_message.deleted_at is null then p_message.body else null end,
    'created_at',p_message.created_at,'deleted_at',p_message.deleted_at)
  from (select 1) x left join public.profiles p on p.id=p_message.sender_id;
$$;

create function public.chat_send_message(p_actor uuid,p_room_id uuid,p_body text,p_client_message_id uuid)
returns jsonb language plpgsql volatile security invoker set search_path='' set lock_timeout='5s' as $$
declare e jsonb; m public.messages%rowtype; t timestamptz; oldest timestamptz;
  n integer; seq bigint; event_no bigint; retry integer; normalized text;
begin
  e:=chat_private.actor_error(p_actor); if e is not null then return e; end if;
  normalized:=replace(p_body,E'\r\n',E'\n');
  if p_room_id is null or p_client_message_id is null or normalized is null
    or not chat_private.valid_body(normalized) then
    return chat_private.error(400,'INVALID_INPUT','Body must contain 1 to 500 code points and non-whitespace content');
  end if;
  -- Global per-user serialization FIRST, then exactly one room lock.
  perform pg_advisory_xact_lock(1128813617,hashtext(p_actor::text));
  perform 1 from public.rooms where id=p_room_id and mvp_archived_at is null for update;
  if not found or not exists(select 1 from public.room_members where room_id=p_room_id and user_id=p_actor) then
    return chat_private.error(404,'GROUP_NOT_FOUND','Group not found');
  end if;
  select * into m from public.messages where sender_id=p_actor and client_message_id=p_client_message_id;
  if found then
    if m.room_id<>p_room_id or (m.deleted_at is null and m.body is distinct from normalized) then
      return chat_private.error(409,'CLIENT_MESSAGE_ID_CONFLICT','Client message ID conflict');
    end if;
    return jsonb_build_object('status',200,'data',jsonb_build_object('message',chat_private.message_json(m),'deduplicated',true));
  end if;
  t:=clock_timestamp();
  -- No deleted_at predicate: tombstones still consume their original send slot.
  select count(*),min(created_at) into n,oldest from public.messages
    where sender_id=p_actor and created_at>t-interval '60 seconds';
  if n>=10 then
    retry:=greatest(1,ceil(extract(epoch from oldest+interval '60 seconds'-t))::integer);
    return jsonb_build_object('status',429,'data',jsonb_build_object('error','Message rate limit exceeded',
      'code','MESSAGE_RATE_LIMITED','retry_after_seconds',retry));
  end if;
  select coalesce(max(room_seq),0)+1 into seq from public.messages where room_id=p_room_id;
  select coalesce(max(event_seq),0)+1 into event_no from public.room_message_events where room_id=p_room_id;
  insert into public.messages(room_id,sender_id,room_seq,body,client_message_id,created_at,last_event_seq)
    values(p_room_id,p_actor,seq,normalized,p_client_message_id,t,event_no) returning * into m;
  insert into public.room_message_events(room_id,event_seq,message_id,event_type,created_at)
    values(p_room_id,event_no,m.id,'created',t);
  return jsonb_build_object('status',201,'data',jsonb_build_object('message',chat_private.message_json(m),'deduplicated',false));
end $$;

create function public.chat_delete_message(p_actor uuid,p_room_id uuid,p_message_id uuid)
returns jsonb language plpgsql volatile security invoker set search_path='' set lock_timeout='5s' as $$
declare e jsonb; m public.messages%rowtype; event_no bigint; t timestamptz;
begin
  e:=chat_private.actor_error(p_actor); if e is not null then return e; end if;
  if p_room_id is null or p_message_id is null then return chat_private.error(400,'INVALID_INPUT','IDs required'); end if;
  perform 1 from public.rooms where id=p_room_id and mvp_archived_at is null for update;
  if not found or not exists(select 1 from public.room_members where room_id=p_room_id and user_id=p_actor) then
    return chat_private.error(404,'GROUP_NOT_FOUND','Group not found');
  end if;
  select * into m from public.messages where id=p_message_id and room_id=p_room_id;
  if not found then return chat_private.error(404,'MESSAGE_NOT_FOUND','Message not found'); end if;
  if m.sender_id is distinct from p_actor then return chat_private.error(403,'MESSAGE_NOT_OWNED','Only the sender can delete this message'); end if;
  if m.deleted_at is not null then
    return jsonb_build_object('status',200,'data',jsonb_build_object('message',chat_private.message_json(m),'already_deleted',true));
  end if;
  select coalesce(max(event_seq),0)+1 into event_no from public.room_message_events where room_id=p_room_id;
  t:=clock_timestamp();
  update public.messages set body=null,deleted_at=t,last_event_seq=event_no where id=m.id returning * into m;
  insert into public.room_message_events(room_id,event_seq,message_id,event_type,created_at)
    values(p_room_id,event_no,m.id,'deleted',t);
  return jsonb_build_object('status',200,'data',jsonb_build_object('message',chat_private.message_json(m),'already_deleted',false));
end $$;

create function public.chat_list_messages(p_actor uuid,p_room_id uuid,p_limit integer default 50,p_cursor jsonb default null)
returns jsonb language plpgsql volatile security invoker set search_path='' set lock_timeout='5s' as $$
declare e jsonb; rows jsonb; items jsonb; before_no bigint; maximum bigint; highwater bigint;
  more boolean; next_page jsonb;
begin
  e:=chat_private.actor_error(p_actor); if e is not null then return e; end if;
  if p_room_id is null or p_limit is null or p_limit not between 1 and 100 then
    return chat_private.error(400,'INVALID_INPUT','Invalid room or limit'); end if;
  perform 1 from public.rooms where id=p_room_id and mvp_archived_at is null for share;
  if not found or not exists(select 1 from public.room_members where room_id=p_room_id and user_id=p_actor) then
    return chat_private.error(404,'GROUP_NOT_FOUND','Group not found'); end if;
  select coalesce(max(room_seq),0) into maximum from public.messages where room_id=p_room_id;
  select coalesce(max(event_seq),0) into highwater from public.room_message_events where room_id=p_room_id;
  if p_cursor is not null then
    if jsonb_typeof(p_cursor)<>'object' then
      return chat_private.error(400,'INVALID_CURSOR','Invalid history cursor'); end if;
    if p_cursor->'v' is distinct from '1'::jsonb
      or p_cursor->>'room_id' is distinct from p_room_id::text
      or p_cursor->>'direction' is distinct from 'before'
      or jsonb_typeof(p_cursor->'before_seq') is distinct from 'string'
      or (p_cursor - array['v','room_id','direction','before_seq'])<>'{}'::jsonb then
      return chat_private.error(400,'INVALID_CURSOR','Invalid history cursor'); end if;
    before_no:=chat_private.sequence_value(p_cursor->>'before_seq');
    if before_no is null or before_no<1 or before_no>maximum then
      return chat_private.error(400,'INVALID_CURSOR','Invalid history position'); end if;
  end if;
  select coalesce(jsonb_agg(x.item order by x.seq desc),'[]'::jsonb) into rows from (
    select m.room_seq as seq,chat_private.message_json(m) as item from public.messages m
    where m.room_id=p_room_id and (before_no is null or m.room_seq<before_no)
    order by m.room_seq desc limit p_limit+1
  ) x;
  more:=jsonb_array_length(rows)>p_limit;
  select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into items
    from jsonb_array_elements(rows) with ordinality where ordinality<=p_limit;
  if more then next_page:=jsonb_build_object('v',1,'room_id',p_room_id,'direction','before',
    'before_seq',items->(p_limit-1)->>'room_seq'); end if;
  return jsonb_build_object('status',200,'data',jsonb_build_object('messages',items,'next_cursor',next_page,
    'has_more',more,'sync_event_seq',highwater::text,'evaluated_at',clock_timestamp()));
end $$;

create function public.chat_list_message_events(p_actor uuid,p_room_id uuid,p_after_event_seq text default '0',
  p_limit integer default 50,p_cursor jsonb default null)
returns jsonb language plpgsql volatile security invoker set search_path='' set lock_timeout='5s' as $$
declare e jsonb; after_no bigint; highwater bigint; maximum bigint; rows jsonb; items jsonb;
  states jsonb; more boolean; next_no bigint; next_page jsonb;
begin
  e:=chat_private.actor_error(p_actor); if e is not null then return e; end if;
  if p_room_id is null or p_limit is null or p_limit not between 1 and 100 then
    return chat_private.error(400,'INVALID_INPUT','Invalid room or limit'); end if;
  perform 1 from public.rooms where id=p_room_id and mvp_archived_at is null for share;
  if not found or not exists(select 1 from public.room_members where room_id=p_room_id and user_id=p_actor) then
    return chat_private.error(404,'GROUP_NOT_FOUND','Group not found'); end if;
  select coalesce(max(event_seq),0) into maximum from public.room_message_events where room_id=p_room_id;
  if p_cursor is null then
    after_no:=chat_private.sequence_value(p_after_event_seq); highwater:=maximum;
  else
    if jsonb_typeof(p_cursor)<>'object' then
      return chat_private.error(400,'INVALID_CURSOR','Invalid event cursor'); end if;
    if p_after_event_seq is distinct from '0'
      or p_cursor->'v' is distinct from '1'::jsonb
      or p_cursor->>'room_id' is distinct from p_room_id::text
      or p_cursor->>'direction' is distinct from 'after'
      or jsonb_typeof(p_cursor->'after_seq') is distinct from 'string'
      or jsonb_typeof(p_cursor->'through_seq') is distinct from 'string'
      or (p_cursor - array['v','room_id','direction','after_seq','through_seq'])<>'{}'::jsonb then
      return chat_private.error(400,'INVALID_CURSOR','Invalid event cursor'); end if;
    after_no:=chat_private.sequence_value(p_cursor->>'after_seq');
    highwater:=chat_private.sequence_value(p_cursor->>'through_seq');
  end if;
  if after_no is null or highwater is null or after_no>highwater or highwater>maximum then
    return chat_private.error(400,'INVALID_CURSOR','Invalid event position'); end if;
  select coalesce(jsonb_agg(x.item order by x.seq),'[]'::jsonb) into rows from (
    select event_seq as seq,jsonb_build_object('event_seq',event_seq::text,'type',event_type,
      'message_id',message_id,'created_at',created_at) as item
    from public.room_message_events where room_id=p_room_id and event_seq>after_no and event_seq<=highwater
    order by event_seq limit p_limit+1
  ) x;
  more:=jsonb_array_length(rows)>p_limit;
  select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into items
    from jsonb_array_elements(rows) with ordinality where ordinality<=p_limit;
  next_no:=case when more then (items->(p_limit-1)->>'event_seq')::bigint else highwater end;
  if more then next_page:=jsonb_build_object('v',1,'room_id',p_room_id,'direction','after',
    'after_seq',next_no::text,'through_seq',highwater::text); end if;
  select coalesce(jsonb_agg(chat_private.message_json(m) order by m.room_seq),'[]'::jsonb) into states
    from public.messages m where m.room_id=p_room_id and m.id in (
      select (value->>'message_id')::uuid from jsonb_array_elements(items));
  return jsonb_build_object('status',200,'data',jsonb_build_object('events',items,'messages',states,
    'has_more',more,'next_cursor',next_page,'through_event_seq',highwater::text,'next_after_event_seq',next_no::text));
end $$;

-- Remove broad default privileges in the SAME transaction as CREATE.
revoke all on all functions in schema chat_private from public,anon,authenticated,service_role;
grant execute on function chat_private.can_read_room(uuid) to authenticated;
grant execute on function chat_private.valid_body(text),chat_private.error(integer,text,text),
  chat_private.actor_error(uuid),chat_private.sequence_value(text),chat_private.message_json(public.messages) to service_role;
revoke all on function public.chat_send_message(uuid,uuid,text,uuid),public.chat_delete_message(uuid,uuid,uuid),
  public.chat_list_messages(uuid,uuid,integer,jsonb),public.chat_list_message_events(uuid,uuid,text,integer,jsonb)
  from public,anon,authenticated;
grant execute on function public.chat_send_message(uuid,uuid,text,uuid),public.chat_delete_message(uuid,uuid,uuid),
  public.chat_list_messages(uuid,uuid,integer,jsonb),public.chat_list_message_events(uuid,uuid,text,integer,jsonb) to service_role;

alter publication supabase_realtime add table public.room_message_events;
commit;
