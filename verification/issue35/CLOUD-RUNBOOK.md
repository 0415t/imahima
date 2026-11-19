# Issue #35: one-off temporary-project verification

Status: AUTHORIZED A/B/C VERIFICATION COMPLETE (2026-11-19).
A: 106 pass / 0 fail / 1 not-run; B: 103 / 0 / 1; C: 2 / 0 / 0.
See ../../docs/issue35-final-review.md for evidence, exceptions and rollout gates.
The existing B project is retained with 23 history entries after C. Do not rerun
initial provisioning, reset it, delete it or overwrite pre-C A/B snapshots.
The steps below record the approved sequence; they do not authorize a new run.
This is not a shared deployment tool.

## Scope
Keep all 22 SQL files and the application unchanged. Reuse business assertions,
atomic SQL/history helpers, ACL checks, mutation tests and cleanup helpers.
Do not develop Docker, WSL, namespaces, relays, certificate infrastructure or a
general project provisioner. Dashboard actions are manual and target-specific.

## Prerequisites
- One free project slot; do not pause/delete the shared project to obtain a slot.
- Shared metadata reviewed; synthetic B uses explicit synthetic room provenance.
  Real room provenance, other-client inventory and backup status remain gates
  for SHARED rollout, not prerequisites for isolated synthetic project execution.
- Node >=22, locked dependencies, pinned Supabase CLI 3.1.0 already installed.
- A manual explicit project ref approved for each of A and B.
- Email confirmations and Auth security notifications disabled on TEMP project.
  No invitation, OTP, recovery, SMTP credentials, Edge Functions, webhooks or real
  device tokens. Do not import shared users/messages/tokens or link production.
- Read the actual Auth settings response before signup: mailer_autoconfirm=true.
  It does not attest security-notification toggles; verify those in Dashboard.
- API and PostgreSQL credentials are different. Set postgres_major from reviewed shared SQL results; it has no default.
  The SQL session must match it. Obtain DB endpoint and CA from
  Dashboard Connect. Direct IPv6 or IPv4 session pooler on 5432 only; no 6543.
- Hosted role/default ACLs/extensions must be measured. Do not alter managed
  supabase_admin/default privileges or grant extra admin powers to make tests pass.

## Create A manually (after approval)
1. Create a new standalone Free project, without GitHub/branching integration.
2. Confirm Dashboard project ref and its difference from the shared ref.
3. Apply cloud-target-setup.sql ONLY in that Dashboard, replacing BOTH repeated
   project-ref placeholders and ALL nonce placeholders with reviewed values. The template refuses
   its placeholder/shared ref. Check empty public tables/Auth first.
4. Copy cloud-target.example.json into private
   .runtime/cloud/<run>/a.target.json. Fill temporary credentials/nonce and set
   approved_for_testing=true only after identity/settings review.
   Store reviewed CA at .runtime/cloud/<run>/database-ca.crt.
   Protect this directory with OS permissions; never commit or paste credentials.
5. Use a 64-character lowercase hexadecimal nonce from crypto.randomBytes(32).toString("hex").
   Use a new run name. Set ISSUE35_TARGET_FILE to that absolute file path.
   Never reuse an old run/output directory. No automatic .env or CLI link lookup.
6. Set ISSUE35_ORIGINAL_WORKTREE explicitly and capture once using
   node verification/issue35/original-worktree.mjs capture.
7. After execution approval, run migrate.mjs, then features.mjs,
   realtime-lifecycle.mjs, specifications.mjs, regressions.mjs and integrity.mjs,
   each with the SAME explicit target file. Stop on any nonzero exit/report fail.
8. Run compare.mjs to capture a.snapshot.json, then failures.mjs. compare requires
   successful migration/feature/realtime/specification/regression/integrity reports
   matching this run and project; empty/failed/missing reports stop it. It re-reads
   the current catalog before any mutation and checks rollback/catalog/history.
   Do not publish the snapshot as final if failure tests do not pass.
9. Preserve results, SQL and code hashes and raw private logs. Do not claim 263
   successes for this revision: count actual pass/fail/not-run separately.

## Switch to B
10. Confirm A identity/results in Dashboard, delete ONLY A, then place
    a-retired.json in the private run directory with
    {"project_ref":"<A ref>","confirmed_deleted":true}.
    This is a human deletion attestation, not a live A/B comparison.
11. Create a NEW standalone project B and repeat identity/email/CA review with
    b.target.json and label=b. Never reset or reuse the shared project.
12. With B's explicit target, run migrate.mjs. It requires a fresh application/
    Auth/history state, constructs the measured six-table/nine-function baseline,
    and compares metadata/ACL/defaults against fixtures/shared-20261119.json
    BEFORE synthetic history adoption or missing migrations. A mismatch stops.
    All six measured extension placements/versions are checked, including
    pg_cron 1.6.4 in pg_catalog. Inspect platform differences rather than changing
    managed objects to make checks pass.
    Seven history entries are reconstructed from repo SQL, three existing-effect
    entries are adopted ONLY in the temporary fixture. Original shared statement
    bytes were not supplied and are not claimed to have been reproduced.
    Restrict profile writes -> H1 -> notification migrations/fix/index -> H2 ->
    chat -> H3 -> archive with explicit synthetic classification -> H4.
    H1 intermediate group creation is probed on both routes, rollback-only.
    Nine synthetic OFF profiles and three synthetic rooms are preserved. These
    counts/states are fixture choices, not a fresh observation of shared data.
13. Once B implementation and execution are approved, run its feature suites.
    compare.mjs compares current B against the saved A catalog and requires the
    same SQL/test hashes and different project refs. A source edits require
    rerunning A. Run failures.mjs only after this fresh B comparison.
    Save the catalog/history comparisons before the C probe.

## C on disposable B
14. normal-management.mjs runs the pinned native CLI in a new private unlinked
    workdir containing only the 22 SQL files and explicit config. It preflights
    project/DB identity, validates all 22 local/remote versions and dry-run success.
    A failed listing stops before application. It then adds one synthetic future
    migration, applies it, checks table/history/ACL and a clean second dry-run.
    Only B becomes 23 versions. Do not compare that post-probe schema to A.

## Coverage substitutions / limitations
- Docker API, socket, daemon, host-port, namespace and kernel firewall tests:
  retired, not passed. Alternative: fixed cloud ref, exact HTTPS/DB endpoint,
  validated certificate, read-only DB identity nonce, API ref, isolated credentials,
  fail-closed Push preload and no production data.
- supabase_admin role inheritance fault injection: not-run. Alternative: actual
  role/membership/default ACL inventory, H1 guard review and offline effective
  privilege/rollback tests. Managed-role restrictions are not bypassed.
- Ownership mutations requiring hosted-unavailable powers: do not force them.
  Record not-run and retain effective GRANT OPTION checks plus offline counterexample.
- Hosted all-platform pristine inventory: retired. Require new Dashboard project,
  empty application/Auth/history state and the identity marker instead.
- Timing/lock tests retain exact blocker and DB-time requirements. If a hosted
  timeout occurs, investigate it; do not count it as a detected business mutant.
- Sequential catalog comparison is not simultaneous live A/B proof. It is anchored
  to source hashes and a preserved A snapshot, with fresh B checks before mutation.
- A schema function hash is not proof of the shared DB matching: shared SQL
  inspection/repair/backup/room classification remain separate rollout gates.
- Privilege/schema/SQL/CLI actions have not been tested on a hosted project yet.

## Cleanup
Stop local backend and remove channels/DB clients; save pass/fail/not-run results.
The current B project must be retained. Any later deletion requires separate approval and a fresh target-ref confirmation.
Remove local target credentials/session files after preserving redacted evidence.
Keep old reports and source archive. Do not restore telemetry.json by guessing.
No commit, push, merge, PR update, shared repair or shared write is authorized here.

## PR retention
Keep the four production SQL files (H1/H4 approved minimal amendments), business
tests, pure safety helpers, active cloud entry points and this runbook.
Remove operational transport/network/provisioning/safety files; stacks.mjs remains
only as an explicit fail-closed retirement notice. Remove its npm scripts.
Do not commit .runtime exports/keys/logs or resurrect historical startup commands.
Older phase1/phase2/environment preparation documents are historical, some have
encoding loss; exclude redundant/corrupt drafts from the final commit candidate.
Keep the committed 263-report JSON and distinguish it from new offline results.


## Historical offline implementation report
- Mandatory cloud-independent H1/H4 amendments remain exactly as previously
  approved; no SQL file was edited in the cloud adaptation.
- Offline tests for this revision include active guards and B mutation cases.
  Exact pass/fail counts are recorded in SHARED-COMPARISON.md.
  Historical 87 tests are not claimed unchanged: old Docker foundation cases and
  two deleted generic provisioner tests were retired. Counts are not comparable
  business coverage totals.
- Native CLI stdout AND stderr are retained, credentials are passed via scoped
  environment, and home is isolated. reset/link/extra flags are rejected.
- A failed CLI recognition/dry-run cannot reach forward application.
- Snapshots require successful preceding reports; B mutation rechecks its current
  catalog; the C entry rechecks B again. No repair is performed to make paths match.
- That offline preparation stage made no remote connections. Later authorized hosted runs completed as recorded below.
- B construction is implemented and offline-tested. handle_new_user uses the
  repository's canonical OFF behavior; its unknown shared comment/body hash is
  explicitly excluded from exact-body claims, while its metadata remains checked.
- A/B logical catalogs must match. B's measured profiles position-5 gap is the
  ONLY permitted physical column-number difference; it is validated and reported
  separately. An unexpected gap/order/type/default/ACL difference fails.
- CSV provenance includes a literal expected ref but no observed DB project ref.
  Treat this as user-supplied Dashboard evidence, not a fresh identity proof.
- Later hosted coverage, managed-platform limits and exceptions are documented in the final report.

H1 intermediate RPC creation is now a required rollback-only migration-stage probe.
H4 missing-column prerequisite tests revoke each of the three INSERT grants in
separate rollback transactions. These live probes are prepared, not executed.


## Completed-run exceptions and evidence
The B-only Vault 0.3.1 -> 0.3.2/schema vault exception was explicitly approved.
The measured fixture and frozen b-baseline.mjs remain unchanged and strict.
A one-off runtime supplement verified the exact stop catalog, seven stored SQL
statements, synthetic rows, full extension inventory and all original guards.
Its hashes and non-executable review copies are in evidence/issue35-20261119-182033.
Do not broaden the exception or repeat the one-off continuation on retained B.

A later network-related pg.Client disconnect interrupted features. Its logs and
partial state remain retained. State/fixture checks passed and existing features
were rerun without migration replay; all subsequent B suites and A/B comparison
passed. Final report JSONs retain separate stopped/resumed/final records.

C used official CLI 3.1.0 in the private unlinked B workdir. Post-apply listing
recognized 23 entries and dry-run was up to date. Original 22 statement records,
existing application catalog, and 14 table data fingerprints were unchanged.
C's SQL never entered supabase/migrations. Keep B; deletion needs approval.

Final totals are 211 pass / 0 fail / 2 not-run, plus separate offline 110 + 17.
The two not-run records are the hosted managed-role inheritance fault injection
in A/B. Previous Docker/OS isolation tests are retired, not counted as passed.
Shared DB rollout/repair and real-room classification remain separate approvals.
