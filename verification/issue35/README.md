# Issue #35 verification

Authorized offline and hosted A/B/C verification is complete. Start with
[the final report](../../docs/issue35-final-review.md) and
[the 53-item review map](../../docs/issue35-review-resolution.md).

Final hosted results: A 106 pass / 0 fail / 1 not-run; B 103 / 0 / 1;
C 2 / 0 / 0. Total 211 / 0 / 2. Offline 110 + 17 are separate.
Historical reports/*.json retain the original 263-check Docker evidence.

The active implementation and procedural record are in CLOUD-RUNBOOK.md.
The retained B project now has 23 history entries after C; application SQL
remains 22 files. Do not rerun initial provisioning or overwrite A/B snapshots.
Do not apply the temporary 23rd migration to shared DB or add it to source SQL.

Commands below describe existing offline tests; no additional tests are required
by this final documentation phase:
    node --test verification/issue35/foundation.test.mjs verification/issue35/offline-review.test.mjs verification/issue35/b-baseline.test.mjs

Only a reviewed, explicit temporary target file is accepted. Node >=22, reviewed
CA, verified client TLS/hostname, API ref, DB identity nonce and PostgreSQL SSL
are required by the execution procedure. Do not disable checks to force a pass.
Database/admin test access is separate from runtime service_role operations.

Legacy Docker/WSL startup is retired; stacks.mjs fails immediately. Old operational
transport/network/provisioning/safety modules are not active entry points.
Source history and ignored archives retain earlier work; do not run old startup.

New hosted reports use reports/cloud/<run>/<label> and refuse overwrite.
Private target files, keys, passwords, actual nonce values, CA, snapshots and raw
logs remain under ignored .runtime/cloud. No default target or local fallback.
Do not commit .runtime, raw logs, data dumps, node_modules or intermediate drafts.

SHARED-COMPARISON.md is the dated metadata/offline preparation record.
evidence/issue35-20261119-182033 contains exact .txt copies of the approved one-off
resume source and a public hash record for review only, not executable entry points.
Shared rollout prerequisites and recovery remain in the final report; these
verification runners deliberately reject the shared project.

No project deletion, shared write/repair, commit, push, merge or PR update is
authorized by this README. Issue #35 remains open through shared rollout.
