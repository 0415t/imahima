BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE SCHEMA push_private;
REVOKE ALL ON SCHEMA push_private FROM PUBLIC, anon, authenticated, service_role;

-- Future writers lock the installation first, then the binding and operation,
-- then token rows. Allocate generations here, not from MAX(generation):
-- deleting an Auth account cascades its binding rows.
CREATE TABLE push_private.installations (
    installation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    public_key bytea NOT NULL CHECK (octet_length(public_key) > 0),
    key_version bigint NOT NULL DEFAULT 1 CHECK (key_version > 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE push_private.installation_bindings (
    installation_id uuid NOT NULL REFERENCES push_private.installations(installation_id),
    generation bigint GENERATED ALWAYS AS IDENTITY (NO CYCLE) CHECK (generation > 0),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    session_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    fenced_at timestamptz,
    auth_revocation_confirmed_at timestamptz,
    PRIMARY KEY (installation_id, generation),
    UNIQUE (installation_id, generation, user_id),
    CHECK (fenced_at IS NULL OR fenced_at >= created_at),
    CHECK (auth_revocation_confirmed_at IS NULL OR
        (fenced_at IS NOT NULL AND auth_revocation_confirmed_at >= fenced_at))
);

CREATE UNIQUE INDEX installation_bindings_one_active
    ON push_private.installation_bindings (installation_id) WHERE fenced_at IS NULL;
CREATE INDEX installation_bindings_user ON push_private.installation_bindings (user_id);

-- session_id deliberately has no FK to auth.sessions. Evidence must remain
-- available after GoTrue removes that session.
CREATE TABLE push_private.operations (
    installation_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    generation bigint NOT NULL,
    kind text NOT NULL CHECK (kind IN ('register', 'fence', 'confirm_auth_revocation')),
    request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    completed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (installation_id, operation_id),
    FOREIGN KEY (installation_id, generation)
        REFERENCES push_private.installation_bindings (installation_id, generation) ON DELETE CASCADE
);
CREATE INDEX operations_binding ON push_private.operations (installation_id, generation);

CREATE TABLE push_private.device_challenges (
    challenge_digest bytea PRIMARY KEY CHECK (octet_length(challenge_digest) = 32),
    installation_id uuid NOT NULL REFERENCES push_private.installations(installation_id) ON DELETE CASCADE,
    key_version bigint NOT NULL CHECK (key_version > 0),
    purpose text NOT NULL CHECK (purpose IN ('enroll', 'register', 'fence', 'lookup', 'confirm_auth_revocation')),
    issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    CHECK (expires_at > issued_at),
    CHECK (consumed_at IS NULL OR (consumed_at >= issued_at AND consumed_at < expires_at))
);
-- Future RPCs must check ownership, key version and purpose, and consume by
-- conditional UPDATE of an unconsumed, unexpired row in the operation's transaction.
CREATE INDEX device_challenges_installation ON push_private.device_challenges (installation_id);

ALTER TABLE push_private.installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_private.installation_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_private.operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_private.device_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA push_private FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA push_private FROM PUBLIC, anon, authenticated, service_role;

-- All three columns stay NULL on legacy rows. No data is backfilled and the
-- existing registration RPC and policies are intentionally left as-is.
-- Do not create managed token rows before the old upsert and delete paths
-- are restricted. The FK protects ownership, not same-user legacy updates.
ALTER TABLE public.user_device_tokens
    ADD COLUMN installation_id uuid,
    ADD COLUMN generation bigint,
    ADD COLUMN registration_revision bigint,
    ADD CONSTRAINT user_device_tokens_registration_shape CHECK (
        (installation_id IS NULL AND generation IS NULL AND registration_revision IS NULL)
        OR (installation_id IS NOT NULL AND generation IS NOT NULL
            AND registration_revision IS NOT NULL AND registration_revision > 0)
    ),
    ADD CONSTRAINT user_device_tokens_installation_binding
        FOREIGN KEY (installation_id, generation, user_id)
        REFERENCES push_private.installation_bindings (installation_id, generation, user_id);
CREATE INDEX user_device_tokens_installation_generation
    ON public.user_device_tokens (installation_id, generation) WHERE installation_id IS NOT NULL;

COMMIT;
