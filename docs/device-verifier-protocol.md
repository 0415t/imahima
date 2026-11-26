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
binary. Expo Go and web report `unsupported`. The JS API only exposes
`getIdentity`, `createInstallation`, and `signDeviceProof`. The native module
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
