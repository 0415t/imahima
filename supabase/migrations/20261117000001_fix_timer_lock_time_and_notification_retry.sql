-- Forward-only replacement: retain applied migration history.
-- Requires the timer, notification claims and notification extension migrations.

-- set_profile_is_free を原子的な処理に置き換える
-- - duration_minutes のデフォルトを null（タイマーなし＝無期限ON）に変更
-- - 行ロック（FOR UPDATE）で同時ONリクエストを直列化し、タイマーの意図しない上書きを防ぐ
-- - 有効なON中の再ONは既存の free_until を維持し、期限切れ後の再ONは新しいタイマーを開始する
-- 注意: is_free = true AND free_until IS NULL は無期限ONを意味するため、
--       この状態をOFFにするデータ更新は行わない
create or replace function public.set_profile_is_free(
  target_profile_id uuid,
  new_is_free boolean,
  duration_minutes integer default null
)
returns table (is_free boolean, free_until timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_is_free boolean;
  current_free_until timestamptz;
  checked_at timestamptz;
begin
  -- 対象行をロックして現在の状態を取得（同時リクエストを直列化）
  select p.is_free, p.free_until into current_is_free, current_free_until
  from public.profiles p
  where p.id = target_profile_id
  for update;

  -- プロフィールが存在しない場合
  if not found then
    return;
  end if;

  checked_at := clock_timestamp();

  -- ONにする場合
  if new_is_free then
    -- すでに有効なON状態の場合は、既存の状態を維持して返す
    if current_is_free and (current_free_until is null or current_free_until > checked_at) then
      return query select current_is_free, current_free_until;
      return;
    end if;

    -- 時間指定がある場合はバリデーション
    if duration_minutes is not null and duration_minutes not in (30, 60, 120, 180) then
      raise exception 'duration_minutes must be one of: 30, 60, 120, 180, or null';
    end if;

    -- 新規ONまたは期限切れ後の再ON
    return query
      update public.profiles
      set is_free = true,
          free_until = case
            when duration_minutes is null then null
            else checked_at + (duration_minutes || ' minutes')::interval
          end
      where id = target_profile_id
      returning profiles.is_free, profiles.free_until;
  else
    -- OFFにする場合はタイマー情報を削除
    return query
      update public.profiles
      set is_free = false,
          free_until = null
      where id = target_profile_id
      returning profiles.is_free, profiles.free_until;
  end if;
end;
$$;

revoke all on function public.set_profile_is_free(uuid, boolean, integer) from public, anon, authenticated;
grant execute on function public.set_profile_is_free(uuid, boolean, integer) to service_role;

-- タイマー延長機能: 有効なタイマー付きON状態でのみ free_until を30分延長する
create or replace function public.extend_profile_is_free(target_profile_id uuid)
returns table (is_free boolean, free_until timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_is_free boolean;
  current_free_until timestamptz;
begin
  -- 対象行をロックして現在の状態を取得（同時リクエストを直列化）
  select p.is_free, p.free_until into current_is_free, current_free_until
  from public.profiles p
  where p.id = target_profile_id
  for update;

  -- プロフィールが存在しない場合
  if not found then
    return;
  end if;

  -- 有効なタイマー付きON状態でのみ延長可能
  -- OFF・無期限ON（free_until IS NULL）・期限切れの場合はエラー
  if not current_is_free or current_free_until is null or current_free_until <= clock_timestamp() then
    raise exception 'Cannot extend: not in an active timed free state';
  end if;

  -- free_until に30分加算
  return query
    update public.profiles
    set free_until = current_free_until + interval '30 minutes'
    where id = target_profile_id
    returning profiles.is_free, profiles.free_until;
end;
$$;

revoke all on function public.extend_profile_is_free(uuid) from public, anon, authenticated;
grant execute on function public.extend_profile_is_free(uuid) to service_role;
-- 通知アクションからの30分延長RPC
-- 終了5分前通知の「30分延長」ボタンから呼び出されることを想定。
-- 通知データ自体は信頼せず、認証済みユーザーとDB上のclaimを照合する。
--
-- 二重延長の防止:
-- - claim.free_until と現在の profiles.free_until の一致を必須とする。
--   1回目の延長で free_until が変わるため、同じ通知からの2回目の延長は
--   一致しなくなり拒否される（バックグラウンドタスクとフォアグラウンド
--   リスナーの両方が同じイベントを処理しても安全）。
-- - 行ロック（FOR UPDATE）で同時リクエストを直列化する。
create or replace function public.extend_profile_is_free_from_notification(
  target_profile_id uuid,
  claim_id uuid
)
returns table (is_free boolean, free_until timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_is_free boolean;
  current_free_until timestamptz;
  claim_status text;
  claim_free_until timestamptz;
begin
  -- 対象行をロックして現在の状態を取得（同時リクエストを直列化）
  select p.is_free, p.free_until into current_is_free, current_free_until
  from public.profiles p
  where p.id = target_profile_id
  for update;

  -- プロフィールが存在しない場合
  if not found then
    return;
  end if;

  -- 有効なタイマー付きON状態でのみ延長可能
  -- OFF・無期限ON（free_until IS NULL）・期限切れの場合はエラー
  if not current_is_free or current_free_until is null or current_free_until <= clock_timestamp() then
    raise exception 'Cannot extend: not in an active timed free state';
  end if;

  -- claimの照合: 本人のclaimであり、送信済みであること
  select c.status, c.free_until into claim_status, claim_free_until
  from public.free_end_notification_claims c
  where c.id = claim_id
    and c.user_id = target_profile_id;

  if not found then
    raise exception 'Cannot extend: notification claim not found';
  end if;

  -- A completed request releases its profile lock before the client retries.
  -- Never wait for the sender while holding this lock.
  if claim_status = 'processing' and claim_free_until = current_free_until then
    raise exception 'Cannot extend: notification claim is processing';
  end if;

  if claim_status <> 'sent' then
    raise exception 'Cannot extend: notification claim is not sent';
  end if;

  -- 通知時の終了予定と現在の終了予定が一致すること（二重延長・古い通知からの延長を防止）
  if claim_free_until <> current_free_until then
    raise exception 'Cannot extend: free_until has changed since notification';
  end if;

  -- free_until に30分加算
  return query
    update public.profiles
    set free_until = current_free_until + interval '30 minutes'
    where id = target_profile_id
    returning profiles.is_free, profiles.free_until;
end;
$$;

revoke all on function public.extend_profile_is_free_from_notification(uuid, uuid) from public, anon, authenticated;
grant execute on function public.extend_profile_is_free_from_notification(uuid, uuid) to service_role;
