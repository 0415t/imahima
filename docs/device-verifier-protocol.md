> MVP implementation note: the normal logout/deployment contract below supersedes the historical phase notes later in this document. Special automatic recovery is inactive in the application and default Express router. Existing SQL and native signing formats remain for compatibility and regression evidence.

## MVP normal logout and controlled-test Push

Apply migrations 24 through **38**, in ledger reconstruction order, before starting this release. Do not edit or replay applied migrations. Stop old workers, registration traffic and manual send routes before the permission changes; deploy the updated Express server, verify its dedicated connections, and then start only the intended workers. Resume device traffic with the matching native client. Migrations 37 and 38 must precede the new client: old SQL requires independent Auth confirmation before ack. On failed/unknown commit, stop and audit history plus objects before retrying; never grant raw token access as a workaround.

Normal logout is: durable user/session-scoped request (before draining registration/provisioning) -> durable local intent -> signed begin (Push fence and receipt committed atomically) -> successful Supabase local-scope Auth response -> durable clear checkpoint -> exact-session local cleanup and notification cutoff -> signed ack -> remove local journal. The default client does not discover receipts or independently confirm Auth absence. A lost Auth response is retried only with the same surviving session; missing keys/JWT, corrupt scope or a legacy confirm checkpoint stays blocked for explicit diagnosis. Never infer success from a missing session. Keep the device key, installation ID and receipt until ack is confirmed. Ack response loss is safely retried with a fresh challenge.

Migration 37 adds `client_cleanup_acknowledged_at`, separately from verified `auth_revocation_confirmed_at`. A signed ack attests client cleanup, not server-observed Auth revocation, and cannot un-fence Push. New-generation creation requires the previous generation fenced and either the historical confirmation or its completed client-cleanup receipt; an open receipt still blocks creation. Session-scoped fences remain permanent. Exact recorded registration results remain queryable for the bound session only (a different session of the same account is not enough). New registration locks Auth user before Auth session; installation-first locking remains in place.

The public recovery router accepts only ack and ack challenge issuance by default. `automaticRecovery=true` is used solely by explicit archived regression construction, never by the production entrypoint. Historical `confirm`/`discover` code and tables are not deleted. The historical suite can be selected with `IMAHIMA_ARCHIVED_RECOVERY_TESTS=1`; it reconstructs through migration 36 and is not evidence for the new normal flow. `npm run test:login` now exercises the current app state machine with real isolated GoTrue, PostgREST, Express and all migrations. Native keys are test adapters, not hardware verification. Issue #50 remains open for native builds/devices; Issue #53 covers special account-deletion recovery.

Push ownership finding #31 remains unresolved. Sender names, chat bodies, navigation and notification extension are retained **only on managed test devices and synthetic accounts**. No Push ownership verification is claimed. All normal sends fail closed unless all of these hold:

- `NODE_ENV` is not `production`.
- `PUSH_DELIVERY_MODE=controlled-test` is explicitly set.
- `PUSH_CONTROLLED_SUPABASE_URL` matches the configured `SUPABASE_URL` origin.
- The exact destination token SHA-256 appears in the comma-separated `PUSH_CONTROLLED_TOKEN_SHA256` operator allowlist.

Never configure this exception on an internet-public deployment. Public deployment must set `NODE_ENV=production`, omit the controlled-test settings, and verify zero outbound Push requests. Production mode denies even if an old allowlist was copied. Missing/invalid settings deny all targets. The allowlist is not token ownership proof and must be maintained outside client requests, using only operator-controlled devices. It does not restrict login/logout. The three worker enable flags retain their existing defaults. Authorization, event-time checks, per-page reauthorization, deadlines and snapshot-based invalid-token deletion remain active. Denied targets are not deleted. Outbox work may be cancelled without delivery while blocked; do not expect later automatic replay.

Already-authorized external requests cannot be recalled after a fence. Existing access JWTs can remain valid until expiry outside the session-checked APIs. Native compilation, device behavior and Hosted privileges remain unverified. No backup/restore automation is introduced; operating without backups carries unrecoverable-data risk and any shared application needs separate approval.

### Review 37?44 follow-up

- Startup explicitly reads Auth independently of `INITIAL_SESSION`; a rejected read or returned error ends loading in a retryable error screen. It never converts a read error into a normal signed-out state. Unmounted/stale reads cannot publish session state.
- `logout-v2-request` records only the target user ID, session ID and operation ID before waiting for device work. Startup treats its presence as pending logout. The normal fence still follows the in-flight work drain; all markers are retained until ack. If the process ends before server fencing, a server-side token may remain and delivery is still possible. A request write failure also cannot guarantee durable intent after process loss; the current process stays blocked and offers retry.
- Migration 38 checks any uncleared receipt on the installation before generation admission/reuse. The existing INSERT trigger already rejects actual new rows in that state; the new check makes the RPC entry match logout and covers early-return paths explicitly. Generationless and Auth-confirmed-but-unacknowledged receipts both block; ack releases the next session without fabricating Auth absence.
- Android explicitly calls `FileDescriptor.sync()` before `AtomicFile.finishWrite()`; sync exceptions reach failWrite and are rethrown. Readback remains to catch rename failures. Native compilation and power-loss/fault injection are not verified in this environment (Issue #50).
- Review #39 (last confirmed registration vs rejected replacement after response loss) is deferred until before production Push enablement. #41 (Auth success + checkpoint failure + subsequent JWT loss) remains an intentionally blocked special recovery case. Neither is described as fixed.
- Review #40: normal terminal session expiration with a retained binding still blocks. The minimal next step is an explicit expired-session diagnosis plus an operator procedure that verifies the exact user/session/generation, fences its registration and independently checks Auth state before any scoped local cleanup. No forced local unlock, null-session inference, new account switch or automatic signed recovery is implemented. Same-account reauthentication is only a possible later restricted flow, requiring separate design approval.

### Targeted signed-enrollment race regression (#25, #35)

Run from PowerShell against a newly created isolated stack (no shared credentials):

```powershell
$env:IMAHIMA_ENROLLMENT_RACE_ONLY = '1'
try { npm run test:login } finally { Remove-Item Env:IMAHIMA_ENROLLMENT_RACE_ONLY }
```

Do not combine this selector with `IMAHIMA_MVP_LOGOUT_ONLY` or archived-recovery mode. It exercises a signed enrollment paused before commit, a competing signed logout rejection, successful enrollment/retry and a stable logout receipt. The test observes a real lock wait beyond 3.5 seconds using `pg_stat_activity`, rather than sleeping to establish race ordering. A test-only connection facade gives that deliberate wait bounded 20-second statement / 30-second transaction limits, and the race-only trigger disables its lock timeout. Production keeps 1500ms lock / 3000ms statement limits. Changing a timeout inside the trigger alone would not reliably replace the deadline of the already-running statement. Verified locally on 2026-11-28: the command passed (1 test, zero failures) with the lock-wait assertion enabled. This is not native-device evidence. The 7-second driver query timeout remains an additional bound; the barrier is released after the observed 3.5-second threshold and the competing signed request.

The retained historical receipt-identity regression runs separately with `node --import tsx --test tests/test-device-logout-recovery-integration.mjs` and intentionally reconstructs through migration 36. It reads the committed recovery ID before retrying; it is not evidence that special automatic recovery is enabled in the MVP. Current registration/SQL-holder diagnostics run with `node --test tests/test-device-registration-recovery-integration.mjs` on the complete ledger. Existing constraints #31/#39/#40/#41 remain as documented above; these test changes do not implement recovery or enable production Push.

### Review 45-54: development MVP boundary

Authenticated device API configuration is checked before Auth starts, including when the installation has an existing clean marker. JWT-bearing requests still require HTTPS; the local development HTTP exception remains bearer-free only. Invalid present notification cutoff values fail closed. UI subscriber errors do not interrupt authentication/logout state transitions. A new logout target is checked against the retained binding/bootstrap before it is persisted. A pending scoped request prevents the clean-marker no-op from reporting logout success. Direct-read denial tests explicitly assume `imahima_device_verifier` inside a transaction, verify current_user and roll back between denied reads.

The following **review findings**, not new Issue updates, are deferred:

- #50: committed begin reply plus JWT loss remains blocked; no automatic signed operation discovery is added.
- #51: the initial enrollment global challenge cap (4096, with per-user 8 and 60-second expiry) remains a known availability limit. Large-scale/many-account abuse protection is outside this controlled development MVP.
- #52: the Android checkpoint source test does not yet detect every possible omission of the readback comparison. The production Kotlin comparison/failure branch remains intact. Native compilation, hardware and power-loss verification are still not proven by that static test.
- #53: the signed enrollment race still inherits the pool's 7-second client query timeout. It is a remaining test reliability limit even though the server-side deliberate barrier bounds were extended and the targeted run passed; no client-timeout change is included in this release.

Earlier constraints #31 and #39-41 remain unresolved as stated above. Controlled test destinations and production Push prohibition are unchanged. No migration or shared DB changes are required for these fixes.

### Review 55-64 follow-up

- #56: registration state read failures reject so the existing UI backoff retries them. Logout/account-change cancellation remains a non-retryable cancellation. Notification-action recovery (#59) is not changed.
- #57: INT-CHAT-PUSH is implemented through real JWT, Express, DB and worker with only final Expo HTTP mocked. Its manual isolated evidence is separate from baseline CI results; CI-branch matrix edits must preserve both facts.
- #60: recovery-only session reads also re-read after the SDK's actual AuthSessionMissingError class. Ordinary reads, transient errors and unrelated Auth errors retain their existing behavior. An empty re-read is not server revocation evidence and cannot advance begin/revoke checkpoints.
- #64: failed extension tests count onChanged calls and assert zero after the operation; a callback assertion cannot be swallowed by the client under test.
- #58: recovery challenge issuance obtains a new Date header from the same-origin /health route for each attempt, using no-store requests/responses and a random query nonce. The signed issuedAt format, server freshness window, signature verification and single-use challenges are unchanged. Missing/invalid time, cached Age or HTTP/network failure rejects before signing and can be retried. Phone time is not used; delayed responses outside the existing server window still fail safely. Native/device and deployed proxy-cache behavior remain unverified.
- #55: Android icon/background work is separate; no icon configuration is changed here.
- #59: transient notification-extension action recovery remains deferred; actions stay blocked on uncertain session/storage state.
- #61: before shared migration application, measure real row counts/statement times and pause all readers and writers. This is a separate pre-deployment audit; no shared DB is queried or changed here.
- #62: consumed device challenges still count toward the current issuance cap until expiry. Temporary 429/logout delay remains a known MVP limitation; no quota/migration change is included.
- #63: account-deletion vs acknowledgement lock-order races remain deferred to Issue #53. No Auth-table mutation or special deletion recovery is introduced.

Previously recorded #31/#39-41 and review #50-53 remain unresolved. Production Push prohibition, scoped fences and the normal Auth-success completion contract are unchanged.

---

# Device verifier API v1

Express mounts `POST /device-recovery/:action` when
`DEVICE_VERIFIER_DATABASE_URL` is configured. Each request uses JSON
(at most 4 KiB, without compression) and a Supabase Auth bearer token for the
configured project. The server verifies its signature, expiry, exact issuer,
audience and role before opening a DB transaction. User and session IDs come from
the verified token. The token's issuer is the configured Supabase origin plus
`/auth/v1`.

| Action | Body fields in addition to `installationId` | Successful response |
| --- | --- | --- |
| `enrollment-challenge` | `publicKey` | `nonce`, `expiresAt` |
| `enroll-installation` | `publicKey`, `nonce`, `signature` | `keyVersion` |
| `challenge` | `keyVersion`, `purpose`, caller-generated `nonce`, `signature` | Server-generated `nonce`, `expiresAt` |
| `enroll` | `keyVersion`, `nonce`, `signature` | `result` (generation as a decimal string) |
| `register` | `keyVersion`, `nonce`, `signature`, `generation`, `operationId`, `token`, `platform`, optional `deviceName` | `result` (durable operation result) |
| `fence`, `lookup` | `keyVersion`, `nonce`, `signature`, `generation`, `operationId` | `result` (durable operation result; lookup may return null) |
| `confirm-auth-revocation` | `keyVersion`, `nonce`, `signature`, `generation`, `operationId` | `result.status`: `pending` or `confirmed` |

Generate a random installation UUID. Use lowercase canonical UUID strings and
positive decimal strings without leading zeroes for PostgreSQL bigint fields.
`purpose` for challenge issuance is one of `enroll`, `register`, `fence`,
`lookup`, and `confirm_auth_revocation`. A challenge request uses 32 fresh random bytes as its client nonce.
For all other signed requests, use the server nonce for the corresponding action.
Public keys, nonces and signatures use unpadded base64url. The P-256 public key
is the 65-byte uncompressed SEC1 point `04 || X || Y`, with 32-byte
big-endian coordinates. The signature is ECDSA with SHA-256 over the bytes
below, represented as 64 bytes `r || s` with 32-byte big-endian scalars.
On Apple platforms use the raw signature representation. If an Android provider
returns ASN.1 DER from `SHA256withECDSA`, decode the two integers and
left-pad each unsigned magnitude to 32 bytes.

Concatenate the following fields in order. Each non-null field is encoded as its
UTF-8 byte length in ASCII decimal, ASCII `:`, then its UTF-8 bytes. Null is
two ASCII bytes `-:`. There are no separators, BOM or final newline.

1. `imahima-device-proof-v1`
2. JWT issuer, user ID, session ID
3. Installation ID, action, purpose (the action itself except for `challenge`)
4. Key version (use `1` for `enroll-installation`)
5. Generation and operation ID (both null outside `register`, `fence`, `lookup`, `confirm_auth_revocation`)
6. Nonce in its canonical base64url form
7. Expo token, platform, and device name (null outside `register`)
8. Public key in its canonical base64url form (null outside `enroll-installation`)

Device names must be NFC and contain no Unicode category C characters, with
at most 128 UTF-16 code units. An empty name encodes as `0:`.

After a lost enrollment response, request a fresh enrollment challenge using
the same installation and key, then sign again. An existing version-1
installation with the same key is accepted. A competing key is rejected.
After a lost register or fence response, use a fresh challenge and keep the
original operation ID and payload. Alternatively, use a fresh lookup challenge
for the same operation and generation. Lookup requires the installation key and
the original account. Its RPC permits a new session for that account. Register
requires the session bound to the generation. Fence also permits a new session
of the same account with a fresh proof and operation ID, or the original
session and operation ID for an idempotent retry. Registration accepts
`ios` and `android` as platforms.

Bootstrap challenges expire in 60 seconds. Issuance deletes expired rows and
allows at most eight unexpired challenges per account and 4096 globally,
including consumed challenges. Signed operational challenge issuance allows 16
unexpired challenges per installation, including consumed challenges, and
prunes expired rows for that installation. Keep the endpoint behind the normal
HTTPS ingress rate limits. DB quotas bound live challenge rows, while ingress
limits also protect authentication and connection-pool capacity. Inactive
installations can retain expired operational challenge rows until issuance resumes.

Provision a dedicated PostgreSQL 17 login `imahima_device_api_login` outside
the migration. Use `NOINHERIT`, no elevated role attributes, and grant only
`imahima_device_verifier` with `ADMIN FALSE, INHERIT FALSE, SET TRUE`. Grant
no direct object rights. For a remote database, require TLS with certificate
and hostname verification and inject the complete URL using server secret
management. Keep the verifier role outside the PostgREST authenticator
role memberships. The migration creates no login or password. Every request
uses a bounded transaction and sets the verifier role locally. A registered
public key is row-locked for verification and execution on the same connection.

`confirm-auth-revocation` uses `confirm_auth_revocation` for both the
challenge purpose and the signed action. Generation and operation ID are
both included in the signature. The verifier confirms absence on the primary
database after fencing and records the observation atomically. It never signs
out a session itself. Pending means the old row is still present. Retry with
a fresh challenge for the same generation and operation ID. After confirmation
the result is durable and can also be read with a fresh lookup proof.

### Deployment prerequisite

Apply migration 27 and configure `DEVICE_VERIFIER_DATABASE_URL` in Express
before deploying this release. `POST /profiles/me/is-free/extend-from-notification`
returns HTTP 503 when the dedicated DB connection is unconfigured or
unavailable. Every verifier request and notification-based extension validates
the currently presented session on the primary. This does not cancel admitted
requests, revoke JWT signatures, or change other Express routes, PostgREST
policies, or Realtime authorization.

Run the dedicated integration with local Docker images and no shared environment configuration.

```sh
node --import tsx --test tests/test-device-verifier-integration.mjs
```

The test uses GoTrue for actual user JWTs, a dedicated PostgreSQL role for
Express, and PostgREST to confirm that clients cannot reach the private
functions. The stack applies migrations from the ledger on a newly verified DB.

## Native installation keys

`modules/device-key` is a local Expo module and requires a rebuilt native
binary. Expo Go and web report `unsupported`. The JS API exposes
`getIdentity`, `createInstallation`, `signDeviceProof`, and
`signLogoutRecoveryProof`. The native module
derives the installation ID and public key from its own record and assembles
the signed protocol fields. For confirmation, pass the canonical signed action
`confirm_auth_revocation`. It is mapped to `confirm-auth-revocation` on the wire.
The caller generates challenge-request nonces using a cryptographic RNG.

On iOS, Security.framework creates a permanent, device-only Secure Enclave key
referenced by a private Keychain tag. CryptoKit converts the ECDSA signature
to the raw format. On Android, the module uses a private Android Keystore alias.
On Android 12+ (API 31+), it only accepts the explicit TEE and StrongBox
levels. On Android 7–11 (API 24–30), the platform's
`KeyInfo.isInsideSecureHardware()` must positively confirm hardware backing.
The module reports `secure-hardware` in that case because the API does not
identify the hardware type. A false result, an unknown level on API 31+,
or a failed lookup supplies no proof and blocks key use. Android Keystore may create a candidate key on
unsupported hardware. The module leaves it unregistered and never signs with it.
Protection information is local diagnostic data and carries no attestation.

Each platform atomically writes a reservation and an installation marker in
backup-excluded storage before generating a key. The module serializes
initialization and lookup in the app process. It only exposes the identity after
writing and rereading the public-key fingerprint. A reserved identity can
finish using the same alias after process interruption. A missing marker,
malformed record, mismatched fingerprint, or missing ready key blocks signing
and replacement. A fresh installation with no local records uses a new UUID
and never enumerates or adopts old Keychain items. Loss of both files is
indistinguishable from a fresh installation, so any new identity is unrelated
to the old server-side registration.

## Logout recovery database contract

Migration 28 adds the following private functions. The Express routes and
native signing methods below implement this contract.

1. For `begin_device_logout`, use the existing device-verifier role. Verify a
   live JWT and the installation signature, then consume a `begin_logout`
   challenge. The signed request must bind the authenticated actor/session,
   installation, key version, generation and stable caller operation ID.
   The DB fences the generation, deletes its managed token rows, and creates
   the recovery and operation result in the same transaction. The caller may
   attempt GoTrue local revocation after it has recovered this result.
2. For recovery calls, use a separate login eligible to assume only
   `imahima_logout_recovery_verifier`. Migration 28 provisions no login or
   runtime membership. PostgreSQL can give the migration owner an automatic
   administrative membership without SET or INHERIT. Lock the key, verify the signature, and execute the relevant
   function in the same transaction. Never convert a client-supplied flag or
   nonce digest into a proof of signature verification.
3. For issuance, require a signed, recovery-specific request. Pass purpose
   `discover` with a null recovery ID, or `confirm`/`ack` with the explicit
   opaque ID. The database binds the generated 60-second challenge to that
   purpose, key version and one recovery. It permits at most 16 outstanding
   or consumed unexpired recovery challenges per installation. Normalize
   unavailable responses and apply rate limits at the HTTP boundary.
4. For consumption, use a separate recovery signature domain from the JWT
   API. Bind the project, installation, version, action, exact purpose,
   explicit ID or discovery null marker, and challenge. The DB independently
   enforces the same shape and consumes the challenge once. A discovery proof
   only returns the latest generation's recovery; if that generation changes,
   previously issued discovery proofs cannot disclose its previous recovery.

`discover` returns only an opaque recovery ID and `pending`, `confirmed`, or
`cleared`. `confirm` checks the old session on the primary and persists
confirmation on the existing binding. Errors leave both the result and the
challenge consumption uncommitted. `ack` requires confirmed Auth revocation
and signifies that the client has completed local cleanup. The client retries
with a new challenge and the same opaque recovery ID. Confirmation and
acknowledgement are monotonic. A cleared exact-ID replay returns only the
terminal receipt and cannot alter a newer generation.

New generations remain blocked until the client acknowledges local cleanup.
The installation row serializes challenge consumption, binding checks, and
recovery writes. Recovery records keep the original key version. They do not
support automatic key replacement. Recovery rows have no time-based cleanup.
The existing binding is their lifecycle parent and retains the user/session
association. Discovery failure alone cannot establish successful logout.

### Recovery HTTP API

All routes use POST and JSON. `/device-recovery/begin-logout` uses the normal
Bearer JWT and existing v1 signature encoding. The signed action and purpose
are both `begin_logout`. Its body is `installationId`, `keyVersion`,
`generation`, `operationId`, `nonce`, and `signature`. Obtain the nonce from
`/device-recovery/challenge` with purpose `begin_logout`. It returns
`{"result":{"recoveryId":"<uuid>"}}`.

| Path under `/device-recovery/recovery` | Additional fields | 200 response |
| --- | --- | --- |
| `/challenge` | `purpose` (`discover`, `confirm` or `ack`), signed `issuedAt` in Unix seconds as a decimal string, and `recoveryId` for confirm/ack | `nonce` and UTC `expiresAt` |
| `/discover` | No additional fields | `result` with `status` and `recoveryId` |
| `/confirm`, `/ack` | `recoveryId` | `result` with `status` and `recoveryId` |

All four limited routes require `installationId`, `keyVersion`, `nonce` and
`signature`. Omit `recoveryId` for discovery and omit `purpose` and
`issuedAt` when consuming. The issuance nonce is 32 bytes from the client's
CSPRNG. The remaining routes use the returned server nonce. No bearer token,
user ID or session ID is needed on this path. Request limits are 2 KiB for
the recovery-only routes and 4 KiB for the JWT routes. Success and errors use
`Cache-Control: no-store`. Errors on the recovery-only path have the same
message and use 400/413 for format/size, 403 for rejected proof/target,
429 for limits, and 503 for unavailable database or configuration.

Sign the same UTF-8 byte-length framing described above using these fields,
in order. Nullable fields use `-:`. UUIDs are canonical lowercase. Sign with
P-256/SHA-256 and encode the 64-byte P1363 signature as unpadded base64url.

1. Domain `imahima-logout-recovery-v1`
2. Exact issuer (`SUPABASE_URL` origin plus `/auth/v1`)
3. Installation ID and key version
4. Action (`challenge`, `discover`, `confirm`, or `ack`) and purpose
5. Recovery ID, or null for discovery
6. Canonical base64url nonce
7. `issuedAt`, or null when consuming

After locking and verifying the key, issuance accepts at most 30 seconds
of age and five seconds of future skew. Each signed issuance body derives
one server nonce by HMAC-SHA-256. The migration's digest uniqueness prevents
duplicate issuance while the proof is fresh, even across Express instances
sharing the secret. A replay does not charge the verified installation
issuance quota. Generate a fresh client nonce after lost issuance responses.
Consumption checks the expiry and one-time use under the installation lock.

### Recovery deployment and limits

Provision `imahima_logout_recovery_api_login` separately with NOINHERIT, no
elevated attributes, and only the recovery verifier role with SET TRUE,
INHERIT FALSE and ADMIN FALSE. Inject `DEVICE_RECOVERY_DATABASE_URL` with
verified TLS and a separate `DEVICE_RECOVERY_CHALLENGE_SECRET` (32 random
bytes encoded as 64 hex digits, the same on all instances). Keep the challenge
secret stable during the issuance window across deployments. Both verifier
connections and the challenge secret must be configured before using
`begin-logout`. Confirm the limited connection is functional before rollout.
Connection errors and uncertain commits map to an error response. The next
proof can query the durable outcome after connectivity returns.

Per Express process and fixed 60-second window, the limited routes admit
60 requests per socket source IP and 30 per source/installation pair. The
server ignores forwarded IP headers in this limiter. After signature and
database validation, a shared limit of 120 applies to recovery operations.
Challenge issuance also allows eight successful writes per
installation per process/window. Typical discovery, confirmation and
acknowledgement use three issued proofs, leaving space for retries beneath
the DB cap of 16 unexpired rows per installation. Unverified traffic cannot
reserve a DB challenge or spend the installation's verified issuance budget.
The dedicated pool and concurrent DB admission are each capped at four.

For missing keys and wrong key versions the verifier runs a dummy P-256
check. Denied proofs, missing targets and lock timeouts share a generic 403
with a minimum response time of 1.6 seconds, covering the 1.5-second lock
timeout in ordinary conditions. Network delays, scheduling and database
outages can still affect elapsed time. At a reverse proxy, socket IPs can
aggregate clients. Deployment needs ingress limits by verified client
address, body/read deadlines, and aggregate limits across replicas. DB
issuance prunes expired rows for the installation it touches. Expired rows
on dormant installations can persist up to that installation's row bound.

### Native recovery signing

Use `signDeviceProof` for `begin_logout` and its JWT-bound challenge request.
Use `signLogoutRecoveryProof` for challenge issuance and each limited
recovery action. Its request includes `issuer` but carries neither JWT nor JWT
identity fields. The native module derives the installation ID from its
existing hardware-backed identity. Include that same ID and the returned
signature in the HTTP request. Build the HTTP body from the route's allowed
fields. `issuer`, `action`, and JWT identity fields are signing inputs only.
Recovery fields use their exact ASCII forms. Normal registration continues to
require an NFC device name. Both methods return a failure status when a
ready key cannot be loaded. An older native binary without the recovery
method returns `unsupported`.

`tests/fixtures/device-proof-vectors.tsv` holds the expected framed bytes
and rejected shapes for both platform codecs and the Express encoder.
`DeviceProofVectors.swift` can be compiled together with `DeviceProof.swift`
and run with the TSV path. `DeviceProofVectors.kt` runs the same corpus against
`DeviceProof.kt` with Android's Base64 API available. The Windows Node suite
checks server framing and bridge behavior. A JVM test key can verify DER-to-P1363
interoperability without depending on a mobile keystore.

### App rollout and logout journal

Before migration 33, `EXPO_PUBLIC_DEVICE_RECOVERY_ENABLED=true` selected managed-registration
rollout after deploying the Express endpoints and a compatible native build.
An existing managed binding continued using the recovery path with the flag off.

The app stores the installation, user/session IDs, generation, and a stable
begin operation ID before starting logout. Once returned, the opaque recovery
ID is also written to the backup intent. Neither the JWT nor the private key
is copied to the journal. On confirmed Auth absence it clears the matching
local Auth session and advances the notification cutoff. It then acknowledges
cleanup and waits for the cleared receipt before removing the journal.

Discovery can resume a damaged journal when the returned recovery ID matches
the durable backup. If every copy of the recovery ID is lost, the current API
does not associate its opaque result with a verifiable local generation or
account. The app keeps that case blocked. A lost generation-opening result
also stays blocked during logout, since retrying open at that point could
create a new generation. An authoritative read-only association path would
be needed to resolve these cases without guessing.
### Lost generation and recovery references

Apply migration `20261130000000_device_logout_session_fence.sql` before deploying the Express code that uses the expanded recovery functions.

- `POST /device-recovery/lookup-generation` uses a live JWT and the `lookup_generation` device challenge. It returns `{result: "<generation>"}` for the exact live binding or `{result: null}`. This observation does not cancel an outstanding request.
- `POST /device-recovery/begin-session-logout` uses a live JWT and a `begin_session_logout` challenge. The ordinary device proof generation field is null and the operation ID is required. Retrying with a new challenge and the same operation ID returns the stored `{result: {recoveryId, generation}}`. Generation is null when there was no active generation for this session. The operation installs a permanent session fence and issues a recovery case under the same installation lock used for generation creation.
- `POST /device-recovery/recovery/discover-binding` and its challenge require the same protected key and installation ID. Their existing recovery frame is extended by the following four fields in order: old user UUID, old session UUID, generation decimal or null, and session-logout operation UUID or null. Exactly one of generation and operation is supplied. The signed HTTP fields are `bindingUserId`, `bindingSessionId`, `bindingGeneration`, and `bindingOperationId`. The challenge is bound to the selected case and the exact scope. Only the latest matching case ID and status are returned.
- Public-key registration and the generation-creation checkpoint are separate. Recovery with a live JWT can repeat public-key registration for the same installation and key. It does not open a generation. When the JWT and all relevant binding proof are unavailable, the app holds logout for recovery.
- Both case types require authoritative Auth absence and a local cleanup acknowledgement. A retry after a lost acknowledgement returns the stored result. The fence stays in place after cleanup and is scoped to the old session and installation.

### Remaining verification

- Both database-level and signed Express race tests cover an uncommitted first public-key registration, a competing logout rejection, and a successful generationless logout retry after enrollment commits. Run the signed case using `IMAHIMA_ENROLLMENT_RACE_ONLY=1` as documented in the current targeted-regression section above; it passed locally on 2026-11-28. It is not native-device validation.
- The isolated legacy-session test discards PostgreSQL's COMMIT completion frame for a session logout transaction and verifies that the same operation ID recovers the committed receipt. Separate tests cover connection loss before COMMIT and loss of the HTTP reply after COMMIT.
- The cause of the earlier first-run HTTP 503 in the enrollment challenge quota test remains unidentified. Subsequent isolated runs passed.
- Native compilation and physical-device verification are tracked in Issue #50.

### Notification delivery after device fencing

Migration `20261201000000_notification_delivery_authorization.sql` replaces the worker's direct token reads with a per-page authorization RPC. The RPC derives the recipient and timestamp from the claim, locks candidate installations in UUID order, and rechecks the lease, current notification conditions, and managed binding. A page permits at most 100 Expo messages. Each subsequent page or worker retry requires its own authorization. Expo HTTP 429 does not trigger a hidden SDK retry in this path.

Member-free uses the original event timestamp and chat uses the stored message creation time. Free-end uses the claim's original creation time and also excludes managed generations created after the opening of the five-minute window. This conservative bound prevents a delayed first claim from sending to a generation opened inside that window. Legacy recipients keep their existing eligibility.

Migration 36 records the generation start after acquiring the session lock and confirming that the Auth session is live. The recorded time can precede commit. Reopening or fencing an existing generation preserves its original timestamp.

The transaction finishes before Expo HTTP starts. A fence blocks authorizations that occur after it commits. Delivery already authorized before the fence can still reach Expo. Expo acceptance does not guarantee delivery, and an interrupted worker may retry with a new lease.

Phase 6 still needs isolated fault injection for all three workers: a lost database authorization reply, lease expiration and reacquisition, and account switching while a delivery is in progress. The existing suite covers fences between claim and authorization, stale lease rejection, multiple pages and stale Expo tickets after registration updates.

During the PR #47 review regression, the first isolated run observed 99 of 103 expected member-free deliveries. The developer reported a Wi-Fi disconnection during that run. Two consecutive runs without code changes each passed all 14 tests, with 103 of 103 deliveries for each of free-end, member-free, and chat, and no duplicates or omissions. The cause of the first run's shortfall is undetermined. A causal link to the Wi-Fi disconnection has not been established.

The Expo ticket is associated with the exact registration snapshot sent in the request. A DeviceNotRegistered ticket deletes only that user, registration ID, installation, generation, registration revision and delivery version. A replacement registration gets a new delivery version, including legacy registrations with the same token string.

Before deployment, stop old workers and the old Express test-send route, apply migration 30, then deploy the updated Express process before restarting workers. The service role loses direct token reads and deletes. The authenticated manual test route can still send to legacy tokens through a limited RPC, and leaves cleanup to the lease-backed workers. Phase 6 can remove the remaining old registration, test-send and legacy data paths after the rollout. Do not regrant raw service-role token access during a rollback with managed delivery enabled.
### Legacy registration and notification extensions

Migration `20261202000000_guard_notification_and_legacy_device_sessions.sql` preserves legacy registration for live legacy sessions. A transaction-scoped session lock orders legacy writes against managed generation creation and logout. New legacy writes record their session. A managed transition is held if that session still owns a recorded legacy row. Rows already present at migration time are left intact without inferring their session.

Authenticated direct token reads and deletes are limited to the user's legacy rows and require a live JWT session. Managed tokens are only available to authorized worker delivery. Direct legacy deletes already authorized in the statement's snapshot can finish even if Auth subsequently revokes the session.

Notification extension takes a primary Auth row lock and updates availability in the same dedicated verifier transaction. If extension wins, GoTrue deletion waits for the transaction. If deletion or the logout fence wins, extension is rejected. The old service-role RPC grant is removed. Deploy compatible Express code with this migration and keep notification extension unavailable when the verifier connection cannot be used.
### Registration rejection recovery

Migration `20261203000000_persist_managed_registration_rejections.sql` records a definitive token conflict in the existing operation table. Token and reservation changes are rolled back before the rejection record is inserted. Replaying the same operation and payload returns its committed result. A different payload with that operation ID is rejected.

The existing signed `lookup` endpoint returns the registration result for the bound session. A committed rejection can clear the matching pending registration after an app restart. A missing record, a failed lookup, or a rejection of a replay alone cannot clear an unknown prior outcome. Rejections from before migration 32 without a durable record cannot be recovered retroactively. The signature format and HTTP endpoint remain unchanged.

Pause device recovery traffic, apply migration 32, deploy the updated Express server, and then resume traffic. The private lookup function now requires the verified session ID.

## Migration 33 and native-only deployment

The app always uses managed registration and recovery. Use an Android or iOS development
build with the hardware-backed key module. Key creation and installation registration
do not require notification permission. A generation and device token are only
registered when a push token is available.

The app creates a key before starting a new Auth session. A restored session with
no usable device key remains blocked. Assess signed-in development devices before
cutover and resolve any legacy session using its existing supported flow before
retiring that flow.

Stop all application access, Express instances and notification workers. Apply pending
migrations in ledger order through 32, then inspect counts of token rows with NULL
installation IDs and rows in push_private.legacy_registration_sessions. Migration 33
rechecks both in its transaction and stops if either count is nonzero. Keep those
environments paused pending an explicitly authorized decision on development data.
The migration does not assign old rows to installations or purge them.

After migration 33 commits, verify the migration history, token constraints and effective
ACLs. Configure `DEVICE_VERIFIER_DATABASE_URL`, `DEVICE_RECOVERY_DATABASE_URL`, and
`DEVICE_RECOVERY_CHALLENGE_SECRET` on the updated Express deployment. Confirm the retired
test route returns 404, then restart the three updated workers and distribute the native
build. Leave old binaries out of service. Verify
the three worker paths with simulated Expo and track real devices under Issue #50.
A delivery authorized before the fence may already have reached Expo.
