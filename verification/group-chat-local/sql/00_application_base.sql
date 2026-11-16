-- LOCAL imahima-chat-local ONLY. Not a production baseline or a schema backup.
-- Supabase supplies auth.users/auth.uid()/roles; never recreate those objects.
-- No seed data, legacy sample rooms, timer functions or notification jobs.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text,
  is_free boolean default false,
  created_at timestamptz not null default timezone('utc'::text, now()),
  coment text,
  avatar_url text,
  free_until timestamptz
);
alter table public.profiles enable row level security;
revoke all on public.profiles from public, anon, authenticated, service_role;
grant select on public.profiles to service_role, authenticated;
create policy chat_local_profile_self_read on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

-- Same secure format that the existing group migration installs. Its CREATE OR
-- REPLACE retains this function's service-only ACL and the room default's OID.
create function public.generate_room_key() returns text
language sql volatile security invoker set search_path='' as $$
  select replace(pg_catalog.gen_random_uuid()::text, '-', '');
$$;
revoke all on function public.generate_room_key() from public, anon, authenticated, service_role;
grant execute on function public.generate_room_key() to service_role;

create table public.rooms (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  room_name text,
  room_key text default public.generate_room_key(),
  constraint rooms_room_key_unique unique(room_key)
);
create table public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key(room_id,user_id)
);
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
revoke all on public.rooms,public.room_members from public,anon,authenticated,service_role;
-- The following existing group migration grants its required service DML.

-- Additional LOCAL trigger only: preserve every existing Auth function/table/
-- trigger and place the new trigger function outside PostgREST exposed schemas.
create schema chat_local_support;
revoke all on schema chat_local_support from public,anon,authenticated,service_role;
create function chat_local_support.handle_new_user() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.profiles(id,username,is_free)
    values (new.id,coalesce(new.raw_user_meta_data->>'username','名無し'),false);
  return new;
end;
$$;
revoke all on function chat_local_support.handle_new_user() from public,anon,authenticated,service_role;
create trigger chat_local_profile_created after insert on auth.users
  for each row execute function chat_local_support.handle_new_user();

commit;
