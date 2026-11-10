-- 暇状態はExpress + service_role RPCだけが変更する。
-- 既存の列ACLも全列分除去してから、編集列だけを再付与する。
-- 共有の親ロールの権限・メンバーシップは勝手に変更しない。
-- 継承/SET ROLEで禁止権限が残る構成では例外にし、このDO全体を取り消す。
do $$
declare
  profile_table regclass := 'public.profiles'::regclass;
  column_list text;
  client_role record;
  parent_role record;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum)
    into column_list
  from pg_attribute
  where attrelid = profile_table and attnum > 0 and not attisdropped;

  revoke insert, update on public.profiles from public, anon, authenticated;
  execute format('revoke insert (%s), update (%s) on public.profiles from public, anon, authenticated',
                 column_list, column_list);
  grant update (username, coment, avatar_url) on public.profiles to authenticated;
  -- INVOKER RPCとバックエンドの既存処理に必要な権限を明示する。
  grant select, update on public.profiles to service_role;

  -- MEMBERを用い、NOINHERITでも所属先への切替経路を保守的に検出する。
  for client_role in select oid, rolname from pg_roles where rolname in ('anon', 'authenticated') loop
    for parent_role in
      select r.* from pg_roles r
      where r.oid = client_role.oid or pg_has_role(client_role.oid, r.oid, 'MEMBER')
    loop
      if parent_role.rolsuper or parent_role.rolbypassrls
         or parent_role.oid = (select relowner from pg_class where oid = profile_table)
         or has_any_column_privilege(parent_role.oid, profile_table, 'INSERT')
         or exists (
           select 1 from pg_attribute a
           where a.attrelid = profile_table and a.attnum > 0 and not a.attisdropped
             -- 親ロールへSET ROLEすると本人限定ポリシーの対象が変わり得るため、
             -- 親ロールの編集列UPDATEも自動許可しない。
             and (client_role.rolname = 'anon' or parent_role.oid <> client_role.oid
                  or a.attname not in ('username', 'coment', 'avatar_url'))
             and has_column_privilege(parent_role.oid, profile_table, a.attnum, 'UPDATE')
         ) then
        raise exception 'Unsafe profiles privileges: client % can access role %. Review inherited grants/membership before retrying.',
          client_role.rolname, parent_role.rolname;
      end if;
    end loop;
  end loop;

  alter table public.profiles enable row level security;
  drop policy if exists "Users can insert their own profile." on public.profiles;
  drop policy if exists "Users can update own profile." on public.profiles;
  create policy "Users can update own profile." on public.profiles
    for update to authenticated
    using ((select auth.uid()) = id)
    with check ((select auth.uid()) = id);
  -- 未知の追加PERMISSIVEポリシーがあっても本人制限を拡張させない。
  drop policy if exists "Client profile updates require ownership" on public.profiles;
  create policy "Client profile updates require ownership" on public.profiles
    as restrictive for update to authenticated
    using ((select auth.uid()) = id)
    with check ((select auth.uid()) = id);
end;
$$;
