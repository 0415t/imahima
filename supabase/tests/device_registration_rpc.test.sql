BEGIN;
INSERT INTO auth.users(id) VALUES ('31000000-0000-0000-0000-000000000025'), ('32000000-0000-0000-0000-000000000025');

DO $$
BEGIN
    ASSERT NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
        WHERE n.nspname='push_private' AND
            (has_schema_privilege(r.role,n.oid,'USAGE') OR has_function_privilege(r.role,p.oid,'EXECUTE'))
    );
    ASSERT NOT has_function_privilege('imahima_device_verifier',
        'push_private.consume_device_challenge(uuid,bigint,text,bytea)','EXECUTE');
    ASSERT NOT has_table_privilege('imahima_device_verifier','push_private.installations','SELECT');
    ASSERT NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) AS acl
        WHERE n.nspname='push_private' AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
    ), 'Private functions must not grant EXECUTE to PUBLIC';
    ASSERT NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='push_private' AND (pg_get_userbyid(p.proowner)<>'postgres'
            OR NOT COALESCE(p.proconfig @> ARRAY['search_path=""'],false))
    ), 'Private functions must have the reviewed owner and fixed search_path';
END $$;

SET LOCAL ROLE imahima_device_verifier;
DO $$
DECLARE
    installation uuid := gen_random_uuid();
    other_installation uuid := gen_random_uuid();
    actor uuid := '31000000-0000-0000-0000-000000000025';
    other_actor uuid := '32000000-0000-0000-0000-000000000025';
    session_id uuid := gen_random_uuid();
    op uuid := gen_random_uuid();
    fence_op uuid := gen_random_uuid();
    gen bigint;
    nonce bytea;
    accepted jsonb;
BEGIN
    PERFORM push_private.enroll_device_installation(installation,decode('04','hex'));
    PERFORM push_private.enroll_device_installation(other_installation,decode('05','hex'));
    nonce := sha256(convert_to(gen_random_uuid()::text,'UTF8'));
    PERFORM push_private.issue_device_challenge(installation,1,'enroll',nonce);
    gen := push_private.open_device_generation(installation,actor,session_id,1,nonce);
    PERFORM set_config('test.device_installation',installation::text,true);
    PERFORM set_config('test.device_generation',gen::text,true);
    PERFORM set_config('test.device_session',session_id::text,true);

    nonce := sha256(convert_to(gen_random_uuid()::text,'UTF8'));
    PERFORM push_private.issue_device_challenge(installation,1,'register',nonce);
    BEGIN
        PERFORM push_private.register_device_v2(installation,actor,session_id,gen,NULL,1,nonce,'rollback-token','ios');
        RAISE EXCEPTION 'Missing operation ID accepted';
    EXCEPTION WHEN not_null_violation THEN NULL;
    END;
    -- The failed operation did not consume the challenge or commit the token.
    accepted := push_private.register_device_v2(installation,actor,session_id,gen,op,1,nonce,'managed-review-token','ios');
    ASSERT accepted->>'revision'='1';
    BEGIN
        PERFORM push_private.register_device_v2(installation,actor,session_id,gen,op,1,nonce,'managed-review-token','ios');
        RAISE EXCEPTION 'Used challenge accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    nonce := sha256(convert_to(gen_random_uuid()::text,'UTF8'));
    PERFORM push_private.issue_device_challenge(installation,1,'register',nonce);
    BEGIN
        PERFORM push_private.register_device_v2(installation,actor,session_id,gen,op,1,nonce,'changed-request','ios');
        RAISE EXCEPTION 'Different request accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    ASSERT push_private.register_device_v2(installation,actor,session_id,gen,op,1,nonce,'managed-review-token','ios')=accepted;
    nonce := sha256(convert_to(gen_random_uuid()::text,'UTF8'));
    PERFORM push_private.issue_device_challenge(installation,1,'lookup',nonce);
    BEGIN
        PERFORM push_private.get_device_operation(installation,other_actor,gen,op,1,nonce);
        RAISE EXCEPTION 'Other user read operation';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        PERFORM push_private.get_device_operation(other_installation,actor,gen,op,1,nonce);
        RAISE EXCEPTION 'Other installation read operation';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    ASSERT push_private.get_device_operation(installation,actor,gen,op,1,nonce)=accepted;
    PERFORM set_config('test.fence_operation',fence_op::text,true);
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','31000000-0000-0000-0000-000000000025',true);
DO $$
DECLARE affected integer;
BEGIN
    BEGIN
        PERFORM public.upsert_device_token('managed-review-token','android');
        RAISE EXCEPTION 'Legacy RPC overwrote managed row';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM public.user_device_tokens WHERE expo_push_token='managed-review-token';
    GET DIAGNOSTICS affected=ROW_COUNT;
    ASSERT affected=0;
    BEGIN
        UPDATE public.user_device_tokens SET platform='android' WHERE expo_push_token='managed-review-token';
        RAISE EXCEPTION 'Legacy client updated managed row';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    PERFORM public.upsert_device_token('legacy-review-token','ios');
END $$;
SET LOCAL ROLE service_role;
DELETE FROM public.user_device_tokens WHERE expo_push_token='managed-review-token';
DELETE FROM public.user_device_tokens WHERE expo_push_token='legacy-review-token';
RESET ROLE;

DO $$
BEGIN
    ASSERT EXISTS (SELECT 1 FROM public.user_device_tokens WHERE expo_push_token='managed-review-token' AND platform='ios' AND registration_revision=1);
    ASSERT NOT EXISTS (SELECT 1 FROM public.user_device_tokens WHERE expo_push_token IN ('legacy-review-token','rollback-token'));
    INSERT INTO push_private.device_challenges(challenge_digest,installation_id,key_version,purpose,issued_at,expires_at)
    VALUES (decode(repeat('ab',32),'hex'),current_setting('test.device_installation')::uuid,1,'fence',
        statement_timestamp()-interval '2 minutes',statement_timestamp()-interval '1 minute');
END $$;

SET LOCAL ROLE imahima_device_verifier;
DO $$
DECLARE i uuid := current_setting('test.device_installation')::uuid;
DECLARE g bigint := current_setting('test.device_generation')::bigint;
DECLARE s uuid := current_setting('test.device_session')::uuid;
DECLARE o uuid := current_setting('test.fence_operation')::uuid;
DECLARE a uuid := '31000000-0000-0000-0000-000000000025';
DECLARE n bytea := decode(repeat('ac',32),'hex');
DECLARE other_installation uuid := gen_random_uuid();
DECLARE other_actor uuid := '32000000-0000-0000-0000-000000000025';
DECLARE other_session uuid := gen_random_uuid();
DECLARE other_generation bigint;
BEGIN
    BEGIN
        PERFORM push_private.fence_device_registration(i,a,s,g,o,1,decode(repeat('ab',32),'hex'));
        RAISE EXCEPTION 'Expired challenge accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    PERFORM push_private.issue_device_challenge(i,1,'fence',n);
    BEGIN
        PERFORM push_private.fence_device_registration(i,a,s,g,o,2,n);
        RAISE EXCEPTION 'Wrong key version accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        PERFORM push_private.register_device_v2(i,a,s,g,gen_random_uuid(),1,n,'wrong-purpose','ios');
        RAISE EXCEPTION 'Wrong purpose accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    ASSERT (push_private.fence_device_registration(i,a,s,g,o,1,n)->>'fenced')::boolean;
    n := decode(repeat('ad',32),'hex');
    PERFORM push_private.issue_device_challenge(i,1,'register',n);
    BEGIN
        PERFORM push_private.register_device_v2(i,a,s,g,gen_random_uuid(),1,n,'late-token','ios');
        RAISE EXCEPTION 'Fenced generation accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    n := decode(repeat('ae',32),'hex');
    PERFORM push_private.issue_device_challenge(i,1,'lookup',n);
    ASSERT (push_private.get_device_operation(i,a,g,o,1,n)->>'fenced')::boolean;
    PERFORM push_private.enroll_device_installation(other_installation,decode('06','hex'));
    n := decode(repeat('af',32),'hex');
    PERFORM push_private.issue_device_challenge(other_installation,1,'enroll',n);
    other_generation := push_private.open_device_generation(other_installation,other_actor,other_session,1,n);
    n := decode(repeat('b0',32),'hex');
    PERFORM push_private.issue_device_challenge(other_installation,1,'register',n);
    BEGIN
        PERFORM push_private.register_device_v2(other_installation,other_actor,other_session,other_generation,
            gen_random_uuid(),1,n,'managed-review-token','ios');
        RAISE EXCEPTION 'Other installation reclaimed a fenced token';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;
RESET ROLE;
DO $$
BEGIN
    ASSERT NOT EXISTS (SELECT 1 FROM public.user_device_tokens WHERE expo_push_token IN ('managed-review-token','late-token'));
    ASSERT (SELECT fenced_at IS NOT NULL AND auth_revocation_confirmed_at IS NULL
        FROM push_private.installation_bindings WHERE generation=current_setting('test.device_generation')::bigint);
END $$;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
    BEGIN
        PERFORM public.upsert_device_token('managed-review-token','ios');
        RAISE EXCEPTION 'Old RPC recreated a managed token after the fence';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;
RESET ROLE;

-- Model a later trusted Auth confirmation; the RPC migration does not expose it.
UPDATE push_private.installation_bindings SET auth_revocation_confirmed_at = fenced_at
WHERE installation_id = current_setting('test.device_installation')::uuid
    AND generation = current_setting('test.device_generation')::bigint;
SET LOCAL ROLE imahima_device_verifier;
DO $$
DECLARE i uuid := current_setting('test.device_installation')::uuid;
DECLARE a uuid := '32000000-0000-0000-0000-000000000025';
DECLARE s uuid := gen_random_uuid();
DECLARE g bigint;
DECLARE n bytea := decode(repeat('b1',32),'hex');
BEGIN
    PERFORM push_private.issue_device_challenge(i,1,'enroll',n);
    g := push_private.open_device_generation(i,a,s,1,n);
    n := decode(repeat('b2',32),'hex');
    PERFORM push_private.issue_device_challenge(i,1,'register',n);
    ASSERT (push_private.register_device_v2(i,a,s,g,gen_random_uuid(),1,n,'managed-review-token','ios')->>'registered')::boolean;
END $$;
RESET ROLE;

ROLLBACK;
