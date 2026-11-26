BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';

CREATE TABLE push_private.enrollment_challenges (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    session_id uuid NOT NULL,
    installation_id uuid NOT NULL,
    key_digest bytea NOT NULL CHECK (octet_length(key_digest) = 32),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    CHECK (consumed_at IS NULL OR consumed_at < expires_at)
);
CREATE INDEX enrollment_challenges_user ON push_private.enrollment_challenges (user_id);
CREATE INDEX enrollment_challenges_expiry ON push_private.enrollment_challenges (expires_at);
ALTER TABLE push_private.enrollment_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON push_private.enrollment_challenges FROM PUBLIC, anon, authenticated, service_role, imahima_device_verifier;

CREATE FUNCTION push_private.lock_device_verification_key(p_installation uuid)
RETURNS TABLE(public_key bytea, key_version bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT i.public_key, i.key_version FROM push_private.installations AS i
    WHERE i.installation_id = p_installation FOR UPDATE
$$;

CREATE FUNCTION push_private.issue_device_enrollment(
    p_digest bytea, p_user uuid, p_session uuid, p_installation uuid, p_key_digest bytea)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE issued timestamptz;
BEGIN
    -- Serialize the small enrollment quota across Express processes.
    PERFORM pg_advisory_xact_lock(260026, 1);
    issued := clock_timestamp();
    DELETE FROM push_private.enrollment_challenges WHERE expires_at <= issued;
    IF (SELECT count(*) FROM push_private.enrollment_challenges WHERE user_id = p_user) >= 8
        OR (SELECT count(*) FROM push_private.enrollment_challenges) >= 4096 THEN
        RAISE EXCEPTION 'Enrollment quota exceeded' USING ERRCODE = '53000';
    END IF;
    INSERT INTO push_private.enrollment_challenges(digest,user_id,session_id,installation_id,key_digest,expires_at)
    VALUES (p_digest,p_user,p_session,p_installation,p_key_digest,issued + interval '60 seconds');
    RETURN issued + interval '60 seconds';
END $$;

-- Called only by the trusted verifier after it has checked proof of possession.
-- The submitted key, actor, and session must still match the challenge row.
CREATE FUNCTION push_private.finish_device_enrollment(
    p_digest bytea, p_user uuid, p_session uuid, p_installation uuid, p_public_key bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE used_at timestamptz;
BEGIN
    PERFORM 1 FROM push_private.enrollment_challenges
    WHERE digest=p_digest AND user_id=p_user AND session_id=p_session AND installation_id=p_installation
      AND key_digest=sha256(p_public_key) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Enrollment challenge is unavailable' USING ERRCODE='42501'; END IF;
    used_at := clock_timestamp();
    UPDATE push_private.enrollment_challenges SET consumed_at=used_at
    WHERE digest=p_digest AND user_id=p_user AND session_id=p_session AND installation_id=p_installation
      AND key_digest=sha256(p_public_key) AND consumed_at IS NULL AND expires_at>used_at;
    IF NOT FOUND THEN RAISE EXCEPTION 'Enrollment challenge is unavailable' USING ERRCODE='42501'; END IF;
    PERFORM push_private.enroll_device_installation(p_installation,p_public_key);
    -- An idempotent enrollment may have found an existing installation.
    -- Recheck it with a lock before committing the challenge consumption.
    PERFORM 1 FROM push_private.installations
    WHERE installation_id=p_installation AND key_version=1 AND public_key=p_public_key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Installation is unavailable' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION push_private.issue_bounded_device_challenge(
    p_installation uuid, p_key_version bigint, p_purpose text, p_digest bytea)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM 1 FROM push_private.installations
    WHERE installation_id=p_installation AND key_version=p_key_version FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Installation is unavailable' USING ERRCODE='42501'; END IF;
    DELETE FROM push_private.device_challenges WHERE installation_id=p_installation AND expires_at<=clock_timestamp();
    IF (SELECT count(*) FROM push_private.device_challenges WHERE installation_id=p_installation) >= 16 THEN
        RAISE EXCEPTION 'Challenge quota exceeded' USING ERRCODE='53000';
    END IF;
    RETURN push_private.issue_device_challenge(p_installation,p_key_version,p_purpose,p_digest);
END $$;

ALTER FUNCTION push_private.lock_device_verification_key(uuid) OWNER TO postgres;
ALTER FUNCTION push_private.issue_device_enrollment(bytea,uuid,uuid,uuid,bytea) OWNER TO postgres;
ALTER FUNCTION push_private.finish_device_enrollment(bytea,uuid,uuid,uuid,bytea) OWNER TO postgres;
ALTER FUNCTION push_private.issue_bounded_device_challenge(uuid,bigint,text,bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION push_private.lock_device_verification_key(uuid),
    push_private.issue_device_enrollment(bytea,uuid,uuid,uuid,bytea),
    push_private.finish_device_enrollment(bytea,uuid,uuid,uuid,bytea),
    push_private.issue_bounded_device_challenge(uuid,bigint,text,bytea)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION push_private.lock_device_verification_key(uuid),
    push_private.issue_device_enrollment(bytea,uuid,uuid,uuid,bytea),
    push_private.finish_device_enrollment(bytea,uuid,uuid,uuid,bytea),
    push_private.issue_bounded_device_challenge(uuid,bigint,text,bytea)
TO imahima_device_verifier;
REVOKE EXECUTE ON FUNCTION push_private.enroll_device_installation(uuid,bytea),
    push_private.issue_device_challenge(uuid,bigint,text,bytea) FROM imahima_device_verifier;
COMMIT;
