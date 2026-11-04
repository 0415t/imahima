alter table public.profiles
  add column if not exists free_until timestamptz;

-- 既存の is_free = true 行は free_until が NULL で即OFF扱いになるため、OFFに揃える
update public.profiles
set is_free = false
where is_free = true and free_until is null;

-- 明示的なON/OFF設定（時間選択可能: 30/60/120/180分）
create or replace function public.set_profile_is_free(
  target_profile_id uuid,
  new_is_free boolean,
  duration_minutes integer default 60
)
returns table (is_free boolean, free_until timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- 許可する時間: 30分、1時間、2時間、3時間
  if new_is_free and duration_minutes not in (30, 60, 120, 180) then
    raise exception 'duration_minutes must be one of: 30, 60, 120, 180';
  end if;

  if new_is_free then
    return query
      update public.profiles
      set is_free = true,
          free_until = now() + (duration_minutes || ' minutes')::interval
      where id = target_profile_id
      returning profiles.is_free, profiles.free_until;
  else
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

-- 既存toggle関数もタイマー対応に更新（後方互換、デフォルト1時間）
create or replace function public.toggle_profile_is_free(target_profile_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_is_free boolean;
begin
  update public.profiles
  set is_free = not is_free,
      free_until = case when not is_free then now() + interval '1 hour' else null end
  where id = target_profile_id
  returning is_free into updated_is_free;

  return updated_is_free;
end;
$$;