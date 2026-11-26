BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION push_private.auth_session_present(p_user uuid, p_session uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE owner_id uuid;
BEGIN
    IF p_user IS NULL OR p_session IS NULL OR pg_is_in_recovery() THEN
        RAISE EXCEPTION 'Session cannot be verified' USING ERRCODE = '55000';
    END IF;
    SELECT s.user_id INTO owner_id FROM auth.sessions AS s WHERE s.id = p_session;
    IF NOT FOUND THEN RETURN false; END IF;
    IF owner_id IS DISTINCT FROM p_user THEN
        RAISE EXCEPTION 'Session ownership mismatch' USING ERRCODE = '55000';
    END IF;
    RETURN true;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'Session cannot be verified' USING ERRCODE = '55000';
END $$;

CREATE FUNCTION push_private.confirm_auth_revocation(
    p_installation uuid, p_user uuid, p_generation bigint, p_operation uuid,
    p_key_version bigint, p_challenge bytea)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE binding push_private.installation_bindings%ROWTYPE;
DECLARE prior push_private.operations%ROWTYPE;
DECLARE fingerprint bytea;
DECLARE answer jsonb;
BEGIN
    -- This also locks the installation, ahead of the binding and operation.
    PERFORM push_private.consume_device_challenge(p_installation,p_key_version,'confirm_auth_revocation',p_challenge);
    SELECT * INTO binding FROM push_private.installation_bindings
    WHERE installation_id=p_installation AND generation=p_generation AND user_id=p_user
      AND fenced_at IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Generation is unavailable' USING ERRCODE = '42501'; END IF;
    fingerprint := sha256(convert_to(jsonb_build_array('confirm_auth_revocation',p_user,p_generation,binding.session_id)::text,'UTF8'));
    SELECT * INTO prior FROM push_private.operations WHERE installation_id=p_installation AND operation_id=p_operation;
    IF FOUND THEN
        IF prior.kind <> 'confirm_auth_revocation' OR prior.request_digest <> fingerprint THEN
            RAISE EXCEPTION 'Operation ID reused' USING ERRCODE = '22023';
        END IF;
        RETURN prior.result;
    END IF;
    IF binding.auth_revocation_confirmed_at IS NULL THEN
        IF push_private.auth_session_present(p_user,binding.session_id) THEN
            RETURN jsonb_build_object('status','pending','generation',p_generation::text);
        END IF;
        UPDATE push_private.installation_bindings
        SET auth_revocation_confirmed_at=greatest(clock_timestamp(),binding.fenced_at)
        WHERE installation_id=p_installation AND generation=p_generation;
    END IF;
    answer := jsonb_build_object('status','confirmed','generation',p_generation::text);
    INSERT INTO push_private.operations(installation_id,operation_id,generation,kind,request_digest,result)
    VALUES(p_installation,p_operation,p_generation,'confirm_auth_revocation',fingerprint,answer);
    RETURN answer;
END $$;

ALTER FUNCTION push_private.auth_session_present(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION push_private.confirm_auth_revocation(uuid,uuid,bigint,uuid,bigint,bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION push_private.auth_session_present(uuid,uuid),
    push_private.confirm_auth_revocation(uuid,uuid,bigint,uuid,bigint,bytea)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION push_private.auth_session_present(uuid,uuid),
    push_private.confirm_auth_revocation(uuid,uuid,bigint,uuid,bigint,bytea)
    TO imahima_device_verifier;
COMMIT;
