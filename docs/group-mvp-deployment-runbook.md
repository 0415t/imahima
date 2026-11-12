# Group MVP deployment preparation

Status: PREPARATION ONLY. No production SQL, smoke-test writes, configuration
changes, deployment, commit or push is authorized by this document. Execute the
application steps only after the user explicitly approves the target project,
execution role, exact migration and smoke-test scope.

Target: `supabase/migrations/20261111000000_group_management_mvp.sql` only.
Do not run all historical migrations or `supabase db push`: the old toggle SQL
does not match the live one-hour timer and must not be replayed.

## Before approval

- Run `supabase/tests/group_mvp_preflight.sql` using the actual intended session.
  Confirm project identity in the Dashboard/connection settings as well as SQL
  output; database name alone (often `postgres`) does not identify a project.
- Expected execution role is `postgres` or `supabase_admin`; the actual role
  remains unconfirmed until this query runs in that session. A service-role API
  key is not the migration execution role and is not a SQL login credential.
- Stop on any new-object collision. Do not solve it with DROP, IF NOT EXISTS,
  overwrite, or a blind rerun. Inspect migration history and object definitions.
- The reverse membership index may already exist only with the exact reviewed
  definition. Check that `rooms_room_key_unique` really enforces room_key
  uniqueness; creation retry matches this exact constraint/index name.
- Re-run `group_timer_permissions_audit.sql` and compare with the already supplied
  audit: no room dependencies in profile policies/views/timer/Auth functions;
  the expiry job runs as postgres every minute and updates only profiles.
- Obtain confirmation from the owners of external/mobile/web clients, Edge
  Functions, Webhooks, workers and notification services that none uses anon or
  authenticated direct room access. Repository searches cannot establish this.
- Confirm no deployment is in progress; use a short low-traffic maintenance
  window. Keep group endpoints inaccessible until postflight is complete.
- Save a SHA256 of the exact reviewed migration (PowerShell `Get-FileHash
  -Algorithm SHA256 <path>`). Review/record a stable API build as well: the current
  implementation is uncommitted, and this preparation does not create a commit.
- Verify backup/restore availability. Securely export the exact existing
  generator definition, owner/ACL, table/column grants, RLS flags and policies,
  default privileges, and both legacy room records (including keys). Save an
  equivalent baseline for profile/timer/notification definitions. Do not put
  codes, tokens, backups or DSNs into Git/chat/logs. A count alone cannot prove
  legacy rows are unchanged. Schema dumps must retain ACL information.
- Prepare test accounts A, B and C, real short-lived JWTs from the target project,
  and a dedicated physical device/Push Token. Never use service_role as a user JWT.
  Registration, token registration and timer tests are writes: not run now.
- Choose connection/secret handling. Do not put a DB password on a command line;
  use an approved connection service/password mechanism. Do not print JWTs.

## Application after explicit approval

Use one approved method; never run SQL Editor and CLI application independently.
The file already contains BEGIN/COMMIT. Do not wrap it in another transaction.

For a dedicated psql session, the following is a FUTURE command, not run now:

```powershell
psql -X --set=ON_ERROR_STOP=1 --dbname "$env:IMAHIMA_MIGRATION_DSN" --command "SET lock_timeout = '5s'; SET statement_timeout = '60s';" --file supabase/migrations/20261111000000_group_management_mvp.sql
```

The DSN must NOT contain a password (for example, use an approved `service=...`
entry with a separately protected password mechanism). Environment expansion
does not hide a password if it becomes part of a process command line. Both
timeouts are session-only. `-c` and `-f` run in the same psql process/session.
Use a direct or approved session connection, not an unknown transaction-pooler
configuration that could lose session settings. Exit this session afterward.
Five seconds/60 seconds are conservative initial values, not production sizing
guarantees. Do not terminate other sessions to force the migration through.

Alternatively, use SQL Editor to execute the complete reviewed file once. Its
BEGIN is already followed by these transaction-local settings; do not add a
second BEGIN or duplicate the settings:

```sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
```

Keep the rest byte-for-byte equivalent, including its existing COMMIT. Execute
the complete batch once with no unrelated SQL. Never edit old timer migrations.
Record successful application and the checksum through the agreed migration
history process. A manual psql/SQL Editor application does not automatically
register a Supabase CLI migration version; reconcile that record separately
before any later CLI deployment, with approval, rather than replaying the file.

## Postflight before group traffic

1. Run `supabase/tests/group_mvp_postflight.sql`. General-role table permissions
   and both RPC execute permissions must be false. service_role DML/execute must
   be true; profile SELECT must remain available. Both RPCs must be INVOKER with
   empty search_path and the expected owner. Compare ACLs with the preflight
   snapshot for all other roles too, including PUBLIC/default-granted roles.
2. Compare legacy room IDs, names, keys and memberships with the baseline. No
   legacy value or new marker should have changed before smoke writes/traffic.
3. Compare profiles/Auth trigger/timer function definitions and privileges, and
   the scheduled expiry job, with the baseline. Do not invoke mutation RPCs as a
   way to inspect them. Confirm the API build and DB belong to the same project.
4. Verify REST sees the new functions. A transient schema-cache failure is not a
   reason to reapply a committed migration; diagnose it before opening traffic.
5. If any check fails, keep group traffic blocked and use the recovery decision
   tree below. A partially checked deployment is not a green light.

## Real-JWT API smoke tests (only after approved application)

Use the deployed HTTPS API URL and existing dedicated accounts. In a private
PowerShell session, set `$groupApiBase` and `$env:IMAHIMA_GROUP_JWT_A/B/C` securely.
The tokens must not be echoed, stored in this repo, or embedded in URLs.

```powershell
$groupHeadersA = @{ Authorization = "Bearer $env:IMAHIMA_GROUP_JWT_A" }
$groupHeadersB = @{ Authorization = "Bearer $env:IMAHIMA_GROUP_JWT_B" }
$groupHeadersC = @{ Authorization = "Bearer $env:IMAHIMA_GROUP_JWT_C" }
$groupCreated = Invoke-RestMethod -Method Post -Uri "$groupApiBase/groups" -Headers $groupHeadersA -ContentType 'application/json' -Body (@{name='MVP smoke test'} | ConvertTo-Json)
$groupId = $groupCreated.group.id
$groupJoined = Invoke-RestMethod -Method Post -Uri "$groupApiBase/groups/join" -Headers $groupHeadersB -ContentType 'application/json' -Body (@{invite_code=$groupCreated.invite_code} | ConvertTo-Json)
$groupMembers = Invoke-RestMethod -Uri "$groupApiBase/groups/$groupId/members" -Headers $groupHeadersA
```

Store results privately and check the full matrix; do not print the created
object because it contains the invitation code. Capture HTTP status with the
client's response/error handling (PowerShell versions differ).

| Action | Expected |
| --- | --- |
| No Bearer / invalid JWT | 401; no group mutation |
| A creates | 201; 32 lowercase hex key; A auto-joined |
| A and C list | A sees its group; C does not |
| C reads members/invite or leaves | 404 |
| B joins / repeats join | 201 / 200; only one membership |
| A/B get members | 200; both profiles, shared effective state, no code |
| A retrieves invite | 200; same original code |
| B retrieves invite | 403 |
| Body includes forged user_id | Cannot choose creator/joining identity |
| Invalid code, repeated attempts | 400 then 429 with Retry-After; use test accounts |
| B exits, then A exits | 204 each; new room archived, never deleted |
| Archived code reused | 400 |
| General JWT/anon direct RPC or rate-table access | Denied, not successful |

Do not use the two legacy rooms for write smoke tests. Legacy six-character
compatibility was tested in isolation; if a live test is wanted, approve its
membership side effects separately. Offset pagination is not a snapshot.
On an ambiguous timeout after create, inspect A's list before retrying: create
has no idempotency key. Leave-created test data becomes an archived record; do
not delete it or real legacy data as cleanup without separate approval.

## Existing-feature smoke tests

Use only dedicated test identities/device and an approved data-change scope.

| Feature | Verification |
| --- | --- |
| Auth registration | New dedicated Auth user gets exactly one matching profile; username/default and initial OFF are correct. Check confirmation requirements. |
| Availability toggle | POST `/profiles/me/is-free/toggle` with A's user JWT: ON creates ~1-hour deadline, OFF clears it. Read after each step. |
| Timed ON / re-ON | Through the existing supported server/UI route, confirm a fresh deadline after expiry; do not expose management timer RPCs to clients. |
| Extension | Existing extension flow adds exactly 30 minutes to an active timed deadline; expired/OFF/unlimited are handled as the confirmed contract. |
| Automatic expiry | Observe a naturally expiring dedicated timer and the next minute job; OFF plus NULL deadline. Allow scheduling delay; do not change cron or force real users' expiry. |
| Group display | Same dedicated profile displays the same effective state across joined groups; member GET does not mutate stored timer state. |
| Push Token registration | Existing physical-device flow calls upsert_device_token; token belongs to the test Auth user and registers/re-registers normally. |
| Automatic Push/notification extension | Exercise the existing supported notification flow on the test device, if such a deployed flow exists; compare delivery/extension behavior with baseline. Token registration alone is not an end-to-end Push test. |

The current checkout exposes only toggle and Push registration; the server routes
for other deployed timer/notification flows have not been supplied. Their owner
must identify the real route/worker before these smoke steps can be executable.
Never send a service key to a device or call an arbitrary mutation RPC as a user.
The old repository toggle SQL must not be applied to make the smoke test pass.

## Failure and recovery

### Error before COMMIT

The target migration is transactional, including the ordinary CREATE INDEX.
On SQL error, stop. In SQL Editor explicitly ROLLBACK if the session is in an
aborted transaction; psql with ON_ERROR_STOP exits and disconnects. Verify the
new table/functions/columns are absent and the original generator/ACLs match
the baseline. Do not assume success from a partial success message. Resolve the
cause (collision, permissions, lock contention) before considering a rerun.

### Disconnect/timeout with unknown commit outcome

Do NOT blindly rerun. Reconnect read-only and check new objects, definitions,
ACLs and migration history. Determine whether COMMIT completed. API create
timeouts likewise require checking membership/list before a repeat request.

### COMMIT succeeded, but postflight/smoke fails

ROLLBACK cannot undo an already committed migration. Block new group traffic
and preserve created rows. Prefer a separately reviewed forward correction.
If permissions/generator must be restored, use the exact saved preflight ACLs,
RLS flags and generator definition in a separately approved transaction; do not
guess broad GRANT ALL or grant management RPCs to authenticated as a workaround.
Restoring general room grants can re-expose new records, so first review who can
read them. Do not DROP columns/tables/functions, use CASCADE, or delete archived
rooms/history as an automatic rollback. Whole-database restore requires its own
approval because it may lose unrelated Auth/timer/Push changes since the backup.

Keep role/project identification, checksums, timestamps and sanitized errors for
the incident record; never include JWTs, invitation codes, credentials or Push
tokens. No executable down-migration is provided without the actual baseline.
