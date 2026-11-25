BEGIN;

DO $$
BEGIN
    ASSERT (SELECT user_id = '11000000-0000-0000-0000-000000000024'
        AND platform = 'ios' AND device_name = 'legacy'
        AND created_at = '2026-11-23T00:00:00Z' AND updated_at = '2026-11-24T00:00:00Z'
        AND installation_id IS NULL AND generation IS NULL AND registration_revision IS NULL
        FROM public.user_device_tokens WHERE id = '12000000-0000-0000-0000-000000000024'
            AND expo_push_token = 'legacy-before-recovery-ddl'), 'DDL must preserve the pre-existing row';
    ASSERT (SELECT count(*) = 4 AND bool_and(c.relrowsecurity)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'push_private' AND c.relkind = 'r'), 'Private table RLS missing';
    ASSERT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'push_private');
    ASSERT NOT EXISTS (
        SELECT 1 FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
        CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS p(priv)
        WHERE has_sequence_privilege(r.role,
            pg_get_serial_sequence('push_private.installation_bindings', 'generation'), p.priv)
    ), 'Application roles must not access the generation sequence';
    ASSERT NOT EXISTS (
        SELECT 1 FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
        CROSS JOIN (VALUES ('installations'), ('installation_bindings'), ('operations'), ('device_challenges')) AS t(tbl)
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
        WHERE has_schema_privilege(r.role, 'push_private', 'USAGE')
            OR has_schema_privilege(r.role, 'push_private', 'CREATE')
            OR has_table_privilege(r.role, ('push_private.' || t.tbl)::regclass, p.priv)
    ), 'Application roles must not access the private schema or tables';
END $$;

INSERT INTO auth.users(id) VALUES ('21000000-0000-0000-0000-000000000024');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000024', true);
SELECT public.upsert_device_token('legacy-before-recovery-ddl', 'android', 'legacy update');
SELECT public.upsert_device_token('legacy-created-after-ddl', 'ios');
DO $$
BEGIN
    BEGIN
        PERFORM 1 FROM push_private.installations;
        RAISE EXCEPTION 'Unexpected private-table access';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;
RESET ROLE;

DO $$
DECLARE
    install uuid;
    owner_id uuid := '11000000-0000-0000-0000-000000000024';
    other_id uuid := '21000000-0000-0000-0000-000000000024';
    sid uuid := gen_random_uuid();
    op uuid := gen_random_uuid();
    hash bytea := decode(repeat('01', 32), 'hex');
    first_generation bigint;
    next_generation bigint;
    final_generation bigint;
BEGIN
    ASSERT (SELECT count(*) = 2 AND bool_and(user_id = other_id AND installation_id IS NULL
        AND generation IS NULL AND registration_revision IS NULL)
        FROM public.user_device_tokens WHERE expo_push_token IN ('legacy-before-recovery-ddl', 'legacy-created-after-ddl')),
        'Old RPC can still insert and reassign legacy tokens';
    INSERT INTO push_private.installations(public_key) VALUES (decode('04', 'hex')) RETURNING installation_id INTO install;
    INSERT INTO push_private.installation_bindings(installation_id, user_id, session_id)
    VALUES (install, owner_id, sid) RETURNING generation INTO first_generation;

    BEGIN
        INSERT INTO push_private.installation_bindings(installation_id, user_id, session_id)
        VALUES (install, other_id, gen_random_uuid());
        RAISE EXCEPTION 'Unexpected second active binding';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        UPDATE push_private.installation_bindings SET auth_revocation_confirmed_at = statement_timestamp()
        WHERE installation_id = install AND generation = first_generation;
        RAISE EXCEPTION 'Unexpected confirmation before the push fence';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    UPDATE push_private.installation_bindings SET fenced_at = statement_timestamp()
    WHERE installation_id = install AND generation = first_generation;
    ASSERT (SELECT auth_revocation_confirmed_at IS NULL AND session_id = sid FROM push_private.installation_bindings
        WHERE installation_id = install AND generation = first_generation), 'Push fence must preserve original Auth evidence without confirming revocation';
    INSERT INTO push_private.installation_bindings(installation_id, user_id, session_id)
    VALUES (install, other_id, gen_random_uuid()) RETURNING generation INTO next_generation;

    INSERT INTO push_private.operations(installation_id, operation_id, generation, kind, request_digest, result)
    VALUES (install, op, first_generation, 'fence', hash, '{"fenced":true}');
    BEGIN
        INSERT INTO push_private.operations(installation_id, operation_id, generation, kind, request_digest, result)
        VALUES (install, op, next_generation, 'register', hash, '{}');
        RAISE EXCEPTION 'Unexpected duplicate operation';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO push_private.operations(installation_id, operation_id, generation, kind, request_digest, result)
        VALUES (install, gen_random_uuid(), 0, 'register', hash, '{}');
        RAISE EXCEPTION 'Unexpected orphan operation';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    ASSERT (SELECT result = '{"fenced":true}'::jsonb FROM push_private.operations
        WHERE installation_id = install AND operation_id = op), 'Committed-result shape is queryable';

    BEGIN
        INSERT INTO public.user_device_tokens(user_id, expo_push_token, platform, installation_id)
        VALUES (other_id, 'partial-binding', 'ios', install);
        RAISE EXCEPTION 'Unexpected partial binding';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO public.user_device_tokens(user_id, expo_push_token, platform, installation_id, generation, registration_revision)
        VALUES (owner_id, 'wrong-owner', 'ios', install, next_generation, 1);
        RAISE EXCEPTION 'Unexpected cross-user token binding';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    INSERT INTO public.user_device_tokens(user_id, expo_push_token, platform, installation_id, generation, registration_revision)
    VALUES (other_id, 'managed-token', 'ios', install, next_generation, 1);

    INSERT INTO push_private.device_challenges(challenge_digest, installation_id, key_version, purpose, expires_at)
    VALUES (hash, install, 1, 'register', statement_timestamp() + interval '30 seconds');
    BEGIN
        UPDATE push_private.device_challenges SET consumed_at = expires_at WHERE challenge_digest = hash;
        RAISE EXCEPTION 'Unexpected consumption at expiry';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    UPDATE push_private.device_challenges SET consumed_at = issued_at WHERE challenge_digest = hash;
    ASSERT (SELECT consumed_at IS NOT NULL FROM push_private.device_challenges WHERE challenge_digest = hash);

    -- This Auth schema is the isolated synthetic test fixture.
    DELETE FROM auth.users WHERE id = other_id;
    ASSERT NOT EXISTS (SELECT 1 FROM public.user_device_tokens WHERE expo_push_token = 'managed-token');
    ASSERT NOT EXISTS (SELECT 1 FROM push_private.installation_bindings
        WHERE installation_id = install AND generation = next_generation);
    BEGIN
        INSERT INTO push_private.installation_bindings(installation_id, generation, user_id, session_id)
        VALUES (install, next_generation, owner_id, gen_random_uuid());
        RAISE EXCEPTION 'Unexpected caller-supplied generation';
    EXCEPTION WHEN generated_always THEN NULL;
    END;
    INSERT INTO push_private.installation_bindings(installation_id, user_id, session_id)
    VALUES (install, owner_id, gen_random_uuid()) RETURNING generation INTO final_generation;
    ASSERT final_generation > next_generation, 'Account deletion must not permit generation reuse';
END $$;

ROLLBACK;
