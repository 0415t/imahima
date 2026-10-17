create table public.user_device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expo_push_token text not null unique,
  platform text not null,
  device_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on public.user_device_tokens (user_id);

alter table public.user_device_tokens enable row level security;

create policy "own tokens select" on public.user_device_tokens
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own tokens delete" on public.user_device_tokens
  for delete to authenticated using ((select auth.uid()) = user_id);

create or replace function public.upsert_device_token(
  p_token text, p_platform text, p_device_name text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.user_device_tokens (user_id, expo_push_token, platform, device_name)
  values (auth.uid(), p_token, p_platform, p_device_name)
  on conflict (expo_push_token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        device_name = excluded.device_name,
        updated_at = now();
end;
$$;

revoke all on function public.upsert_device_token(text, text, text) from public, anon;
grant execute on function public.upsert_device_token(text, text, text) to authenticated;
