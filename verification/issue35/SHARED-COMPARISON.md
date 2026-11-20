# Shared metadata comparison (2026-11-19)

Source: user-supplied 001-005.csv. No database connection was made.
PostgreSQL 17.6, postgres role; 6 RLS-enabled/non-forced postgres-owned tables;
15 validated/non-deferrable constraints, 10 valid/ready/live indexes, 9 functions.
8 function bodies match repository baseline after CRLF normalization.
handle_new_user does not match by hash; source text was not supplied.
No history statement contents were supplied: MD5 cannot prove statement equality.
Expected project ref is a literal in the SQL, not an observed identity; observed
ref was null. User Dashboard assertion/prior API identity remain provenance.

| Migration | History | Classification |
|---|---|---|
| 20261001000000_initial_schema.sql | absent | review: logical initial objects exist; handle body and physical dropped column differ; repair not authorized |
| 20261006000000_toggle_profile_is_free.sql | present | history present; current effects consistent with cumulative baseline, not proof of original statement bytes |
| 20261017000000_create_user_device_tokens.sql | present | history present; current effects consistent with cumulative baseline, not proof of original statement bytes |
| 20261104000000_profile_free_until.sql | present | history present; current effects consistent with cumulative baseline, not proof of original statement bytes |
| 20261105000000_set_profile_is_free_atomic.sql | present | history present; current effects consistent with cumulative baseline, not proof of original statement bytes |
| 20261105000001_extend_profile_is_free.sql | present | history present; current effects consistent with cumulative baseline, not proof of original statement bytes |
| 20261105000002_enable_pg_cron.sql | absent | effect present: pg_cron 1.6.4 in pg_catalog; history adoption candidate |
| 20261106000000_auto_expire_free_status.sql | present | history present; current effects consistent with cumulative baseline, not proof of original statement bytes |
| 20261106000001_schedule_auto_expire.sql | present | history present; current effects consistent with cumulative baseline, not proof of original statement bytes |
| 20261107000000_free_end_notification_claims.sql | absent | pending: absent history and required effects not present |
| 20261110000000_extend_profile_is_free_from_notification.sql | absent | pending: absent history and required effects not present |
| 20261111000000_group_management_mvp.sql | absent | effect present: group tables/index/functions; history adoption candidate |
| 20261111000001_restrict_profile_client_writes.sql | absent | pending: absent history and required effects not present |
| 20261112000000_member_free_notifications.sql | absent | pending: absent history and required effects not present |
| 20261113000000_group_chat_mvp.sql | absent | pending: absent history and required effects not present |
| 20261116000000_group_mvp_managed_archive.sql | absent | pending: absent history and required effects not present |
| 20261117000000_index_group_mvp_rate_limits_window_start.sql | absent | pending: absent history and required effects not present |
| 20261117000001_fix_timer_lock_time_and_notification_retry.sql | absent | pending: absent history and required effects not present |
| 20261118000000_harden_core_runtime_privileges.sql | absent | pending new hardening; shared DB untouched |
| 20261118000001_harden_notification_runtime_privileges.sql | absent | pending new hardening; shared DB untouched |
| 20261118000002_harden_chat_runtime_privileges.sql | absent | pending new hardening; shared DB untouched |
| 20261118000003_harden_archive_runtime_privileges.sql | absent | pending new hardening; shared DB untouched |

Confirmed risks: anon/authenticated have all eight table privileges on profiles,
users and user_device_tokens. service_role has all eight on all six tables.
No tested GRANT OPTION is present. PUBLIC can EXECUTE generate_room_key and
handle_new_user. Profiles can INSERT/UPDATE is_free/free_until through existing
grants/policies. restrict_profile_client_writes remains the first real change.

Defaults: profiles.is_free=false; created_at=timezone(utc,now()); free_until=NULL.
rooms.room_key=generate_room_key(); other nullability/defaults are recorded in JSON.
pg_cron is already installed in pg_catalog. Its single expiry job is active every
minute and matches the expected SELECT command. This snapshot is not execution
history/notification behavior proof. Realtime publication has no published tables.

B physical profile column position 5 is absent. A synthetic dropped placeholder
reproduces that gap without asserting its historical name or meaning.
Existing user/member/token/message data were not supplied or copied.
Real room provenance, external clients and backup status remain unresolved.

Do not use the synthetic history adoption or classification as a shared repair
or room-classification authorization.

## B reproduction and transition

The baseline contains the exact six-table column/default/constraint/index layout,
including the physical profiles position-5 hole; 9 function signatures/settings;
7 recorded version/name entries; effective role/schema/table/column/function
permissions and grant options; relevant public default ACLs; the Auth trigger;
empty public Realtime publication; the active expiry Cron job; all 6 measured
extension placements/versions. It verifies metadata before adoption/migration.
The 8 matched function bodies are exact CRLF-normalized hash comparisons.
The unprovided handle body uses canonical initial_schema OFF semantics. It is
not an exact-source reproduction claim. All its supplied metadata is still checked.

The baseline creates 9 synthetic OFF profiles and 3 empty synthetic rooms.
The fixture explicitly marks one archived room MVP-managed and two open rooms
legacy. This is synthetic scenario design, never a classification of shared rooms.
Unknown classification is tested first: archive SQL must fail and roll back.
Actual shared counts, live free states, room origin and other clients remain unknown.
Existing original column values are compared immediately after migration and again
after the business suites. ON-state replay tests remain in the failure suite.

Ordered B steps:
1. Identity/API/TLS/fresh Auth-public-history-state guards and durable start marker.
2. Ten existing-effect SQL files construct the baseline; only the seven captured
   versions enter history. Compare the baseline before proceeding.
3. Fixture-only adoption of initial_schema, enable_pg_cron and group_management.
4. restrict_profile_client_writes, H1, required rollback-only intermediate create.
5. Notification claims, extend-from-notification, timer fix, rate index, member
   notifications, H2, chat, H3, classified archive, H4.
6. Preserve original fixture values and confirm all 22 versions once.
7. Full business suites -> fresh A/B comparison -> failure suite -> C CLI probe.
Each SQL/history application is atomic. Partial fixture provisioning is never
silently resumed; dispose only that temporary project and review the failure.

A/B expected result: equal logical structure, permissions, functions, history,
Cron and publication. Physical profiles column numbers differ by the single
measured dropped-column gap. The comparator validates both layouts and reports
this difference explicitly; no unexpected gap/order/type/default/ACL drift is
ignored. Snapshots bind both SQL/code and fixture hashes.

## Offline results for this revision

110 tests passed, 0 failed, 0 skipped: 75 retained cloud/review offline tests plus
35 new B tests. These are not the historical 263 live checks.
All 29 mjs files passed node --check; git diff --check passed.
Counterexamples detected: default/RLS/constraint/index/trigger/policy changes;
role membership/BYPASSRLS and GRANT OPTION changes; non-handle function body
changes; history/extension-placement/Cron changes; existing-row changes; unexpected
physical gaps, logical column order/type/default and ACL differences.
Actual B creator/migration/collector functions were exercised with query mocks;
PostgreSQL execution, SQL privilege enforcement and hosted API behavior remain
unverified. A mock pass does not establish that the SQL applies on hosted Supabase.
Detailed fresh evidence is private .runtime/shared-metadata-offline-results.json.
22 SQL files, 27 historical JSON evidence files and all 5 CSVs retain their hashes.
The original worktree still has only the pre-existing .review-pr26/.review-pr27
untracked directories. No application code or telemetry.json was changed.

## Ready-for-execution versus shared rollout gates

A/B/C offline preparation is complete. After explicit execution authorization:
- Confirm a free slot, temporary project ref, reviewed DB endpoint/CA, server
  major 17, email auto-confirm and ALL email/security notification toggles.
- Use only synthetic users/tokens and mandatory mocked Push. No SMTP/webhooks/
  Edge Functions/production credentials. Validate fixed target and nonce first.
- Run A, save snapshot/results, delete only A with human identity confirmation;
  create fresh B, run B and its comparison/failures; run C only after those pass.
- Stop for baseline/managed-role/extension/version/identity/TLS differences.
  Do not edit managed roles or weaken checks to force a match.
- Preserve fresh results separately and delete only the temporary project.

Shared rollout is NOT authorized or ready merely because offline tests pass.
Before shared application: obtain backup/restore confirmation; establish real
room provenance/classification or agree a separately reviewed behavior-preserving
plan; inventory other clients (currently unknown); review actual handle source
to distinguish comments from behavior; validate the missing-history adoption
evidence and actual history SQL/hash provenance; refresh live grants/data/state
and identity; approve exact rollout/stop/recovery procedure. Shared history repair
and writes require separate approval. Synthetic adoption is not a repair command.

## Current-phase files

Added: b-baseline.mjs, b-baseline.test.mjs, SHARED-COMPARISON.md,
fixtures/shared-20261119.json, fixtures/b-schema-read.sql,
fixtures/b-privileges-read.sql.
Updated: migrate.mjs, compare.mjs, package.json, CLOUD-RUNBOOK.md, README.md.
All paths are under verification/issue35. Earlier uncommitted PR-review changes
are retained. No commit, push, PR update, project creation or DB connection.

Index note: the recorded non-unique btree(user_id,room_id) index plus the earlier
user-supplied pg_catalog.uuid_ops/default btree UUID operator-class evidence
supports equivalence with member_free_notifications.room_members_user_room_idx.
Both are intentionally retained in B; no index is dropped or old SQL rewritten.
The existing rate-limit window_start index is absent and remains a pending step.

Measured extensions: pg_cron 1.6.4 / pg_catalog; pg_stat_statements 1.11 /
extensions; pgcrypto 1.3 / extensions; plpgsql 1.0 / pg_catalog;
supabase_vault 0.3.1 / vault; uuid-ossp 1.1 / extensions.
These values are observed metadata, not assumed Supabase initial defaults.
