BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION push_private.register_device_v2(
    p_installation uuid,p_user uuid,p_session uuid,p_generation bigint,p_operation uuid,p_key_version bigint,
    p_challenge bytea,p_token text,p_platform text,p_device_name text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET row_security = off AS $$
DECLARE binding push_private.installation_bindings%ROWTYPE;
DECLARE prior push_private.operations%ROWTYPE;
DECLARE fingerprint bytea;
DECLARE answer jsonb;
DECLARE revision bigint;
DECLARE requested_digest bytea;
BEGIN
    -- Retain the installation lock through the outcome write, including when
    -- the nested token mutation below must be rolled back.
    PERFORM push_private.consume_device_challenge(p_installation,p_key_version,'register',p_challenge);
    SELECT * INTO binding FROM push_private.installation_bindings
        WHERE installation_id=p_installation AND generation=p_generation AND user_id=p_user;
    IF NOT FOUND OR p_session IS NULL OR binding.session_id<>p_session THEN
        RAISE EXCEPTION 'Generation is unavailable' USING ERRCODE='42501';
    END IF;
    fingerprint := sha256(convert_to(jsonb_build_array('register',p_user,p_session,p_generation,
        p_token,p_platform,p_device_name)::text,'UTF8'));
    SELECT * INTO prior FROM push_private.operations
        WHERE installation_id=p_installation AND operation_id=p_operation;
    IF FOUND THEN
        IF prior.kind<>'register' OR prior.request_digest<>fingerprint THEN
            RAISE EXCEPTION 'Operation ID reused' USING ERRCODE='22023';
        END IF;
        RETURN prior.result;
    END IF;
    IF binding.fenced_at IS NOT NULL THEN
        RAISE EXCEPTION 'Generation is fenced' USING ERRCODE='42501';
    END IF;
    IF p_token IS NULL OR length(p_token) NOT BETWEEN 1 AND 512 OR p_platform IS NULL OR p_platform NOT IN ('android','ios') THEN
        RAISE EXCEPTION 'Invalid device token inputs' USING ERRCODE='22023';
    END IF;
    -- A new outcome holds installation, Auth session, then token locks.
    -- Exact replays above only return their recorded result.
    IF NOT push_private.lock_live_device_auth(p_user,p_session) THEN
        RAISE EXCEPTION 'Session is unavailable' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_token,250025));
    requested_digest := sha256(convert_to(p_token,'UTF8'));
    BEGIN
        INSERT INTO push_private.managed_token_reservations(token_digest,installation_id)
            VALUES(requested_digest,p_installation) ON CONFLICT DO NOTHING;
        IF NOT EXISTS (SELECT 1 FROM push_private.managed_token_reservations r
            WHERE r.token_digest=requested_digest AND r.installation_id=p_installation) THEN
            RAISE EXCEPTION 'Device token is unavailable' USING ERRCODE='P3201';
        END IF;
        INSERT INTO public.user_device_tokens AS current_token
            (user_id,expo_push_token,platform,device_name,installation_id,generation,registration_revision)
        VALUES(p_user,p_token,p_platform,p_device_name,p_installation,p_generation,1)
        ON CONFLICT (expo_push_token) DO UPDATE SET platform=excluded.platform,device_name=excluded.device_name,
            updated_at=statement_timestamp(),registration_revision=current_token.registration_revision+1
        WHERE current_token.installation_id=p_installation AND current_token.generation=p_generation AND current_token.user_id=p_user
        RETURNING registration_revision INTO revision;
        IF NOT FOUND THEN RAISE EXCEPTION 'Device token is unavailable' USING ERRCODE='P3201'; END IF;
        answer := jsonb_build_object('registered',true,'generation',p_generation::text,'revision',revision::text);
    EXCEPTION WHEN SQLSTATE 'P3201' THEN
        answer := jsonb_build_object('registered',false,'generation',p_generation::text,'reason','device_token_unavailable');
    END;
    INSERT INTO push_private.operations(installation_id,operation_id,generation,kind,request_digest,result)
        VALUES(p_installation,p_operation,p_generation,'register',fingerprint,answer);
    RETURN answer;
END $$;
COMMIT;
