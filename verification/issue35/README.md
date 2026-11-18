# Issue #35 isolated ACL verification

Base: `aff689da63c04e3a48e5b8f541d9a1573ad1b382`; branch `codex/issue35-acl`.
Only the four additive H1-H4 migrations are production code. All other files here are verification support. Historical 18 migrations and application files are immutable.

## Safety boundary

Use only the dedicated WSL distribution `imahima-issue35-acl`, engine label `imahima.issue=35`, Docker root `/var/lib/imahima35-docker`, socket `127.0.0.1:27335`. Never use Docker Desktop, an existing local database, hosted credentials or a linked hosted project.

The runner checks the engine, project container's published DB port, loopback URL and PostgreSQL system identity. The SELECT-only freshness gate runs before bootstrap and default-privilege changes. A replay against a nonempty database must fail without catalog/default-ACL/history/data changes. All fixtures use admin access; runtime service_role never receives fixture permissions.

Dedicated networks block container-originated NEW external traffic. Backend fetch is allowlisted to the stack API; Expo Push is mocked; email confirmations/mail transport are disabled. `SUPABASE_HOME` is fixed inside ignored runtime storage and telemetry/update checks are disabled for CLI subprocesses.

## Dependencies and provisioning

The dedicated WSL uses the official Ubuntu Minimal 24.04 rootfs, checked against SHA256SUMS, with docker.io. Its engine command is:

```sh
dockerd --data-root=/var/lib/imahima35-docker --exec-root=/run/imahima35-docker --pidfile=/run/imahima35-docker.pid --host=unix:///run/imahima35-docker.sock --host=tcp://127.0.0.1:27335 --label=imahima.issue=35
```

Pinned harness dependencies are installed with `npm ci --ignore-scripts`; server dependencies are installed only in this separate worktree. CLI 3.1.0, pg 8.16.3 and the SDK/tsx are locked by package-lock.json. Never install into the original worktree for this verification.

## Final pristine run

The final run is `verified`: project names `imahima-issue35-verified-a/b/c`, API/DB ports 48321/48322, 49321/49322, 50321/50322. Backend ports are API+10. Earlier initial/final/review stacks retain separate data. The final three databases were newly provisioned after code fixes, not reset or replayed.

The following documents the completed run. **Do not replay it on retained databases.** Future runs require a new explicitly reviewed run name, project names and unused allowlisted ports. Do not use db reset. Stop immediately when a required script exits nonzero.

```powershell
$env:ISSUE35_RUN='verified'
$env:ISSUE35_LABELS='a,b,c'
node verification/issue35/stacks.mjs start
node verification/issue35/stacks.mjs status
$env:ISSUE35_LABELS='a,b'
node verification/issue35/migrate.mjs
$env:ISSUE35_LABELS='c'
node verification/issue35/migrate.mjs
$env:ISSUE35_LABELS='a,b'
node verification/issue35/compare.mjs --before-failures
node verification/issue35/regressions.mjs
node verification/issue35/specifications.mjs
node verification/issue35/features.mjs
node verification/issue35/realtime-lifecycle.mjs
node verification/issue35/normal-management.mjs
node verification/issue35/failures.mjs
node verification/issue35/integrity.mjs
node verification/issue35/compare.mjs
```

A applies original 18 in order, empty classification manifest on the same session, then H1-H4. B reproduces supplied six-table/seven-history state, nine OFF synthetic profiles and three synthetic rooms, then applies restriction/H1 early, notification/timer/index additions/H2, chat/H3, synthetic reviewed classification/archive/H4 and three verified synthetic history adoptions. Classification-unknown cases are tested for atomic rejection. This is not evidence for repairing shared history.

H1 must precede H4; never replay H1 alone after H4. The failure suite does not persistently reapply hardening or rewrite history. All intentional SQL mutations are transactional and rolled back. The pre-failure comparison is recorded before mutation tests; post-failure catalog and full history must remain unchanged.

C follows A's 22-migration path and alone receives a generated `20990101000000_issue35_forward_probe.sql` through actual official `db push`. The CLI workspace explicitly enables migrations. List output must match every one of the 22 local/remote versions; missing files, mismatches, disabled migration config and `No migrations found` are rejected. C finishes with 23 versions; A/B remain at 22. The generated probe stays ignored and is not production code.

## Evidence

See `reports/summary.json`, latest `*-results.json`, pre-failure/final comparison and environment-handoff. Final counters include only the final pristine run, not earlier runs. A check unit can contain many assertions; migration application records are not independent business tests.

ACL verification checks PUBLIC and all three runtime roles, table/column/function/schema grants, grantors and GRANT OPTION. PostgreSQL rejects GRANT OPTION to PUBLIC; ordinary PUBLIC grants are separately detected. Mutation tests cover allowed privileges with erroneous grant options, migration-path drift, timer deadline/cleanup errors, eligibility bypass, duplicate recipients and CLI discovery defects. Positive Realtime controls accompany denial checks.

Exactly 13 historical `*-initial.json` / `*-attempt-*.json` files remain local but are ignored. Private runtime contains prior reports and diagnostic errors, local credentials, cluster disks and generated CLI files. None belongs in a commit.

Limitations: synthetic B is not a shared DB dump; real room provenance/default expressions/pg_cron placement/external clients/restore readiness still require shared-deployment review. No real-device Push, production load or UI automation is claimed. Early diagnostic CLI calls updated the user-level telemetry metadata before SUPABASE_HOME was isolated; no baseline existed to restore it safely. Original worktree, existing DB/container and stopped old WSL environments were not changed.

After evidence collection, stop only projects proven to belong to this dedicated engine. Retain volumes and stop only this dedicated WSL distribution. Never use --all.
