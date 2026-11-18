# Group chat backend: commit preparation

No staging, commit or push was performed. Review this inventory before explicitly staging individual paths.

## Results

- Final functional regressions: 140 passed, 0 failed, 1 timer integration skipped. The DB wrapper is not counted twice; its separate historical fixture is skipped.
- Current dedicated Supabase schema/security audit: PASS, before and after regression.
- Backend TypeScript: PASS. Candidate TS/MJS lint: PASS (no warnings).
- Full repository TypeScript: FAIL, eight errors in unchanged frontend files; frontend remains untouched.
- Secret/identifier candidate scan and git diff --check: PASS.
- Earlier harness preflight stop and sandbox bootstrap failures remain recorded; see the regression report.

## Excluded, retained locally

- supabase/.temp/; all .runtime/, .env.local and node_modules/ directories/files.
- verification/group-chat-local/archive-classification.local.json.
- Environment-specific prepare-archive-classification, apply-archive-migration, final-creator-exit, archive-realtime-followup and repair-archived-fixture scripts.
- Original detailed design, DB/API implementation, timeout and archive documents under docs/ (without .public suffix).
- Original integration, phase3, final validation, room repair and schema application reports in verification/group-chat-local/.

These paths are not tracked. No file was deleted and no index removal was required. Exact pre-update originals and a verified SHA256 index remain in ignored .runtime/history/. Public copies are separate files.

## Suggested commit boundaries

1. Chat schema/RPC/RLS and related SQL/DB tests (chat migration; fixtures are historical, not shared-Supabase setup).
2. Auth classification, timeout plumbing, chat routes/services and HTTP regression tests.
3. Managed-room archive migration, archive postflight and dedicated archive regression tests.
4. Verification tooling, ignore rules, secret scanner, public documentation and anonymized reports.

The archive migration requires approved classification input for the actual destination. The local manifest is deliberately excluded and no local room IDs are embedded in the generic migration. These are review boundaries, not automatically independent deployable steps.

## Outstanding limitations

- Fresh event delivery to the repaired historical room remains untested; new archive fixtures were tested separately.
- Original single 25-second client timeout and historical initial subscription failure remain unresolved records, not marked fixed.
- Real timer update/extend integration is not available in this local schema.
- Channel connection denial is not an acceptance requirement; unauthorized row access and event delivery denial are required.

## Complete candidate inventory

- `.gitignore`
- `docs/group-archive-implementation.public.md`
- `docs/group-chat-api-implementation.public.md`
- `docs/group-chat-backend.md`
- `docs/group-chat-commit-checklist.md`
- `docs/group-chat-db-implementation.public.md`
- `docs/group-chat-mvp-detailed-design.public.md`
- `docs/group-chat-timeouts.public.md`
- `docs/group-chat-verification.md`
- `scripts/check-chat-commit.mjs`
- `server/app.ts`
- `server/auth.ts`
- `server/chat.ts`
- `server/groups.ts`
- `server/index.ts`
- `server/services/chat.ts`
- `server/services/supabase.ts`
- `server/timeouts.ts`
- `supabase/migrations/20261113000000_group_chat_mvp.sql`
- `supabase/migrations/20261116000000_group_mvp_managed_archive.sql`
- `supabase/tests/fixtures/chat_mvp_environment.sql`
- `supabase/tests/group_archive_postflight.sql`
- `supabase/tests/group_chat_mvp.test.sql`
- `supabase/tests/group_mvp_postflight.sql`
- `tests/test-auth-classification.ts`
- `tests/test-chat-db-concurrency.mjs`
- `tests/test-chat-db.ts`
- `tests/test-chat.ts`
- `tests/test-groups.ts`
- `tests/test-timeouts.ts`
- `verification/group-chat-local/.env.example`
- `verification/group-chat-local/.gitignore`
- `verification/group-chat-local/README.md`
- `verification/group-chat-local/analyze-realtime-investigation.mjs`
- `verification/group-chat-local/apply-schema.mjs`
- `verification/group-chat-local/archive-auth-chat-followup.mjs`
- `verification/group-chat-local/archive-regression.mjs`
- `verification/group-chat-local/bind-loopback.mjs`
- `verification/group-chat-local/capture-baseline.mjs`
- `verification/group-chat-local/final-validation.mjs`
- `verification/group-chat-local/integration-api.ts`
- `verification/group-chat-local/integration-audit.mjs`
- `verification/group-chat-local/integration-test.mjs`
- `verification/group-chat-local/local-stack.mjs`
- `verification/group-chat-local/package-lock.json`
- `verification/group-chat-local/package.json`
- `verification/group-chat-local/phase3-integration.mjs`
- `verification/group-chat-local/realtime-investigation.mjs`
- `verification/group-chat-local/reports/FINAL-VALIDATION-RESULTS.public.md`
- `verification/group-chat-local/reports/INTEGRATION-RESULTS.public.md`
- `verification/group-chat-local/reports/PHASE3-RESULTS.public.md`
- `verification/group-chat-local/reports/PRECOMMIT-REGRESSION.md`
- `verification/group-chat-local/reports/ROOM-REPAIR-RESULTS.public.md`
- `verification/group-chat-local/reports/SCHEMA-APPLICATION.public.md`
- `verification/group-chat-local/schema-tools.mjs`
- `verification/group-chat-local/sql/00_application_base.sql`
- `verification/group-chat-local/sql/application_postflight.sql`
- `verification/group-chat-local/supabase/.gitignore`
- `verification/group-chat-local/supabase/config.toml`
- `verification/group-chat-local/timeout-integration.mjs`
- `verification/group-chat-local/verify-local.mjs`
- `verification/group-chat-local/verify-schema.mjs`
