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
  if not current_is_free or current_free_until is null or current_free_until <= now() then
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