# Windows manual backup before Group MVP

Status: PROCEDURE ONLY. The production backup itself must not run until the user
has reviewed this procedure and explicitly approves acquisition. No production
migration, data/permission/configuration change, registration or Push send is
part of backup acquisition. Restoration is a separate, explicit approval.

## Choice and prerequisites

Prefer PostgreSQL `pg_dump` custom format for an unfiltered database archive,
with separate role and audit exports. This includes Auth data instead of treating
a public-only export as a complete backup. Supabase CLI default schema dumps
exclude managed schemas including auth/storage, and require separate data/role
exports and managed-schema customizations. Do not assume a CLI schema dump alone
protects Auth users or the trigger on auth.users.

Current workstation: Docker is available; pg_dump/pg_restore/psql and a standalone
Supabase CLI were not found on PATH. The native commands below require installing
the matching PostgreSQL client tools first (not performed). A containerized
matching client is an alternative, but its network access and password-file
permissions must be prepared before acquisition. No software is installed here.

Read `show server_version;` in SQL Editor. Use clients with the SAME PostgreSQL
major version as production, and a current minor release. Newer pg_dump can dump
older servers, but older pg_dump cannot dump newer servers. A successful list
operation is not a successful restore test.

Use Dashboard Connect details: direct connection when reachable, otherwise the
documented session pooler endpoint (usually 5432; use actual Dashboard values),
not transaction pooling. An API/service-role key is not a database password.
Verify project identity. Use SSL, ideally verify-full with the provided CA.
`sslmode=require` encrypts but is not equivalent to CA/hostname verification.

## Saved scope and limitations

| Artifact | Contents and limits |
| --- | --- |
| database.dump | One consistent pg_dump snapshot of dumpable DB schema and data: public profiles/rooms/room_members/users/device tokens, auth users/identities and other Auth tables, sequences, functions, constraints, indexes, policies, triggers, ACLs/default privileges. Extension-owned objects/config data have extension-specific dump behavior. Any permission/unsupported-object failure stops acquisition; do not silently exclude Auth or ignore errors. |
| roles.sql | Cluster role definitions/membership, without role passwords. Not a Supabase platform administrator clone; managed role export/restore can be restricted. Owner/grantee identities must exist to restore ACLs. |
| permissions-audit.txt | Table/column grants, policies, timer/Push definitions and triggers from the read-only audit. Supplement with actual Auth trigger, dependency, role and default-privilege preflight output. |
| extensions.csv / cron-jobs.csv | Extension versions and schedule/role/command configuration. Export cron separately if present; do not assume extension-owned tables are included by pg_dump. Commands can contain secrets. |
| manifest | Project identity, timestamps, client/server versions, command options, exit codes, SHA256 hashes, snapshot limitations, verification results. No passwords. |

The DB archive is logical, not a physical/PITR backup or a backup of all hosted
Supabase infrastructure. It does NOT save Storage file bytes, Edge Function code
and secrets, Auth provider/SMTP/redirect settings, API/JWT signing configuration,
Expo/Firebase/APNs credentials, or external workers. Record/export these securely
by their service-specific methods if disaster recovery requires them. A URL in
avatar_url is not an image backup. Auth sessions may require reauthentication
after a project/signing-key change. Vault/encryption-backed data may require
original encryption material or a provider-supported migration process.

Keep schema/data/roles together. Do not pass --no-acl or --no-owner on acquisition.
Do not create a partial dump with only rooms and assume profiles/Auth are covered.
Separate audit/role/cron exports are not the same snapshot as database.dump.
Record their capture times; avoid concurrent DDL/permission changes. Timer jobs
continue normally and are NOT paused. Comparing a live row count later is not
proof of the archive snapshot's counts.

## Storage and secrets

Prefer an encrypted, access-restricted location OUTSIDE the repository, plus an
encrypted offline/independent copy. Compression/custom format is not encryption.
If using this repo, use only `.local-backups/<timestamp>/` (now ignored). All
roles.sql, CSV, logs, manifest and credential files must also stay in that ignored
folder or outside the repository. Existing tracked files remain tracked despite
.gitignore; check `git ls-files -- .local-backups backups '*.dump' '*.backup'`.
Never use git add -f. Never paste dumps/credentials/Auth rows/Push Tokens in chat.

On Windows, libpq supports `%APPDATA%\postgresql\pgpass.conf` or PGPASSFILE. Use
an exact host:port:database:user entry and a private Windows ACL. `:` and `\` in
passwords require escaping. This file is plaintext; keep it outside Git and
restricted to its intended user. Alternatively use an interactive password
prompt. No password belongs in the command line, DSN or shell history.

## Acquisition AFTER approval (not executed)

Use a dedicated PowerShell session. Configure PGHOST, PGPORT, PGUSER and
PGDATABASE from the approved target; PGSSLMODE and optionally PGSSLROOTCERT from
the verified TLS settings. Use PGPASSFILE, not a password-bearing URL. The example
creates local files and reads production; it does not write production data.

```powershell
$backupStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path (Get-Location) ".local-backups/$backupStamp"
New-Item -ItemType Directory -Path $backupRoot -ErrorAction Stop | Out-Null
$env:PGHOST = '<approved host>'
$env:PGPORT = '<approved direct/session port>'
$env:PGDATABASE = 'postgres'
$env:PGUSER = '<approved database user>'
$env:PGSSLMODE = 'verify-full'
$env:PGSSLROOTCERT = '<absolute CA certificate path>'
$env:PGPASSFILE = '<absolute private pgpass.conf path>'

pg_dump --version
pg_restore --version
pg_dump --format=custom --verbose --lock-wait-timeout=5s --file "$backupRoot/database.dump" 2> "$backupRoot/pg_dump.log"
if ($LASTEXITCODE -ne 0) { throw 'Dump failed; not a usable backup' }
pg_dumpall --roles-only --no-role-passwords --file "$backupRoot/roles.sql" 2> "$backupRoot/roles.log"
if ($LASTEXITCODE -ne 0) { throw 'Role export failed; investigate before declaring backup complete' }
psql -X --set=ON_ERROR_STOP=1 --file supabase/tests/group_timer_permissions_audit.sql --output "$backupRoot/permissions-audit.txt"
if ($LASTEXITCODE -ne 0) { throw 'Audit export failed' }
psql -X --set=ON_ERROR_STOP=1 --file supabase/tests/group_mvp_preflight.sql --output "$backupRoot/preflight.txt"
if ($LASTEXITCODE -ne 0) { throw 'Preflight export failed' }
psql -X --set=ON_ERROR_STOP=1 --command "COPY (SELECT extname, extversion, extnamespace::regnamespace FROM pg_extension ORDER BY extname) TO STDOUT WITH CSV HEADER" --output "$backupRoot/extensions.csv"
if ($LASTEXITCODE -ne 0) { throw 'Extension inventory failed' }
```

If cron.job exists, additionally export with psql --output, not PowerShell `>`:

```sql
COPY (
 SELECT jobid,jobname,database,username,schedule,active,command
 FROM cron.job ORDER BY jobid
) TO STDOUT WITH CSV HEADER;
```

If any required object/data cannot be dumped with the available Supabase role,
STOP and inventory the exact missing scope. Do not grant extra production rights,
change replication_role, disable RLS/jobs, or exclude the failing scope silently.
A roles-only failure must be resolved with an approved manual role/membership/ACL
inventory before claiming recoverability. Do not use db pull/push/reset as backup.

Never pipe a binary custom dump through PowerShell `>`/Out-File. Always use
pg_dump --file (or write inside the container to a bind-mounted backup directory).
Avoid overwriting an earlier backup; use a fresh timestamp directory.

## Verification AFTER acquisition

```powershell
pg_restore --list --file "$backupRoot/archive-list.txt" "$backupRoot/database.dump"
if ($LASTEXITCODE -ne 0) { throw 'Unreadable archive' }
Get-Item "$backupRoot/database.dump", "$backupRoot/roles.sql" | Select-Object Name,Length
Get-FileHash -Algorithm SHA256 "$backupRoot/database.dump", "$backupRoot/roles.sql", "$backupRoot/permissions-audit.txt", "$backupRoot/extensions.csv" |
  Export-Csv -NoTypeInformation -Encoding UTF8 -Path "$backupRoot/checksums.csv"
```

Review pg_dump.log/roles.log for warnings, missing/unreadable tables and extension
issues. Check the archive TOC for TABLE DATA auth.users, auth.identities, every
other Auth table required by this project's auth schema, profiles, rooms,
room_members, user_device_tokens; also the four live timer FUNCTION entries,
generate_room_key, upsert_device_token, Auth registration TRIGGER, RLS policies,
ACL/default ACL and relevant sequences. Zero-row tables still need DATA entries.
If an expected item is extension-owned, document its alternate preservation and
restore path instead of marking it passed. Do not print data SQL to the console.

An archive listing and SHA256 establish structure/file identity, not full
recoverability. A restore rehearsal with row/constraint/permission checks is
required before calling this a verified backup. Retain the original archive;
inspect/adjust restoration copies or a pg_restore TOC list, not the only backup.

## Restoration rehearsal (never production by default)

Use a NEW isolated instance with the same PostgreSQL major and required
Supabase-compatible extensions/roles. No production credentials/configuration,
no outgoing network, no public ports, no active cron worker. Restoring timer/Push
triggers/jobs can have side effects, so a production-connected clone is unsafe.
An ordinary postgres image may fail for Supabase-specific extensions; that is a
test limitation, not permission to ignore restore errors. Use a compatible
Supabase Postgres image and configure workers disabled BEFORE loading cron data.

1. Inspect roles.sql and create the required roles only in the new test cluster.
   Reserved/managed roles already provided by the target must be reconciled, not
   blindly recreated. Owner/role membership/ACL checks are part of the rehearsal.
2. On an empty compatible target, inspect the archive's pre-data/data/post-data
   plan. Restore schema, then data with user triggers suppressed ONLY on the
   isolated target, then constraints/triggers/policies/ACLs. Auth.users INSERT
   must not auto-create duplicate profiles while profile data is being loaded.
3. A representative pg_restore command for an already prepared EMPTY compatible
   target is below. It uses a separate connection explicitly, not the source
   PGHOST/PGUSER environment. It is NOT a guaranteed one-command hosted-Supabase
   restore; managed-schema/extension conflicts require a reviewed TOC plan.

Future command after the target/TOC/role review (no --clean/--create):

```powershell
pg_restore --dbname "service=imahima_restore_test" --exit-on-error --single-transaction --disable-triggers --verbose "$backupRoot/database.dump" 2> "$backupRoot/restore.log"
if ($LASTEXITCODE -ne 0) { throw 'Restore failed; do not treat partial state as a verified backup' }
```

The service entry must resolve only to the isolated target and provide sufficient
target-only privileges. Trigger suppression needs elevated target permissions;
it is never applied to the production connection. With extension-managed Auth
objects precreated by Supabase, selective data/schema restoration and custom Auth
trigger recreation must follow the Supabase restore procedure; a raw archive
cannot be blindly loaded on top of a running hosted project.

4. Verify restored Auth IDs/profiles correspondence, legacy room IDs/keys and
   membership pairs, is_free/free_until, device-token ownership, constraints,
   function definitions, trigger enablement, grants/default grants and policies.
   Compare to the captured snapshot where available, not later live counts. The
   original backup must include metadata across the acquisition interval if
   exact cross-export equality is required.
5. Do not send Push, run expiry jobs or restore production cron jobs active in
   the rehearsal. Inspect job rows as configuration, and enable only after a
   separate approved real recovery/deployment plan. Auth service credentials and
   login behavior require a matching local Supabase stack; SQL row recovery alone
   does not prove login/session or notification delivery functionality.
6. Record success/errors in the private manifest and destroy only the dedicated
   test environment after inspection. No source database changes are needed.

For an actual post-migration incident, prefer restoring the affected generator/
ACLs from the baseline or a forward fix. Whole-database restoration can discard
unrelated Auth/timer/Push changes since the backup and requires separate approval.

## Official references

- https://www.postgresql.org/docs/current/app-pgdump.html
- https://www.postgresql.org/docs/current/app-pgrestore.html
- https://www.postgresql.org/docs/current/libpq-pgpass.html
- https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
- https://supabase.com/docs/reference/cli/supabase-db-dump
