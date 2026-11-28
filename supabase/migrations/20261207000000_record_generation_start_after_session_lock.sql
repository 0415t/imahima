BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION push_private.guard_managed_device_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE actor_session uuid;
DECLARE actor uuid;
BEGIN
    IF TG_TABLE_NAME='logout_recoveries' THEN
        actor_session := NEW.scope_session;
        actor := NEW.scope_user;
    ELSE
        actor_session := NEW.session_id;
        actor := NEW.user_id;
    END IF;
    IF actor_session IS NULL THEN RETURN NEW; END IF;
    PERFORM push_private.lock_device_session(actor_session);
    IF TG_OP='INSERT' AND NOT push_private.lock_live_device_auth(actor,actor_session) THEN
        RAISE EXCEPTION 'Session is unavailable' USING ERRCODE='42501';
    END IF;
    IF TG_OP='INSERT' AND TG_TABLE_NAME='installation_bindings' THEN
        -- Record the live session under its locks, before inserting the generation.
        -- This is not the transaction's commit timestamp.
        NEW.created_at := clock_timestamp();
    END IF;
    RETURN NEW;
END $$;
COMMIT;
