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
  if not current_is_free or current_free_until is null or current_free_until <= now() then
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
