-- TEMPLATE ONLY. Run in the NEW temporary project's Dashboard SQL Editor.
-- Do NOT run against the shared project. Replace both placeholders before use.
BEGIN;
DO $guard$
DECLARE ref text := 'REPLACE_WITH_NEW_PROJECT_REF'; nonce text := 'REPLACE_WITH_RANDOM_64_HEX_CHARACTERS';
BEGIN
 IF ref !~ '^[a-z]{20}$' OR ref='wkghgmjennvlcrnuthtd' OR nonce !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'Invalid temporary project ref'; END IF;
 IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Expected postgres'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p'))
 OR EXISTS(SELECT 1 FROM auth.users)
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='issue35_verification')
 THEN RAISE EXCEPTION 'Not a pristine temporary project'; END IF;
END $guard$;
CREATE SCHEMA issue35_verification;
REVOKE ALL ON SCHEMA issue35_verification FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE issue35_verification.target_identity(project_ref text PRIMARY KEY,nonce text NOT NULL CHECK(nonce ~ '^[a-f0-9]{64}$'));
REVOKE ALL ON issue35_verification.target_identity FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO issue35_verification.target_identity VALUES('REPLACE_WITH_NEW_PROJECT_REF','REPLACE_WITH_RANDOM_64_HEX_CHARACTERS');
CREATE TABLE issue35_verification.provisioning_state(id boolean PRIMARY KEY CHECK(id),status text NOT NULL);
REVOKE ALL ON issue35_verification.provisioning_state FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
