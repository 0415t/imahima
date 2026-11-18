-- Issue #35: additive hardening; never replays historical migrations.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $profile_guard$
BEGIN
 IF pg_catalog.has_any_column_privilege('anon','public.profiles','INSERT') OR pg_catalog.has_any_column_privilege('authenticated','public.profiles','INSERT')
 OR pg_catalog.has_column_privilege('anon','public.profiles','is_free','UPDATE')
 OR pg_catalog.has_column_privilege('authenticated','public.profiles','is_free','UPDATE')
 OR pg_catalog.has_column_privilege('anon','public.profiles','free_until','UPDATE')
 OR pg_catalog.has_column_privilege('authenticated','public.profiles','free_until','UPDATE') THEN RAISE EXCEPTION 'Apply restrict_profile_client_writes first'; END IF;
END
$profile_guard$;
DO $guard$
DECLARE target text; relation_oid oid; columns_sql text; signature text;
BEGIN
  IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Reviewed postgres execution role required'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated','service_role')) <> 3
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated','service_role') AND rolsuper)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated') AND rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member WHERE r.rolname IN ('anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Unexpected application role configuration';
  END IF;
  FOREACH signature IN ARRAY ARRAY['public.handle_new_user()','public.auto_expire_free_status()','public.upsert_device_token(text,text,text)','public.generate_room_key()','public.toggle_profile_is_free(uuid)','public.set_profile_is_free(uuid,boolean,integer)','public.extend_profile_is_free(uuid)','public.group_mvp_consume_rate(text,integer)','public.group_mvp_execute(text,uuid,jsonb)']::text[] LOOP
    IF pg_catalog.to_regprocedure(signature) IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure(signature) AND proowner=current_user::regrole AND prokind='f') THEN
      RAISE EXCEPTION 'Missing or unexpected function owner: %', signature;
    END IF;
  END LOOP;
  FOREACH target IN ARRAY ARRAY['profiles','users','user_device_tokens','rooms','room_members','group_mvp_rate_limits']::text[] LOOP
    relation_oid := pg_catalog.to_regclass(pg_catalog.format('public.%I',target));
    IF relation_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=relation_oid AND relkind='r' AND relowner=current_user::regrole AND relrowsecurity AND NOT relforcerowsecurity) THEN
      RAISE EXCEPTION 'Unexpected target table metadata: %',target;
    END IF;
    SELECT pg_catalog.string_agg(pg_catalog.quote_ident(attname),', ' ORDER BY attnum) INTO columns_sql
      FROM pg_catalog.pg_attribute WHERE attrelid=relation_oid AND attnum>0 AND NOT attisdropped;
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',target);
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',columns_sql,target);
  END LOOP;
END
$guard$;
GRANT SELECT (id,username,is_free,created_at,coment,avatar_url,free_until) ON public.profiles TO anon,authenticated;
GRANT UPDATE (username,coment,avatar_url) ON public.profiles TO authenticated;
GRANT SELECT (id,username,is_free,free_until) ON public.profiles TO service_role;
GRANT UPDATE (is_free,free_until) ON public.profiles TO service_role;
GRANT SELECT ON public.users TO anon,authenticated;
GRANT SELECT,DELETE ON public.user_device_tokens TO authenticated;
GRANT SELECT (user_id,expo_push_token) ON public.user_device_tokens TO service_role;
GRANT DELETE ON public.user_device_tokens TO service_role;
-- RETURNING * / %ROWTYPE and room row locks require these SELECT/UPDATE grants.
GRANT SELECT ON public.rooms TO service_role;
GRANT INSERT (room_name,room_key,mvp_created_by) ON public.rooms TO service_role;
GRANT UPDATE (mvp_archived_at) ON public.rooms TO service_role;
GRANT SELECT ON public.room_members TO service_role;
GRANT INSERT (room_id,user_id,role) ON public.room_members TO service_role;
GRANT DELETE ON public.room_members TO service_role;
GRANT SELECT,INSERT,DELETE ON public.group_mvp_rate_limits TO service_role;
GRANT UPDATE (window_start,attempts) ON public.group_mvp_rate_limits TO service_role;
-- Preserve the Auth trigger body, metadata defaults and initial OFF state.
ALTER FUNCTION public.handle_new_user() SET search_path='';
REVOKE ALL PRIVILEGES ON FUNCTION
  public.handle_new_user(),
  public.auto_expire_free_status(),
  public.upsert_device_token(text,text,text),
  public.generate_room_key(),
  public.toggle_profile_is_free(uuid),
  public.set_profile_is_free(uuid,boolean,integer),
  public.extend_profile_is_free(uuid),
  public.group_mvp_consume_rate(text,integer),
  public.group_mvp_execute(text,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.upsert_device_token(text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION
  public.generate_room_key(),
  public.toggle_profile_is_free(uuid),
  public.set_profile_is_free(uuid,boolean,integer),
  public.extend_profile_is_free(uuid),
  public.group_mvp_consume_rate(text,integer),
  public.group_mvp_execute(text,uuid,jsonb) TO service_role;
COMMIT;
