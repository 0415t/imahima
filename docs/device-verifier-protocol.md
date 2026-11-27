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
120 requests total, 60 per socket source IP, and 30 per source/installation
pair. The server ignores forwarded IP headers in this limiter. After
verification, challenge issuance allows eight successful writes per
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
