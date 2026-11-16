-- ISOLATED EMPTY TEST DATABASE ONLY. Not a production migration.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text, is_free boolean default false, free_until timestamptz
);
create function public.generate_room_key() returns text language sql as $$ select 'legacy'::text $$;
create table public.rooms (
  id uuid primary key default gen_random_uuid(), room_name text,
  room_key text default public.generate_room_key(),
  constraint rooms_room_key_unique unique(room_key)
);
create table public.room_members (
  room_id uuid references public.rooms(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member', joined_at timestamptz not null default now(),
  primary key(room_id, user_id)
);
grant usage on schema public to anon, authenticated, service_role;
grant select on public.profiles to service_role;
insert into public.rooms(room_name, room_key) values ('Legacy A', 'Legacy1'), ('Legacy B', 'Legacy2');
