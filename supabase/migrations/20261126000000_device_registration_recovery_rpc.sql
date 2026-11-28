BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';

-- This role is deliberately not granted to authenticator, service_role or
-- any app role. Provision a separate verifier login only after implementing
-- JWT and signature verification. Its actor/session/key inputs are trusted facts.
CREATE ROLE imahima_device_verifier NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA push_private TO imahima_device_verifier;

-- Keep the legacy route closed even after a managed token row is deleted.
-- Retain the installation assignment when the token row or user disappears.
CREATE TABLE push_private.managed_token_reservations (
    token_digest bytea PRIMARY KEY CHECK (octet_length(token_digest) = 32),
    installation_id uuid NOT NULL REFERENCES push_private.installations(installation_id)
);
CREATE INDEX managed_token_reservations_installation
    ON push_private.managed_token_reservations (installation_id);
ALTER TABLE push_private.managed_token_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON push_private.managed_token_reservations FROM PUBLIC, anon, authenticated, service_role, imahima_device_verifier;

CREATE OR REPLACE FUNCTION public.upsert_device_token(
    p_token text, p_platform text, p_device_name text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_token, 250025));
    IF EXISTS (SELECT 1 FROM push_private.managed_token_reservations
        WHERE token_digest = sha256(convert_to(p_token,'UTF8'))) THEN
        RAISE EXCEPTION 'Device token is unavailable' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.user_device_tokens AS current_token (user_id, expo_push_token, platform, device_name)
    VALUES (auth.uid(), p_token, p_platform, p_device_name)
    ON CONFLICT (expo_push_token) DO UPDATE SET user_id = excluded.user_id,
        platform = excluded.platform, device_name = excluded.device_name, updated_at = now()
    WHERE current_token.installation_id IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Device token is unavailable' USING ERRCODE = '42501'; END IF;
END $$;
ALTER FUNCTION public.upsert_device_token(text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.upsert_device_token(text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_device_token(text,text,text) TO authenticated;

ALTER POLICY "own tokens delete" ON public.user_device_tokens
    USING ((SELECT auth.uid()) = user_id AND installation_id IS NULL);
REVOKE INSERT, UPDATE, TRUNCATE, TRIGGER ON public.user_device_tokens FROM PUBLIC, anon, authenticated, service_role;

-- The existing service-role worker bypasses RLS and deletes by token string.
-- Skip managed rows for that path. Trusted owner writes and Auth FK cascades
-- are covered by tests; the trigger must run as the invoking role.
CREATE FUNCTION push_private.protect_managed_token() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'INSERT' AND OLD.installation_id IS NOT NULL AND current_user <> 'postgres' THEN
        IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Managed device token' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW.installation_id IS NOT NULL AND current_user <> 'postgres' THEN
        RAISE EXCEPTION 'Managed device token' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER protect_managed_token BEFORE INSERT OR UPDATE OR DELETE ON public.user_device_tokens
    FOR EACH ROW EXECUTE FUNCTION push_private.protect_managed_token();

-- Only the verifier can enroll. It must prove possession of the submitted
-- key with its own one-time enrollment challenge before calling this RPC.
CREATE FUNCTION push_private.enroll_device_installation(p_installation uuid, p_public_key bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    INSERT INTO push_private.installations(installation_id, public_key) VALUES (p_installation, p_public_key)
        ON CONFLICT (installation_id) DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM push_private.installations
        WHERE installation_id = p_installation AND public_key = p_public_key AND key_version = 1) THEN
        RAISE EXCEPTION 'Installation is unavailable' USING ERRCODE = '42501';
    END IF;
END $$;

CREATE FUNCTION push_private.issue_device_challenge(p_installation uuid, p_key_version bigint, p_purpose text, p_digest bytea)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE expires timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    PERFORM 1 FROM push_private.installations WHERE installation_id = p_installation AND key_version = p_key_version FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Installation is unavailable' USING ERRCODE = '42501'; END IF;
    INSERT INTO push_private.device_challenges(challenge_digest, installation_id, key_version, purpose, expires_at)
    VALUES (p_digest, p_installation, p_key_version, p_purpose, expires);
    RETURN expires;
END $$;

-- Internal helper. The verified request binds the purpose, installation,
-- actor, Auth session, generation, operation ID and request contents.
CREATE FUNCTION push_private.consume_device_challenge(p_installation uuid, p_key_version bigint, p_purpose text, p_digest bytea)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE checked_at timestamptz;
BEGIN
    PERFORM 1 FROM push_private.installations WHERE installation_id = p_installation AND key_version = p_key_version FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Installation is unavailable' USING ERRCODE = '42501'; END IF;
    checked_at := clock_timestamp();
    UPDATE push_private.device_challenges SET consumed_at = checked_at
    WHERE challenge_digest = p_digest AND installation_id = p_installation AND key_version = p_key_version
      AND purpose = p_purpose AND consumed_at IS NULL AND expires_at > checked_at;
    IF NOT FOUND THEN RAISE EXCEPTION 'Challenge is unavailable' USING ERRCODE = '42501'; END IF;
END $$;

CREATE FUNCTION push_private.open_device_generation(p_installation uuid, p_user uuid, p_session uuid, p_key_version bigint, p_challenge bytea)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE previous push_private.installation_bindings%ROWTYPE;
DECLARE opened bigint;
BEGIN
    PERFORM push_private.consume_device_challenge(p_installation,p_key_version,'enroll',p_challenge);
    SELECT * INTO previous FROM push_private.installation_bindings
      WHERE installation_id = p_installation ORDER BY generation DESC LIMIT 1;
    IF FOUND THEN
        IF previous.fenced_at IS NULL AND previous.user_id = p_user AND previous.session_id = p_session THEN
            RETURN previous.generation;
        END IF;
        IF previous.auth_revocation_confirmed_at IS NULL THEN
            RAISE EXCEPTION 'Previous generation is unavailable' USING ERRCODE = '42501';
        END IF;
    END IF;
    INSERT INTO push_private.installation_bindings(installation_id,user_id,session_id)
    VALUES (p_installation,p_user,p_session) RETURNING generation INTO opened;
    RETURN opened;
END $$;

CREATE FUNCTION push_private.device_write(
    p_kind text, p_installation uuid, p_user uuid, p_session uuid, p_generation bigint,
    p_operation uuid, p_key_version bigint, p_challenge bytea, p_token text, p_platform text, p_device_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE binding push_private.installation_bindings%ROWTYPE;
DECLARE prior push_private.operations%ROWTYPE;
DECLARE fingerprint bytea;
DECLARE answer jsonb;
DECLARE revision bigint;
DECLARE requested_token_digest bytea;
BEGIN
    PERFORM push_private.consume_device_challenge(p_installation,p_key_version,p_kind,p_challenge);
    SELECT * INTO binding FROM push_private.installation_bindings
      WHERE installation_id=p_installation AND generation=p_generation AND user_id=p_user;
    IF NOT FOUND OR p_session IS NULL OR (p_kind='register' AND binding.session_id<>p_session) THEN
        RAISE EXCEPTION 'Generation is unavailable' USING ERRCODE = '42501';
    END IF;
    fingerprint := sha256(convert_to(jsonb_build_array(p_kind,p_user,p_session,p_generation,
        p_token,p_platform,p_device_name)::text,'UTF8'));
    SELECT * INTO prior FROM push_private.operations WHERE installation_id=p_installation AND operation_id=p_operation;
    IF FOUND THEN
        IF prior.request_digest <> fingerprint THEN RAISE EXCEPTION 'Operation ID reused' USING ERRCODE = '22023'; END IF;
        RETURN prior.result;
    END IF;
    IF p_kind='register' THEN
        IF binding.fenced_at IS NOT NULL THEN RAISE EXCEPTION 'Generation is fenced' USING ERRCODE = '42501'; END IF;
        IF p_token IS NULL OR length(p_token) NOT BETWEEN 1 AND 512 OR p_platform IS NULL OR p_platform NOT IN ('android','ios') THEN
            RAISE EXCEPTION 'Invalid device token inputs' USING ERRCODE = '22023';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(p_token, 250025));
        requested_token_digest := sha256(convert_to(p_token,'UTF8'));
        INSERT INTO push_private.managed_token_reservations(token_digest,installation_id)
        VALUES (requested_token_digest,p_installation) ON CONFLICT DO NOTHING;
        IF NOT EXISTS (SELECT 1 FROM push_private.managed_token_reservations AS reserved
            WHERE reserved.token_digest=requested_token_digest AND reserved.installation_id=p_installation) THEN
            RAISE EXCEPTION 'Device token is unavailable' USING ERRCODE = '42501';
        END IF;
        INSERT INTO public.user_device_tokens AS current_token
            (user_id,expo_push_token,platform,device_name,installation_id,generation,registration_revision)
        VALUES (p_user,p_token,p_platform,p_device_name,p_installation,p_generation,1)
        ON CONFLICT (expo_push_token) DO UPDATE SET platform=excluded.platform,device_name=excluded.device_name,
            updated_at=statement_timestamp(), registration_revision=current_token.registration_revision+1
        WHERE current_token.installation_id=p_installation AND current_token.generation=p_generation AND current_token.user_id=p_user
        RETURNING registration_revision INTO revision;
        IF NOT FOUND THEN RAISE EXCEPTION 'Device token is unavailable' USING ERRCODE = '42501'; END IF;
        answer := jsonb_build_object('registered',true,'generation',p_generation::text,'revision',revision::text);
    ELSE
        UPDATE push_private.installation_bindings SET fenced_at=COALESCE(fenced_at,clock_timestamp())
        WHERE installation_id=p_installation AND generation=p_generation;
        DELETE FROM public.user_device_tokens WHERE installation_id=p_installation AND generation=p_generation;
        answer := jsonb_build_object('fenced',true,'generation',p_generation::text);
    END IF;
    INSERT INTO push_private.operations(installation_id,operation_id,generation,kind,request_digest,result)
    VALUES (p_installation,p_operation,p_generation,p_kind,fingerprint,answer);
    RETURN answer;
END $$;

CREATE FUNCTION push_private.register_device_v2(
    p_installation uuid,p_user uuid,p_session uuid,p_generation bigint,p_operation uuid,p_key_version bigint,
    p_challenge bytea,p_token text,p_platform text,p_device_name text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT push_private.device_write('register',p_installation,p_user,p_session,p_generation,p_operation,
        p_key_version,p_challenge,p_token,p_platform,p_device_name)
$$;

CREATE FUNCTION push_private.fence_device_registration(
    p_installation uuid,p_user uuid,p_session uuid,p_generation bigint,p_operation uuid,p_key_version bigint,p_challenge bytea)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT push_private.device_write('fence',p_installation,p_user,p_session,p_generation,p_operation,
        p_key_version,p_challenge,NULL,NULL,NULL)
$$;

CREATE FUNCTION push_private.get_device_operation(
    p_installation uuid,p_user uuid,p_generation bigint,p_operation uuid,p_key_version bigint,p_challenge bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE answer jsonb;
BEGIN
    PERFORM push_private.consume_device_challenge(p_installation,p_key_version,'lookup',p_challenge);
    IF NOT EXISTS (SELECT 1 FROM push_private.installation_bindings
        WHERE installation_id=p_installation AND generation=p_generation AND user_id=p_user) THEN
        RAISE EXCEPTION 'Generation is unavailable' USING ERRCODE = '42501';
    END IF;
    SELECT result INTO answer FROM push_private.operations
    WHERE installation_id=p_installation AND generation=p_generation AND operation_id=p_operation;
    RETURN answer;
END $$;

ALTER FUNCTION push_private.protect_managed_token() OWNER TO postgres;
ALTER FUNCTION push_private.enroll_device_installation(uuid,bytea) OWNER TO postgres;
ALTER FUNCTION push_private.issue_device_challenge(uuid,bigint,text,bytea) OWNER TO postgres;
ALTER FUNCTION push_private.consume_device_challenge(uuid,bigint,text,bytea) OWNER TO postgres;
ALTER FUNCTION push_private.open_device_generation(uuid,uuid,uuid,bigint,bytea) OWNER TO postgres;
ALTER FUNCTION push_private.device_write(text,uuid,uuid,uuid,bigint,uuid,bigint,bytea,text,text,text) OWNER TO postgres;
ALTER FUNCTION push_private.register_device_v2(uuid,uuid,uuid,bigint,uuid,bigint,bytea,text,text,text) OWNER TO postgres;
ALTER FUNCTION push_private.fence_device_registration(uuid,uuid,uuid,bigint,uuid,bigint,bytea) OWNER TO postgres;
ALTER FUNCTION push_private.get_device_operation(uuid,uuid,bigint,uuid,bigint,bytea) OWNER TO postgres;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA push_private FROM PUBLIC, anon, authenticated, service_role, imahima_device_verifier;
GRANT EXECUTE ON FUNCTION
    push_private.enroll_device_installation(uuid,bytea),
    push_private.issue_device_challenge(uuid,bigint,text,bytea),
    push_private.open_device_generation(uuid,uuid,uuid,bigint,bytea),
    push_private.register_device_v2(uuid,uuid,uuid,bigint,uuid,bigint,bytea,text,text,text),
    push_private.fence_device_registration(uuid,uuid,uuid,bigint,uuid,bigint,bytea),
    push_private.get_device_operation(uuid,uuid,bigint,uuid,bigint,bytea)
TO imahima_device_verifier;
COMMIT;
