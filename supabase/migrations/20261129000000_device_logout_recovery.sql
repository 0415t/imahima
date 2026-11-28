BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL createrole_self_grant = '';

-- PostgreSQL may give the migration owner an administrative membership.
-- No runtime login receives SET or INHERIT access from this migration.
CREATE ROLE imahima_logout_recovery_verifier NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA push_private TO imahima_logout_recovery_verifier;

ALTER TABLE push_private.device_challenges DROP CONSTRAINT device_challenges_purpose_check,
    ADD CONSTRAINT device_challenges_purpose_check
    CHECK (purpose IN ('enroll','register','fence','lookup','confirm_auth_revocation','begin_logout'));
ALTER TABLE push_private.operations DROP CONSTRAINT operations_kind_check,
    ADD CONSTRAINT operations_kind_check
    CHECK (kind IN ('register','fence','confirm_auth_revocation','begin_logout'));

CREATE TABLE push_private.logout_recoveries (
    recovery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id uuid NOT NULL,
    generation bigint NOT NULL,
    key_version bigint NOT NULL CHECK (key_version > 0),
    -- Binding fingerprint detects reassignment without a second copy of user/session IDs.
    binding_digest bytea NOT NULL CHECK (octet_length(binding_digest) = 32),
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    cleared_at timestamptz,
    UNIQUE (installation_id,generation),
    UNIQUE (recovery_id,installation_id,key_version),
    FOREIGN KEY (installation_id,generation)
        REFERENCES push_private.installation_bindings(installation_id,generation) ON DELETE CASCADE,
    CHECK (cleared_at IS NULL OR cleared_at >= issued_at)
);
CREATE UNIQUE INDEX logout_recoveries_one_open
    ON push_private.logout_recoveries(installation_id) WHERE cleared_at IS NULL;

CREATE TABLE push_private.logout_recovery_challenges (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    recovery_id uuid NOT NULL,
    installation_id uuid NOT NULL,
    key_version bigint NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('discover','confirm','ack')),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    FOREIGN KEY (recovery_id,installation_id,key_version)
        REFERENCES push_private.logout_recoveries(recovery_id,installation_id,key_version) ON DELETE CASCADE,
    CHECK (consumed_at IS NULL OR consumed_at < expires_at)
);
CREATE INDEX logout_recovery_challenges_installation ON push_private.logout_recovery_challenges(installation_id);
CREATE INDEX logout_recovery_challenges_recovery ON push_private.logout_recovery_challenges(recovery_id,installation_id,key_version);
ALTER TABLE push_private.logout_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_private.logout_recovery_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON push_private.logout_recoveries, push_private.logout_recovery_challenges
    FROM PUBLIC, anon, authenticated, service_role, imahima_device_verifier, imahima_logout_recovery_verifier;

CREATE FUNCTION push_private.prevent_generation_during_logout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM 1 FROM push_private.installations WHERE installation_id=NEW.installation_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM push_private.logout_recoveries
        WHERE installation_id=NEW.installation_id AND cleared_at IS NULL) THEN
        RAISE EXCEPTION 'Previous logout is pending' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER prevent_generation_during_logout BEFORE INSERT ON push_private.installation_bindings
    FOR EACH ROW EXECUTE FUNCTION push_private.prevent_generation_during_logout();

CREATE FUNCTION push_private.begin_device_logout(
    p_installation uuid,p_user uuid,p_session uuid,p_generation bigint,p_operation uuid,
    p_key_version bigint,p_challenge bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE binding push_private.installation_bindings%ROWTYPE;
DECLARE prior push_private.operations%ROWTYPE;
DECLARE recovery uuid;
DECLARE fingerprint bytea;
DECLARE answer jsonb;
BEGIN
    PERFORM push_private.consume_device_challenge(p_installation,p_key_version,'begin_logout',p_challenge);
    IF NOT push_private.auth_session_present(p_user,p_session) THEN
        RAISE EXCEPTION 'Session is unavailable' USING ERRCODE='42501';
    END IF;
    SELECT * INTO binding FROM push_private.installation_bindings
    WHERE installation_id=p_installation AND generation=p_generation AND user_id=p_user FOR UPDATE;
    IF NOT FOUND OR (binding.fenced_at IS NULL AND binding.session_id<>p_session) THEN
        RAISE EXCEPTION 'Generation is unavailable' USING ERRCODE='42501';
    END IF;
    fingerprint := sha256(convert_to(jsonb_build_array(
        'begin_logout',p_user,p_session,p_generation,binding.session_id,p_key_version)::text,'UTF8'));
    SELECT * INTO prior FROM push_private.operations WHERE installation_id=p_installation AND operation_id=p_operation;
    IF FOUND THEN
        IF prior.kind <> 'begin_logout' OR prior.request_digest <> fingerprint THEN
            RAISE EXCEPTION 'Operation ID reused' USING ERRCODE='22023';
        END IF;
        RETURN prior.result;
    END IF;
    IF EXISTS (SELECT 1 FROM push_private.installation_bindings
        WHERE installation_id=p_installation AND generation>p_generation)
        OR EXISTS (SELECT 1 FROM push_private.logout_recoveries
          WHERE installation_id=p_installation AND generation=p_generation) THEN
        RAISE EXCEPTION 'Generation is unavailable' USING ERRCODE='42501';
    END IF;

    UPDATE push_private.installation_bindings SET fenced_at=COALESCE(fenced_at,clock_timestamp())
    WHERE installation_id=p_installation AND generation=p_generation;
    DELETE FROM public.user_device_tokens WHERE installation_id=p_installation AND generation=p_generation;
    INSERT INTO push_private.logout_recoveries(installation_id,generation,key_version,binding_digest)
    VALUES(p_installation,p_generation,p_key_version,
        sha256(convert_to(jsonb_build_array(binding.user_id,binding.session_id)::text,'UTF8')))
    RETURNING recovery_id INTO recovery;
    answer := jsonb_build_object('recoveryId',recovery);
    INSERT INTO push_private.operations(installation_id,operation_id,generation,kind,request_digest,result)
    VALUES(p_installation,p_operation,p_generation,'begin_logout',fingerprint,answer);
    RETURN answer;
END $$;

-- The dedicated verifier is a trusted server boundary. Only it may invoke
-- these functions, after verifying the device signature with the locked key.
-- A nonce digest is a replay guard, not evidence of signature verification.
CREATE FUNCTION push_private.issue_logout_recovery_challenge(
    p_installation uuid,p_key_version bigint,p_purpose text,p_recovery uuid,p_digest bytea)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target uuid;
DECLARE issued timestamptz;
BEGIN
    PERFORM 1 FROM push_private.installations
    WHERE installation_id=p_installation AND key_version=p_key_version FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501'; END IF;
    IF p_purpose='discover' AND p_recovery IS NULL THEN
        SELECT r.recovery_id INTO target FROM push_private.logout_recoveries AS r
        WHERE r.installation_id=p_installation AND r.key_version=p_key_version
          AND r.generation=(SELECT max(b.generation) FROM push_private.installation_bindings AS b
              WHERE b.installation_id=p_installation);
    ELSIF p_purpose IN ('confirm','ack') AND p_recovery IS NOT NULL THEN
        SELECT r.recovery_id INTO target FROM push_private.logout_recoveries AS r
        WHERE r.installation_id=p_installation AND r.key_version=p_key_version AND r.recovery_id=p_recovery;
    END IF;
    IF target IS NULL THEN RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501'; END IF;
    issued := clock_timestamp();
    DELETE FROM push_private.logout_recovery_challenges WHERE installation_id=p_installation AND expires_at<=issued;
    IF (SELECT count(*) FROM push_private.logout_recovery_challenges WHERE installation_id=p_installation)>=16 THEN
        RAISE EXCEPTION 'Challenge quota exceeded' USING ERRCODE='53000';
    END IF;
    INSERT INTO push_private.logout_recovery_challenges(digest,recovery_id,installation_id,key_version,purpose,expires_at)
    VALUES(p_digest,target,p_installation,p_key_version,p_purpose,issued+interval '60 seconds');
    RETURN issued+interval '60 seconds';
END $$;

CREATE FUNCTION push_private.apply_logout_recovery(
    p_installation uuid,p_key_version bigint,p_purpose text,p_recovery uuid,p_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE checked_at timestamptz;
DECLARE target uuid;
DECLARE selected push_private.logout_recoveries%ROWTYPE;
DECLARE binding push_private.installation_bindings%ROWTYPE;
BEGIN
    PERFORM 1 FROM push_private.installations
    WHERE installation_id=p_installation AND key_version=p_key_version FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501'; END IF;
    checked_at := clock_timestamp();
    UPDATE push_private.logout_recovery_challenges SET consumed_at=checked_at
    WHERE digest=p_digest AND installation_id=p_installation AND key_version=p_key_version
      AND purpose=p_purpose AND consumed_at IS NULL AND expires_at>checked_at
      AND ((p_purpose='discover' AND p_recovery IS NULL)
        OR (p_purpose IN ('confirm','ack') AND recovery_id=p_recovery))
    RETURNING recovery_id INTO target;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501'; END IF;
    SELECT * INTO STRICT selected FROM push_private.logout_recoveries WHERE recovery_id=target;
    SELECT * INTO STRICT binding FROM push_private.installation_bindings
    WHERE installation_id=p_installation AND generation=selected.generation FOR UPDATE;
    IF binding.fenced_at IS NULL OR selected.binding_digest<>
        sha256(convert_to(jsonb_build_array(binding.user_id,binding.session_id)::text,'UTF8'))
        OR (p_purpose='discover' AND EXISTS (SELECT 1 FROM push_private.installation_bindings
            WHERE installation_id=p_installation AND generation>selected.generation)) THEN
        RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501';
    END IF;
    IF selected.cleared_at IS NOT NULL THEN
        RETURN jsonb_build_object('status','cleared','recoveryId',target);
    END IF;
    IF p_purpose='confirm' AND binding.auth_revocation_confirmed_at IS NULL
        AND NOT push_private.auth_session_present(binding.user_id,binding.session_id) THEN
        binding.auth_revocation_confirmed_at := greatest(clock_timestamp(),binding.fenced_at);
        UPDATE push_private.installation_bindings SET auth_revocation_confirmed_at=binding.auth_revocation_confirmed_at
        WHERE installation_id=p_installation AND generation=selected.generation;
    END IF;
    IF p_purpose='ack' THEN
        IF binding.auth_revocation_confirmed_at IS NULL THEN
            RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501';
        END IF;
        UPDATE push_private.logout_recoveries
        SET cleared_at=greatest(clock_timestamp(),issued_at,binding.auth_revocation_confirmed_at)
        WHERE recovery_id=target;
        RETURN jsonb_build_object('status','cleared','recoveryId',target);
    END IF;
    RETURN jsonb_build_object('status',CASE WHEN binding.auth_revocation_confirmed_at IS NULL THEN 'pending' ELSE 'confirmed' END,
        'recoveryId',target);
END $$;

ALTER FUNCTION push_private.prevent_generation_during_logout() OWNER TO postgres;
ALTER FUNCTION push_private.begin_device_logout(uuid,uuid,uuid,bigint,uuid,bigint,bytea) OWNER TO postgres;
ALTER FUNCTION push_private.issue_logout_recovery_challenge(uuid,bigint,text,uuid,bytea) OWNER TO postgres;
ALTER FUNCTION push_private.apply_logout_recovery(uuid,bigint,text,uuid,bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION push_private.prevent_generation_during_logout(),
    push_private.begin_device_logout(uuid,uuid,uuid,bigint,uuid,bigint,bytea),
    push_private.issue_logout_recovery_challenge(uuid,bigint,text,uuid,bytea),
    push_private.apply_logout_recovery(uuid,bigint,text,uuid,bytea)
    FROM PUBLIC, anon, authenticated, service_role, imahima_device_verifier, imahima_logout_recovery_verifier;
GRANT EXECUTE ON FUNCTION push_private.begin_device_logout(uuid,uuid,uuid,bigint,uuid,bigint,bytea)
    TO imahima_device_verifier;
GRANT EXECUTE ON FUNCTION push_private.lock_device_verification_key(uuid),
    push_private.issue_logout_recovery_challenge(uuid,bigint,text,uuid,bytea),
    push_private.apply_logout_recovery(uuid,bigint,text,uuid,bytea)
    TO imahima_logout_recovery_verifier;
COMMIT;
