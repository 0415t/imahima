-- 暇状態終了5分前通知の管理基盤
-- Expressポーラー（次Stepで実装）からService Role経由で呼び出す。
-- クライアント（anon/authenticated）からは一切操作できない。
--
-- 設計上の制約（明記）:
-- - DB再検証と外部Expo Push API送信の間にはTOCTOU競合が残る。
--   再検証通過後〜送信までの間に手動OFFされた場合、通知が届く可能性を排除できない。
-- - 外部送信のexactly-onceは保証できない（at-least-once）。
--   送信成功後〜sent記録前にワーカーが停止すると、lease期限切れ後の再試行で
--   重複送信しうる。UNIQUE(user_id, free_until) とlease tokenで重複を最小化するが、
--   DBと外部APIをまたぐ単一トランザクションは不可能なため完全な排除は原理上不可。

create table public.free_end_notification_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  free_until timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  lease_token uuid,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint free_end_notification_claims_user_free_until_key unique (user_id, free_until)
);

create index free_end_notification_claims_claimable_idx
  on public.free_end_notification_claims (status, free_until);

alter table public.free_end_notification_claims enable row level security;

-- ポリシーを一切作らない = anon/authenticated はRLSにより全操作拒否。
-- service_role はRLSをバイパスするため、Express（Service Role）からのみ操作可能。
-- Supabaseのdefault privileges対策としてテーブル権限も明示的に剥奪する。
revoke all on table public.free_end_notification_claims from public, anon, authenticated;

-- ============================================================
-- 通知対象の確保RPC
-- 1呼び出し = 1トランザクションで「登録 → 無効化 → 排他確保」を実行。
-- 時刻判定はすべてDBの now() 基準（呼び出し側から時刻を受け取らない）。
-- ============================================================
create or replace function public.claim_free_end_notifications(
  p_limit integer default 50,
  p_lease_seconds integer default 120,
  p_max_attempts integer default 3,
  p_window interval default interval '5 minutes'
)
returns table (
  claim_id uuid,
  user_id uuid,
  free_until timestamptz,
  attempts integer,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'p_limit must be between 1 and 1000';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 3600 then
    raise exception 'p_lease_seconds must be between 10 and 3600';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 10 then
    raise exception 'p_max_attempts must be between 1 and 10';
  end if;
  if p_window is null or p_window <= interval '0' or p_window > interval '1 hour' then
    raise exception 'p_window must be greater than 0 and at most 1 hour';
  end if;

  -- 1. 対象プロフィールの通知を登録
  --    UNIQUE(user_id, free_until) により同一終了予定の重複登録を防止（冪等）。
  --    延長で free_until が変わると別キーになるため、新しい終了時刻で再通知可能。
  insert into public.free_end_notification_claims (user_id, free_until)
  select p.id, p.free_until
  from public.profiles p
  where p.is_free = true
    and p.free_until is not null
    and p.free_until > now()
    and p.free_until <= now() + p_window
  on conflict on constraint free_end_notification_claims_user_free_until_key do nothing;

  -- 2. 手動OFF・延長・期限切れで無効になった未送信通知をキャンセル
  --    processing 中の行もキャンセルする → ワーカーの送信前再検証・完了更新が失敗し、
  --    手動OFF後の古い通知を送らない。
  update public.free_end_notification_claims c
  set status = 'cancelled', updated_at = now()
  where c.status in ('pending', 'processing', 'failed')
    and not exists (
      select 1
      from public.profiles p
      where p.id = c.user_id
        and p.is_free = true
        and p.free_until is not null
        and p.free_until = c.free_until
        and p.free_until > now()
    );

  -- 3. 確保可能な通知を FOR UPDATE SKIP LOCKED で排他的に取得し processing 化
  --    対象: pending / 再試行可能な failed / lease期限切れの processing（ワーカー停止からの回復）
  return query
  with candidates as (
    select c.id
    from public.free_end_notification_claims c
    where c.free_until > now()
      and (
        c.status = 'pending'
        or (c.status = 'failed' and c.attempts < p_max_attempts)
        or (c.status = 'processing'
            and c.lease_expires_at is not null
            and c.lease_expires_at <= now()
            and c.attempts < p_max_attempts)
      )
      and exists (
        -- 確保直前の再確認（防御的）：プロフィールが依然として有効なこと
        select 1
        from public.profiles p
        where p.id = c.user_id
          and p.is_free = true
          and p.free_until = c.free_until
      )
    order by c.free_until
    limit p_limit
    for update of c skip locked
  )
  update public.free_end_notification_claims c
  set status = 'processing',
      attempts = c.attempts + 1,
      claimed_at = now(),
      lease_expires_at = now() + (p_lease_seconds || ' seconds')::interval,
      lease_token = gen_random_uuid(),
      updated_at = now()
  from candidates
  where c.id = candidates.id
  returning c.id, c.user_id, c.free_until, c.attempts, c.lease_token, c.lease_expires_at;
end;
$$;

revoke all on function public.claim_free_end_notifications(integer, integer, integer, interval)
  from public, anon, authenticated;
grant execute on function public.claim_free_end_notifications(integer, integer, integer, interval)
  to service_role;

-- ============================================================
-- 送信前再検証RPC
-- ワーカーが送信直前に呼び、lease所有権（token一致・processing中・lease有効期限内）
-- とプロフィール状態を確認する。
-- 0行（claim不存在）の場合は空結果。呼び出し側は「送信不可」として扱う。
-- ============================================================
create or replace function public.validate_free_end_notification(
  p_claim_id uuid,
  p_lease_token uuid
)
returns table (
  owned boolean,
  still_valid boolean,
  is_free boolean,
  free_until timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_claim_id is null or p_lease_token is null then
    raise exception 'p_claim_id and p_lease_token are required';
  end if;

  return query
  select
    (c.lease_token = p_lease_token
      and c.status = 'processing'
      and c.lease_expires_at is not null
      and c.lease_expires_at > now()) as owned,
    coalesce(
      p.is_free = true and p.free_until = c.free_until and p.free_until > now(),
      false
    ) as still_valid,
    p.is_free,
    p.free_until
  from public.free_end_notification_claims c
  left join public.profiles p on p.id = c.user_id
  where c.id = p_claim_id;
end;
$$;

revoke all on function public.validate_free_end_notification(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.validate_free_end_notification(uuid, uuid)
  to service_role;

-- ============================================================
-- 状態更新RPC（成功・失敗・キャンセル）
-- lease tokenによる所有者確認で、古い処理・別ワーカーによる上書きを防ぐ。
-- 戻り値 false = 所有権なし（拒否）。呼び出し側は重複処理を中断する。
-- lease再確保時にtokenが再生成されるため、token一致だけで
-- 「lease期限切れだが未再確保」の正常完了と「別ワーカーに再確保された」不正完了を
-- 区別できる。前者の完了を許可するため、ここではlease有効期限は条件に含めない
-- （含めると送信成功後の記録に失敗→再試行→重複送信のリスクが増える）。
-- ============================================================
create or replace function public.complete_free_end_notification(
  p_claim_id uuid,
  p_lease_token uuid,
  p_status text,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_rows integer;
begin
  if p_claim_id is null or p_lease_token is null then
    raise exception 'p_claim_id and p_lease_token are required';
  end if;
  if p_status not in ('sent', 'failed', 'cancelled') then
    raise exception 'p_status must be one of: sent, failed, cancelled';
  end if;

  update public.free_end_notification_claims c
  set status = p_status,
      sent_at = case when p_status = 'sent' then now() else c.sent_at end,
      last_error = case when p_status = 'failed' then p_error else c.last_error end,
      lease_expires_at = null,
      updated_at = now()
  where c.id = p_claim_id
    and c.lease_token = p_lease_token
    and c.status = 'processing';

  get diagnostics updated_rows = row_count;
  return updated_rows = 1;
end;
$$;

revoke all on function public.complete_free_end_notification(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_free_end_notification(uuid, uuid, text, text)
  to service_role;
