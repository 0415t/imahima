-- 暇ONイベントと受信者別outbox。外部通信はトランザクション確定後にExpressで行う。
-- ON期間のIDは延長では維持し、OFF/期限切れからの再ONで更新する。
alter table public.profiles add column free_period_id uuid;
update public.profiles set free_period_id = gen_random_uuid()
where is_free is true and (free_until is null or free_until > now());

create index room_members_user_room_idx on public.room_members (user_id, room_id);

create table public.member_free_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  actor_period_id uuid not null,
  actor_name text,
  occurred_at timestamptz not null default now()
);
create table public.member_free_notifications (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.member_free_events(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_period_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'failed', 'cancelled', 'exhausted')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  accepted_count integer not null default 0 check (accepted_count >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, recipient_user_id)
);
create index member_free_notifications_due_idx
  on public.member_free_notifications (next_attempt_at, created_at)
  where status in ('pending', 'failed', 'processing');
create index member_free_events_actor_idx on public.member_free_events (actor_user_id);

alter table public.member_free_events enable row level security;
alter table public.member_free_notifications enable row level security;
revoke all on public.member_free_events, public.member_free_notifications from public, anon, authenticated;
grant select on public.member_free_events, public.member_free_notifications to service_role;

-- 独立した受信者抽出。room ID指定は発信者の所属との積集合に限る。
-- 現MVPのトリガーはNULL（全所属room）で呼ぶ。後から候補を追加しない。
create function public.member_free_recipients(p_actor uuid, p_room_ids uuid[] default null)
returns table (user_id uuid, period_id uuid)
language sql stable security definer set search_path = '' as $$
  select p.id, p.free_period_id from public.profiles p
  where p.id <> p_actor and p.is_free is true
    and (p.free_until is null or p.free_until > now()) and p.free_period_id is not null
    and exists (
      select 1 from public.room_members a
      join public.room_members b on b.room_id = a.room_id
      where a.user_id = p_actor and b.user_id = p.id
        and (p_room_ids is null or a.room_id = any(p_room_ids))
    );
$$;

create function public.track_profile_free_period()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  reference_time timestamptz := now();
  old_active boolean := false;
  new_active boolean;
begin
  if tg_op = 'UPDATE' then
    old_active := old.is_free is true and (old.free_until is null or old.free_until > reference_time);
  end if;
  new_active := new.is_free is true and (new.free_until is null or new.free_until > reference_time);
  if not new_active then
    new.free_period_id := null;
  elsif old_active then
    new.free_period_id := old.free_period_id;
  else
    new.free_period_id := gen_random_uuid();
  end if;
  return new;
end;
$$;
create trigger track_profile_free_period before insert or update on public.profiles
for each row execute function public.track_profile_free_period();

create function public.enqueue_member_free_notifications()
returns trigger language plpgsql security definer set search_path = '' as $$
declare event_uuid uuid;
begin
  -- BEFOREトリガーが同一基準時刻で期間IDを決めている。延長・再ONはID不変。
  if new.free_period_id is not null and new.free_period_id is distinct from old.free_period_id then
    insert into public.member_free_events (actor_user_id, actor_period_id, actor_name)
      values (new.id, new.free_period_id, nullif(btrim(new.username), '')) returning id into event_uuid;
    insert into public.member_free_notifications (event_id, recipient_user_id, recipient_period_id)
      select event_uuid, r.user_id, r.period_id from public.member_free_recipients(new.id) r;
  end if;
  return new;
end;
$$;
create trigger enqueue_member_free_notifications after update on public.profiles
for each row execute function public.enqueue_member_free_notifications();

-- 両者のON期間・期限・共通roomを送信前に再確認。期間変更/延長を混同しない。
create function public.member_free_notification_is_valid(p_notification uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.member_free_notifications n
    join public.member_free_events e on e.id = n.event_id
    join public.profiles a on a.id = e.actor_user_id
    join public.profiles b on b.id = n.recipient_user_id
    where n.id = p_notification
      and a.free_period_id = e.actor_period_id and b.free_period_id = n.recipient_period_id
      and a.is_free is true and (a.free_until is null or a.free_until > now())
      and b.is_free is true and (b.free_until is null or b.free_until > now())
      and exists (select 1 from public.room_members am
        join public.room_members bm on bm.room_id = am.room_id
        where am.user_id = a.id and bm.user_id = b.id)
  );
$$;

create function public.claim_member_free_notifications(
  p_limit integer default 50, p_lease_seconds integer default 120, p_max_attempts integer default 3
)
returns table (notification_id uuid, event_id uuid, recipient_user_id uuid, actor_name text,
               attempts integer, lease_token uuid, lease_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 1000
     or p_lease_seconds is null or p_lease_seconds not between 10 and 3600
     or p_max_attempts is null or p_max_attempts not between 1 and 10 then
    raise exception 'Invalid member-free claim options';
  end if;
  -- 所有中のワーカーを横取りしない。停止した処理はlease期限後に取消/再確保する。
  update public.member_free_notifications n set status = 'cancelled', lease_expires_at = null,
    last_error = 'Eligibility changed', updated_at = now()
  where n.status in ('pending', 'failed', 'processing')
    and (n.status <> 'processing' or n.lease_expires_at <= now())
    and not public.member_free_notification_is_valid(n.id);
  update public.member_free_notifications n set status = 'exhausted', lease_expires_at = null, updated_at = now()
  where n.status in ('failed', 'processing') and n.attempts >= n.max_attempts
    and (n.status <> 'processing' or n.lease_expires_at <= now());
  return query
  with candidates as (
    select n.id from public.member_free_notifications n
    where n.next_attempt_at <= now() and n.attempts < n.max_attempts
      and (n.status in ('pending', 'failed') or (n.status = 'processing' and n.lease_expires_at <= now()))
    order by n.created_at, n.id limit p_limit for update of n skip locked
  ), claimed as (
    update public.member_free_notifications n set status = 'processing', attempts = n.attempts + 1,
      max_attempts = case when n.attempts = 0 then p_max_attempts else n.max_attempts end,
      lease_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
    from candidates c where n.id = c.id returning n.*
  ) select c.id, c.event_id, c.recipient_user_id, e.actor_name, c.attempts, c.lease_token, c.lease_expires_at
    from claimed c join public.member_free_events e on e.id = c.event_id;
end;
$$;

create function public.validate_member_free_notification(p_notification uuid, p_lease_token uuid)
returns table (owned boolean, still_valid boolean)
language sql stable security definer set search_path = '' as $$
  select coalesce(n.status = 'processing' and n.lease_token = p_lease_token and n.lease_expires_at > now(), false),
    public.member_free_notification_is_valid(n.id)
  from public.member_free_notifications n where n.id = p_notification;
$$;

create function public.complete_member_free_notification(
  p_notification uuid, p_lease_token uuid, p_status text, p_error text default null, p_accepted_count integer default 0
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  if p_notification is null or p_lease_token is null or p_status is null
     or p_status not in ('sent', 'failed', 'cancelled') or p_accepted_count is null or p_accepted_count < 0
     or (p_status = 'sent' and p_accepted_count = 0) or (p_status <> 'sent' and p_accepted_count <> 0) then
    raise exception 'Invalid member-free completion';
  end if;
  update public.member_free_notifications n set
    status = case when p_status = 'failed' and n.attempts >= n.max_attempts then 'exhausted' else p_status end,
    accepted_count = p_accepted_count, last_error = left(p_error, 1000),
    sent_at = case when p_status = 'sent' then now() else null end,
    next_attempt_at = case when p_status = 'failed'
      then now() + make_interval(secs => least(300, 5 * power(2, n.attempts - 1))::integer)
      else n.next_attempt_at end,
    lease_expires_at = null, updated_at = now()
  where n.id = p_notification and n.lease_token = p_lease_token and n.status = 'processing';
  -- lease期限切れでも再確保されていなければ完了可（受付後の不要な再送を抑える）。
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function public.member_free_recipients(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.track_profile_free_period() from public, anon, authenticated;
revoke all on function public.enqueue_member_free_notifications() from public, anon, authenticated;
revoke all on function public.member_free_notification_is_valid(uuid) from public, anon, authenticated;
revoke all on function public.claim_member_free_notifications(integer, integer, integer) from public, anon, authenticated;
revoke all on function public.validate_member_free_notification(uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_member_free_notification(uuid, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.member_free_recipients(uuid, uuid[]), public.member_free_notification_is_valid(uuid),
  public.claim_member_free_notifications(integer, integer, integer), public.validate_member_free_notification(uuid, uuid),
  public.complete_member_free_notification(uuid, uuid, text, text, integer) to service_role;
-- free_period_idはクライアント編集列に含めない。先行マイグレーションの列ACL制限を維持。
revoke update (free_period_id), insert (free_period_id) on public.profiles from public, anon, authenticated;
