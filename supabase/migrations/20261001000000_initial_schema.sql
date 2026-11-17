-- 初期スキーマ（Supabase Dashboardで手動作成されていたオブジェクトの再現）
-- リモートDBのスキーマダンプ（読み取り専用で取得）をもとに作成。
-- 既存マイグレーション（20261006以降）が前提とする public.profiles 等を提供する。
--
-- 注意:
-- - profiles.free_until は含めない（20261104000000_profile_free_until.sql が追加する）
-- - user_device_tokens は含めない（20261017000000_create_user_device_tokens.sql が作成する）
-- - 冪等性（IF NOT EXISTS / OR REPLACE / ポリシー存在チェック）はローカル再現のためのものであり、
--   リモートへの適用方法（履歴との整合）は別途検討する

-- rooms.room_key のデフォルトが参照するため、rooms より先に作成する
create or replace function public.generate_room_key()
returns text
language plpgsql
as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz23456789';
  result text := '';
  i integer;
begin
  for i in 1..6 loop
    result := result || substr(
      chars,
      floor(random() * length(chars) + 1)::integer,
      1
    );
  end loop;
  return result;
end;
$$;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  room_name text,
  room_key text default public.generate_room_key(),
  constraint rooms_room_key_unique unique (room_key)
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text,
  is_free boolean default false,
  created_at timestamptz not null default timezone('utc', now()),
  coment text,
  avatar_url text
);

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  is_free boolean not null default false
);

-- 新規ユーザー作成時に profiles へ挿入するトリガー
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, username, is_free)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', '名無し'),
    false
  );
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- RLS有効化（rooms / room_members はリモート同様ポリシーなし＝APIからアクセス不可）
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.users enable row level security;

-- ポリシー（既存がある場合は重複作成しない）
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'Public profiles are viewable by everyone.'
  ) then
    create policy "Public profiles are viewable by everyone."
      on public.profiles for select using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'Users can insert their own profile.'
  ) then
    create policy "Users can insert their own profile."
      on public.profiles for insert with check (auth.uid() = id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'Users can update own profile.'
  ) then
    create policy "Users can update own profile."
      on public.profiles for update using (auth.uid() = id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'users'
      and policyname = 'Allow public read users'
  ) then
    create policy "Allow public read users"
      on public.users for select to authenticated, anon using (true);
  end if;
end;
$$;
