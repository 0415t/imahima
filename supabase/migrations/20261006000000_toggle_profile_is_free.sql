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
  set is_free = not is_free
  where id = target_profile_id
  returning is_free into updated_is_free;

  return updated_is_free;
end;
$$;

revoke all on function public.toggle_profile_is_free(uuid) from public, anon, authenticated;
grant execute on function public.toggle_profile_is_free(uuid) to service_role;
