BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';

-- Match the signed binding within the current generation floor before selecting a case.
CREATE OR REPLACE FUNCTION push_private.issue_scoped_logout_recovery_challenge(
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
        AND (p_purpose='discover' OR (
            (r.generation IS NOT NULL AND p_scope=sha256(convert_to(
                jsonb_build_array(encode(r.binding_digest,'hex'),r.generation)::text,'UTF8')))
            OR (r.scope_operation IS NOT NULL AND p_scope=sha256(convert_to(
                jsonb_build_array(encode(r.binding_digest,'hex'),r.scope_operation)::text,'UTF8')))
        ))
        ORDER BY (r.cleared_at IS NULL) DESC,(r.scope_operation IS NOT NULL) DESC,r.recovery_sequence DESC LIMIT 1;
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

CREATE OR REPLACE FUNCTION push_private.apply_scoped_logout_recovery(
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
        AND (p_purpose='discover' OR (
            (r.generation IS NOT NULL AND p_scope=sha256(convert_to(
                jsonb_build_array(encode(r.binding_digest,'hex'),r.generation)::text,'UTF8')))
            OR (r.scope_operation IS NOT NULL AND p_scope=sha256(convert_to(
                jsonb_build_array(encode(r.binding_digest,'hex'),r.scope_operation)::text,'UTF8')))
        ))
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
COMMIT;
