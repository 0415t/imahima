BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';

-- Align RPC admission (including reuse) with the installation-wide INSERT guard.
CREATE OR REPLACE FUNCTION push_private.open_device_generation(
    p_installation uuid,p_user uuid,p_session uuid,p_key_version bigint,p_challenge bytea)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE previous push_private.installation_bindings%ROWTYPE;
DECLARE opened bigint;
BEGIN
    PERFORM push_private.consume_device_challenge(p_installation,p_key_version,'enroll',p_challenge);
    IF EXISTS (SELECT 1 FROM push_private.logout_recoveries
        WHERE installation_id=p_installation AND cleared_at IS NULL) THEN
        RAISE EXCEPTION 'Previous logout is pending' USING ERRCODE='42501';
    END IF;
    IF EXISTS (SELECT 1 FROM push_private.logout_recoveries
        WHERE installation_id=p_installation AND scope_session=p_session AND scope_user=p_user)
        OR EXISTS (SELECT 1 FROM push_private.installation_bindings
            WHERE installation_id=p_installation AND session_id=p_session AND user_id=p_user AND fenced_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Session is fenced' USING ERRCODE='42501';
    END IF;
    SELECT * INTO previous FROM push_private.installation_bindings
        WHERE installation_id=p_installation ORDER BY generation DESC LIMIT 1;
    IF FOUND THEN
        IF previous.fenced_at IS NULL AND previous.user_id=p_user AND previous.session_id=p_session THEN
            RETURN previous.generation;
        END IF;
        IF previous.fenced_at IS NULL OR (previous.auth_revocation_confirmed_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM push_private.logout_recoveries r WHERE r.installation_id=p_installation
              AND r.generation=previous.generation AND r.cleared_at IS NOT NULL
              AND r.client_cleanup_acknowledged_at IS NOT NULL)) THEN
            RAISE EXCEPTION 'Previous generation is unavailable' USING ERRCODE='42501';
        END IF;
    END IF;
    INSERT INTO push_private.installation_bindings(installation_id,user_id,session_id)
        VALUES(p_installation,p_user,p_session) RETURNING generation INTO opened;
    RETURN opened;
END $$;
ALTER FUNCTION push_private.open_device_generation(uuid,uuid,uuid,bigint,bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION push_private.open_device_generation(uuid,uuid,uuid,bigint,bytea) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION push_private.open_device_generation(uuid,uuid,uuid,bigint,bytea) TO imahima_device_verifier;
COMMIT;
