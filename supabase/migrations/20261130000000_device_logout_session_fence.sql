BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';

ALTER TABLE push_private.installations
    ADD COLUMN recovery_generation_floor bigint NOT NULL DEFAULT 0 CHECK (recovery_generation_floor >= 0);
UPDATE push_private.installations i SET recovery_generation_floor=b.generation
FROM (SELECT installation_id,max(generation) AS generation FROM push_private.installation_bindings
    GROUP BY installation_id) b WHERE i.installation_id=b.installation_id;

ALTER TABLE push_private.logout_recoveries
    ALTER COLUMN generation DROP NOT NULL,
    ADD COLUMN scope_user uuid,
    ADD COLUMN scope_session uuid,
    ADD COLUMN scope_operation uuid,
    ADD COLUMN scope_generation_floor bigint,
    ADD COLUMN recovery_sequence bigint GENERATED ALWAYS AS IDENTITY,
    ADD COLUMN scopeless_auth_confirmed_at timestamptz,
    ADD CONSTRAINT logout_recovery_scope_check CHECK (
        (scope_operation IS NULL AND generation IS NOT NULL AND scope_user IS NULL AND scope_session IS NULL
            AND scope_generation_floor IS NULL AND scopeless_auth_confirmed_at IS NULL)
        OR (scope_operation IS NOT NULL AND scope_user IS NOT NULL AND scope_session IS NOT NULL
            AND scope_generation_floor IS NOT NULL AND scope_generation_floor >= 0
            AND (generation IS NULL OR scopeless_auth_confirmed_at IS NULL)
            AND (generation IS NOT NULL OR cleared_at IS NULL OR
                (scopeless_auth_confirmed_at IS NOT NULL AND cleared_at >= scopeless_auth_confirmed_at)))
    ),
    ADD UNIQUE (installation_id,scope_session),
    ADD UNIQUE (installation_id,scope_operation),
    ADD FOREIGN KEY (installation_id) REFERENCES push_private.installations(installation_id) ON DELETE CASCADE;
REVOKE ALL ON SEQUENCE push_private.logout_recoveries_recovery_sequence_seq
    FROM PUBLIC, anon, authenticated, service_role, imahima_device_verifier, imahima_logout_recovery_verifier;

ALTER TABLE push_private.device_challenges DROP CONSTRAINT device_challenges_purpose_check,
    ADD CONSTRAINT device_challenges_purpose_check CHECK (purpose IN
        ('enroll','register','fence','lookup','confirm_auth_revocation','begin_logout','lookup_generation','begin_session_logout'));

CREATE OR REPLACE FUNCTION push_private.prevent_generation_during_logout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
BEGIN
    PERFORM 1 FROM push_private.installations WHERE installation_id=NEW.installation_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM push_private.logout_recoveries
        WHERE installation_id=NEW.installation_id AND cleared_at IS NULL) THEN
        RAISE EXCEPTION 'Previous logout is pending' USING ERRCODE='42501';
    END IF;
    UPDATE push_private.installations SET recovery_generation_floor=greatest(recovery_generation_floor,NEW.generation)
        WHERE installation_id=NEW.installation_id;
    RETURN NEW;
END $$;

-- The session-scoped recovery row is also the durable fence. It remains after ack.
CREATE OR REPLACE FUNCTION push_private.open_device_generation(
    p_installation uuid,p_user uuid,p_session uuid,p_key_version bigint,p_challenge bytea)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE previous push_private.installation_bindings%ROWTYPE;
DECLARE opened bigint;
BEGIN
    PERFORM push_private.consume_device_challenge(p_installation,p_key_version,'enroll',p_challenge);
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
        IF previous.auth_revocation_confirmed_at IS NULL THEN
            RAISE EXCEPTION 'Previous generation is unavailable' USING ERRCODE='42501';
        END IF;
    END IF;
    INSERT INTO push_private.installation_bindings(installation_id,user_id,session_id)
        VALUES(p_installation,p_user,p_session) RETURNING generation INTO opened;
    RETURN opened;
END $$;

CREATE FUNCTION push_private.lookup_device_generation(
    p_installation uuid,p_user uuid,p_session uuid,p_key_version bigint,p_challenge bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE found_generation bigint;
BEGIN
    PERFORM push_private.consume_device_challenge(p_installation,p_key_version,'lookup_generation',p_challenge);
    SELECT generation INTO found_generation FROM push_private.installation_bindings
        WHERE installation_id=p_installation AND user_id=p_user AND session_id=p_session AND fenced_at IS NULL;
    RETURN found_generation::text;
END $$;

CREATE FUNCTION push_private.begin_device_session_logout(
    p_installation uuid,p_user uuid,p_session uuid,p_operation uuid,p_key_version bigint,p_challenge bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE prior push_private.logout_recoveries%ROWTYPE;
DECLARE binding push_private.installation_bindings%ROWTYPE;
DECLARE target_generation bigint;
DECLARE recovery uuid;
BEGIN
    PERFORM push_private.consume_device_challenge(p_installation,p_key_version,'begin_session_logout',p_challenge);
    IF NOT push_private.auth_session_present(p_user,p_session) THEN
        RAISE EXCEPTION 'Session is unavailable' USING ERRCODE='42501';
    END IF;
    SELECT * INTO prior FROM push_private.logout_recoveries
        WHERE installation_id=p_installation AND (scope_operation=p_operation OR scope_session=p_session)
        ORDER BY (scope_operation=p_operation) DESC NULLS LAST LIMIT 1;
    IF FOUND THEN
        IF prior.scope_operation<>p_operation OR prior.scope_user<>p_user
            OR prior.scope_session<>p_session OR prior.key_version<>p_key_version THEN
            RAISE EXCEPTION 'Operation scope changed' USING ERRCODE='42501';
        END IF;
        RETURN jsonb_build_object('recoveryId',prior.recovery_id,'generation',prior.generation::text);
    END IF;
    IF EXISTS (SELECT 1 FROM push_private.operations
        WHERE installation_id=p_installation AND operation_id=p_operation)
        OR EXISTS (SELECT 1 FROM push_private.logout_recoveries
            WHERE installation_id=p_installation AND cleared_at IS NULL) THEN
        RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501';
    END IF;
    SELECT * INTO binding FROM push_private.installation_bindings
        WHERE installation_id=p_installation ORDER BY generation DESC LIMIT 1 FOR UPDATE;
    IF FOUND AND binding.fenced_at IS NULL THEN
        IF binding.user_id<>p_user OR binding.session_id<>p_session THEN
            RAISE EXCEPTION 'Generation is unavailable' USING ERRCODE='42501';
        END IF;
        target_generation := binding.generation;
        UPDATE push_private.installation_bindings SET fenced_at=clock_timestamp()
            WHERE installation_id=p_installation AND generation=target_generation;
        DELETE FROM public.user_device_tokens
            WHERE installation_id=p_installation AND generation=target_generation;
    ELSIF FOUND AND binding.auth_revocation_confirmed_at IS NULL THEN
        RAISE EXCEPTION 'Previous generation is unavailable' USING ERRCODE='42501';
    END IF;
    INSERT INTO push_private.logout_recoveries(installation_id,generation,key_version,binding_digest,
        scope_user,scope_session,scope_operation,scope_generation_floor)
    VALUES(p_installation,target_generation,p_key_version,
        sha256(convert_to(jsonb_build_array(p_user,p_session)::text,'UTF8')),
        p_user,p_session,p_operation,(SELECT recovery_generation_floor FROM push_private.installations
            WHERE installation_id=p_installation))
    RETURNING recovery_id INTO recovery;
    RETURN jsonb_build_object('recoveryId',recovery,'generation',target_generation::text);
END $$;

ALTER TABLE push_private.logout_recovery_challenges DROP CONSTRAINT logout_recovery_challenges_purpose_check,
    ADD COLUMN scope_digest bytea,
    ADD CHECK ((purpose='discover_binding' AND scope_digest IS NOT NULL AND octet_length(scope_digest)=32)
        OR (purpose IN ('discover','confirm','ack') AND scope_digest IS NULL));

CREATE FUNCTION push_private.issue_scoped_logout_recovery_challenge(
    p_installation uuid,p_key_version bigint,p_purpose text,p_recovery uuid,p_digest bytea,p_scope bytea)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE target uuid;
DECLARE issued timestamptz;
BEGIN
    PERFORM 1 FROM push_private.installations
    WHERE installation_id=p_installation AND key_version=p_key_version FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501'; END IF;
    IF p_purpose IN ('discover','discover_binding') AND p_recovery IS NULL THEN
        SELECT r.recovery_id INTO target FROM push_private.logout_recoveries AS r
        WHERE r.installation_id=p_installation AND r.key_version=p_key_version
          AND COALESCE(r.scope_generation_floor,r.generation)=(SELECT i.recovery_generation_floor
              FROM push_private.installations i WHERE i.installation_id=p_installation)
        ORDER BY (r.cleared_at IS NULL) DESC,(r.scope_operation IS NOT NULL) DESC,r.recovery_sequence DESC LIMIT 1;
        IF p_purpose='discover_binding' AND NOT EXISTS (
            SELECT 1 FROM push_private.logout_recoveries r WHERE r.recovery_id=target
            AND (p_scope=sha256(convert_to(jsonb_build_array(encode(r.binding_digest,'hex'),r.generation)::text,'UTF8'))
                OR (r.scope_operation IS NOT NULL AND p_scope=sha256(convert_to(
                    jsonb_build_array(encode(r.binding_digest,'hex'),r.scope_operation)::text,'UTF8'))))
        ) THEN target := NULL; END IF;
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
    INSERT INTO push_private.logout_recovery_challenges(digest,recovery_id,installation_id,key_version,purpose,expires_at,scope_digest)
    VALUES(p_digest,target,p_installation,p_key_version,p_purpose,issued+interval '60 seconds',p_scope);
    RETURN issued+interval '60 seconds';
END $$;

CREATE FUNCTION push_private.apply_scoped_logout_recovery(
    p_installation uuid,p_key_version bigint,p_purpose text,p_recovery uuid,p_digest bytea,p_scope bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE checked_at timestamptz;
DECLARE target uuid;
DECLARE selected push_private.logout_recoveries%ROWTYPE;
DECLARE binding push_private.installation_bindings%ROWTYPE;
DECLARE confirmed timestamptz;
BEGIN
    PERFORM 1 FROM push_private.installations
    WHERE installation_id=p_installation AND key_version=p_key_version FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501'; END IF;
    checked_at := clock_timestamp();
    UPDATE push_private.logout_recovery_challenges SET consumed_at=checked_at
    WHERE digest=p_digest AND installation_id=p_installation AND key_version=p_key_version
      AND purpose=p_purpose AND scope_digest IS NOT DISTINCT FROM p_scope AND consumed_at IS NULL AND expires_at>checked_at
      AND ((p_purpose IN ('discover','discover_binding') AND p_recovery IS NULL)
        OR (p_purpose IN ('confirm','ack') AND recovery_id=p_recovery))
    RETURNING recovery_id INTO target;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501'; END IF;
    SELECT * INTO STRICT selected FROM push_private.logout_recoveries WHERE recovery_id=target;
    IF p_purpose IN ('discover','discover_binding') AND target IS DISTINCT FROM (
        SELECT r.recovery_id FROM push_private.logout_recoveries r
        WHERE r.installation_id=p_installation AND r.key_version=p_key_version
            AND COALESCE(r.scope_generation_floor,r.generation)=(SELECT i.recovery_generation_floor
                FROM push_private.installations i WHERE i.installation_id=p_installation)
        ORDER BY (r.cleared_at IS NULL) DESC,(r.scope_operation IS NOT NULL) DESC,r.recovery_sequence DESC LIMIT 1
    ) THEN RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501'; END IF;
    IF selected.generation IS NOT NULL THEN
        SELECT * INTO STRICT binding FROM push_private.installation_bindings
        WHERE installation_id=p_installation AND generation=selected.generation FOR UPDATE;
        IF binding.fenced_at IS NULL OR selected.binding_digest<>
            sha256(convert_to(jsonb_build_array(binding.user_id,binding.session_id)::text,'UTF8')) THEN
            RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501';
        END IF;
        confirmed := binding.auth_revocation_confirmed_at;
    ELSE
        confirmed := selected.scopeless_auth_confirmed_at;
    END IF;
    IF selected.cleared_at IS NOT NULL THEN
        RETURN jsonb_build_object('status','cleared','recoveryId',target);
    END IF;
    IF p_purpose='confirm' AND confirmed IS NULL
        AND NOT push_private.auth_session_present(COALESCE(binding.user_id,selected.scope_user),
            COALESCE(binding.session_id,selected.scope_session)) THEN
        confirmed := greatest(clock_timestamp(),selected.issued_at,binding.fenced_at);
        IF selected.generation IS NULL THEN
            UPDATE push_private.logout_recoveries SET scopeless_auth_confirmed_at=confirmed WHERE recovery_id=target;
        ELSE
            UPDATE push_private.installation_bindings SET auth_revocation_confirmed_at=confirmed
                WHERE installation_id=p_installation AND generation=selected.generation;
        END IF;
    END IF;
    IF p_purpose='ack' THEN
        IF confirmed IS NULL THEN
            RAISE EXCEPTION 'Recovery is unavailable' USING ERRCODE='42501';
        END IF;
        UPDATE push_private.logout_recoveries
        SET cleared_at=greatest(clock_timestamp(),issued_at,confirmed)
        WHERE recovery_id=target;
        RETURN jsonb_build_object('status','cleared','recoveryId',target);
    END IF;
    RETURN jsonb_build_object('status',CASE WHEN confirmed IS NULL THEN 'pending' ELSE 'confirmed' END,
        'recoveryId',target);
END $$;

ALTER FUNCTION push_private.lookup_device_generation(uuid,uuid,uuid,bigint,bytea) OWNER TO postgres;
ALTER FUNCTION push_private.begin_device_session_logout(uuid,uuid,uuid,uuid,bigint,bytea) OWNER TO postgres;
ALTER FUNCTION push_private.issue_scoped_logout_recovery_challenge(uuid,bigint,text,uuid,bytea,bytea) OWNER TO postgres;
ALTER FUNCTION push_private.apply_scoped_logout_recovery(uuid,bigint,text,uuid,bytea,bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION push_private.lookup_device_generation(uuid,uuid,uuid,bigint,bytea),
    push_private.begin_device_session_logout(uuid,uuid,uuid,uuid,bigint,bytea),
    push_private.issue_scoped_logout_recovery_challenge(uuid,bigint,text,uuid,bytea,bytea),
    push_private.apply_scoped_logout_recovery(uuid,bigint,text,uuid,bytea,bytea)
    FROM PUBLIC, anon, authenticated, service_role, imahima_device_verifier, imahima_logout_recovery_verifier;
GRANT EXECUTE ON FUNCTION push_private.lookup_device_generation(uuid,uuid,uuid,bigint,bytea),
    push_private.begin_device_session_logout(uuid,uuid,uuid,uuid,bigint,bytea) TO imahima_device_verifier;
GRANT EXECUTE ON FUNCTION push_private.issue_scoped_logout_recovery_challenge(uuid,bigint,text,uuid,bytea,bytea),
    push_private.apply_scoped_logout_recovery(uuid,bigint,text,uuid,bytea,bytea) TO imahima_logout_recovery_verifier;
COMMIT;
