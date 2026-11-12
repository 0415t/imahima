-- MANUAL TEMPLATE, NOT A MIGRATION. Do not execute without a separately approved
-- recovery plan and the exact pre-migration capture for the SAME project.
-- No data deletion or DROP/CASCADE is included. Stop group API traffic first.
-- Restoring old grants can expose NEW rooms/keys through old RLS; review first.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Deliberate fail-closed guard: copying this file into SQL Editor cannot apply
-- an incomplete recovery. Remove ONLY from a reviewed, baseline-filled copy.
do $$ begin
  raise exception 'Recovery blocked: exact baseline and separate recovery approval required';
end $$;

-- STEP 1: insert exact original_definition from group_mvp_recovery_capture.sql.
-- It must replace ONLY public.generate_room_key(). Do not approximate its old
-- six-character random algorithm from the behavioral summary. Preserve the
-- captured SECURITY mode, volatility, configuration, and function attributes.
-- Then insert its captured restore_owner_statement.

-- STEP 2: reconcile current function ACL against captured proacl/effective ACL.
-- CREATE OR REPLACE retains existing ownership/permissions; do not assume the
-- old EXECUTE ACL will be reconstructed automatically. Only revoke privileges
-- shown to be extra, with RESTRICT (never CASCADE); then replay captured GRANTs.
-- When original grantors differ, review grant chains and execute as the proper
-- authorized grantor/owner. A generated GRANT alone does not preserve grantor
-- provenance. Stop if exact reconstruction is not possible.

-- STEP 3: for rooms/room_members restore captured grants for PUBLIC, anon,
-- authenticated and service_role, including column grants/grant options.
-- Reconcile extra service_role DML introduced by the migration, rather than
-- blindly granting ALL. Preserve unrelated roles' grants. Any necessary REVOKE
-- must be reviewed against grant chains and use RESTRICT, not CASCADE.
-- Insert reviewed restore_statement values from the capture here.

-- STEP 4: insert captured restore_rls_statement/restore_force_statement values.
-- Never guess DISABLE/FORCE flags. Existing policies and constraints were not
-- modified by the migration: compare their definitions, leave them in place.

-- STEP 5: retain new columns, rate table, index, RPCs and all room/member data.
-- API traffic must remain blocked while old security settings are restored.
-- New RPC permissions are already restricted; removing service_role EXECUTE is
-- an optional separately reviewed quarantine if required, not an automatic step.
-- Do not drop mvp_archived_at: that would lose which rooms are archived.
-- Do not drop mvp_created_by: that would lose creator metadata and FK behavior.

-- Verify ACL/RLS/function owner/definitions and unchanged row fingerprints.
-- Keep this template ROLLBACK-only. A final COMMIT belongs only to a separately
-- reviewed filled recovery copy after all validations have passed.
rollback;
