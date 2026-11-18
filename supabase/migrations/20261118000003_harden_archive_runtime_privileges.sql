-- Requires core hardening and the reviewed, fully classified archive migration.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('group_mvp_private.archive_empty_membership_rooms()') AND proowner=current_user::regrole AND prosecdef) THEN RAISE EXCEPTION 'Reviewed archive function and postgres owner required'; END IF;
 IF pg_catalog.has_table_privilege('service_role','public.rooms','INSERT') THEN RAISE EXCEPTION 'Core hardening prerequisite missing'; END IF;
END $guard$;
GRANT INSERT (mvp_managed) ON public.rooms TO service_role;
REVOKE ALL PRIVILEGES ON SCHEMA group_mvp_private FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL PRIVILEGES ON FUNCTION group_mvp_private.archive_empty_membership_rooms() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
