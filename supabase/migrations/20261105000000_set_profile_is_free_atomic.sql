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

  -- ONにする場合
  if new_is_free then
    -- すでに有効なON状態の場合は、既存の状態を維持して返す
    if current_is_free and (current_free_until is null or current_free_until > now()) then
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
            else now() + (duration_minutes || ' minutes')::interval
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
