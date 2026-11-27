BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';

CREATE TABLE push_private.legacy_registration_sessions (
    token_id uuid PRIMARY KEY REFERENCES public.user_device_tokens(id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL
);
CREATE INDEX legacy_registration_sessions_owner ON push_private.legacy_registration_sessions(user_id,session_id);
ALTER TABLE push_private.legacy_registration_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON push_private.legacy_registration_sessions
    FROM PUBLIC, anon, authenticated, service_role, imahima_device_verifier, imahima_logout_recovery_verifier;

CREATE FUNCTION push_private.lock_device_session(p_session uuid) RETURNS void
LANGUAGE sql SET search_path = '' AS $$
    SELECT pg_advisory_xact_lock(hashtextextended(p_session::text, 310031))
$$;

CREATE FUNCTION push_private.jwt_device_session() RETURNS uuid
LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT CASE WHEN auth.jwt()->>'session_id' ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN (auth.jwt()->>'session_id')::uuid END
$$;

CREATE FUNCTION push_private.live_legacy_device_jwt() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE actor_session uuid := push_private.jwt_device_session();
BEGIN
    IF auth.uid() IS NULL OR actor_session IS NULL THEN RETURN false; END IF;
    RETURN push_private.auth_session_present(auth.uid(),actor_session)
        AND NOT EXISTS (SELECT 1 FROM push_private.installation_bindings b WHERE b.session_id=actor_session)
        AND NOT EXISTS (SELECT 1 FROM push_private.logout_recoveries r WHERE r.scope_session=actor_session);
END $$;

-- Legacy registration and notification extension take a row lock that
-- conflicts with GoTrue deleting that session. The lookup is on the primary.
CREATE FUNCTION push_private.lock_live_device_auth(p_user uuid,p_session uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path = '' SET row_security = off AS $$
DECLARE owner_id uuid;
BEGIN
    IF p_user IS NULL OR p_session IS NULL OR pg_is_in_recovery() THEN
        RAISE EXCEPTION 'Session cannot be verified' USING ERRCODE='55000';
    END IF;
    SELECT s.user_id INTO owner_id FROM auth.sessions s WHERE s.id=p_session FOR KEY SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    IF owner_id IS DISTINCT FROM p_user THEN
        RAISE EXCEPTION 'Session ownership mismatch' USING ERRCODE='55000';
    END IF;
    RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.upsert_device_token(
    p_token text,p_platform text,p_device_name text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE actor uuid := auth.uid();
DECLARE actor_session uuid := push_private.jwt_device_session();
DECLARE registered_id uuid;
BEGIN
    IF actor IS NULL OR actor_session IS NULL THEN
        RAISE EXCEPTION 'Session is unavailable' USING ERRCODE='42501';
    END IF;
    PERFORM push_private.lock_device_session(actor_session);
    IF NOT push_private.lock_live_device_auth(actor,actor_session) OR EXISTS (
        SELECT 1 FROM push_private.installation_bindings b WHERE b.session_id=actor_session
    ) OR EXISTS (
        SELECT 1 FROM push_private.logout_recoveries r WHERE r.scope_session=actor_session
    ) THEN RAISE EXCEPTION 'Session is unavailable' USING ERRCODE='42501'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_token,250025));
    IF EXISTS (SELECT 1 FROM push_private.managed_token_reservations
        WHERE token_digest=sha256(convert_to(p_token,'UTF8'))) THEN
        RAISE EXCEPTION 'Device token is unavailable' USING ERRCODE='42501';
    END IF;
    INSERT INTO public.user_device_tokens AS existing(user_id,expo_push_token,platform,device_name)
    VALUES(actor,p_token,p_platform,p_device_name)
    ON CONFLICT (expo_push_token) DO UPDATE SET user_id=excluded.user_id,platform=excluded.platform,
        device_name=excluded.device_name,updated_at=now()
    WHERE existing.installation_id IS NULL RETURNING id INTO registered_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Device token is unavailable' USING ERRCODE='42501'; END IF;
    INSERT INTO push_private.legacy_registration_sessions(token_id,user_id,session_id)
    VALUES(registered_id,actor,actor_session)
    ON CONFLICT (token_id) DO UPDATE SET user_id=excluded.user_id,session_id=excluded.session_id;
END $$;

-- The callers already hold the installation lock. The triggers also cover
-- older managed entrypoints and the no-generation recovery case.
CREATE FUNCTION push_private.guard_managed_device_session() RETURNS trigger
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
    IF EXISTS (SELECT 1 FROM push_private.legacy_registration_sessions l
        WHERE l.user_id=actor AND l.session_id=actor_session) THEN
        RAISE EXCEPTION 'Legacy registration must be cleared first' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END $$;
CREATE INDEX installation_bindings_session ON push_private.installation_bindings(session_id);
CREATE INDEX logout_recoveries_scope_session ON push_private.logout_recoveries(scope_session) WHERE scope_session IS NOT NULL;
CREATE TRIGGER session_guard_managed_start BEFORE INSERT OR UPDATE OF fenced_at ON push_private.installation_bindings
    FOR EACH ROW EXECUTE FUNCTION push_private.guard_managed_device_session();
CREATE TRIGGER guard_scoped_logout BEFORE INSERT ON push_private.logout_recoveries
    FOR EACH ROW EXECUTE FUNCTION push_private.guard_managed_device_session();

ALTER POLICY "own tokens select" ON public.user_device_tokens USING
    (user_id=(SELECT auth.uid()) AND installation_id IS NULL AND (SELECT push_private.live_legacy_device_jwt()));
ALTER POLICY "own tokens delete" ON public.user_device_tokens USING
    (user_id=(SELECT auth.uid()) AND installation_id IS NULL AND (SELECT push_private.live_legacy_device_jwt()));

CREATE FUNCTION push_private.extend_free_for_live_notification_session(p_user uuid,p_session uuid,p_claim uuid)
RETURNS TABLE(is_free boolean,free_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
BEGIN
    PERFORM push_private.lock_device_session(p_session);
    IF NOT push_private.lock_live_device_auth(p_user,p_session) THEN
        RAISE EXCEPTION 'Session is unavailable' USING ERRCODE='28000';
    END IF;
    IF EXISTS (SELECT 1 FROM push_private.installation_bindings WHERE session_id=p_session AND fenced_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM push_private.logout_recoveries WHERE scope_session=p_session) THEN
        RAISE EXCEPTION 'Session is unavailable' USING ERRCODE='28000';
    END IF;
    RETURN QUERY SELECT result.is_free,result.free_until
        FROM public.extend_profile_is_free_from_notification(p_user,p_claim) result;
END $$;

ALTER FUNCTION push_private.lock_device_session(uuid) OWNER TO postgres;
ALTER FUNCTION push_private.jwt_device_session() OWNER TO postgres;
ALTER FUNCTION push_private.live_legacy_device_jwt() OWNER TO postgres;
ALTER FUNCTION push_private.lock_live_device_auth(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION push_private.guard_managed_device_session() OWNER TO postgres;
ALTER FUNCTION push_private.extend_free_for_live_notification_session(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION push_private.lock_device_session(uuid),push_private.jwt_device_session(),
    push_private.live_legacy_device_jwt(),push_private.lock_live_device_auth(uuid,uuid),
    push_private.guard_managed_device_session(),push_private.extend_free_for_live_notification_session(uuid,uuid,uuid)
    FROM PUBLIC, anon, authenticated, service_role, imahima_device_verifier, imahima_logout_recovery_verifier;
GRANT EXECUTE ON FUNCTION push_private.live_legacy_device_jwt() TO authenticated;
GRANT EXECUTE ON FUNCTION push_private.extend_free_for_live_notification_session(uuid,uuid,uuid) TO imahima_device_verifier;
REVOKE EXECUTE ON FUNCTION public.extend_profile_is_free_from_notification(uuid,uuid) FROM service_role;
COMMIT;
