# Node.js API server

## Setup

Copy `.env.example` to `.env` and set the server-only Supabase values.

```powershell
Copy-Item server/.env.example server/.env
npm run server
```

Health check: `http://localhost:3000/health`

`SUPABASE_SERVICE_ROLE_KEY` must only be used by this server. Never put it in the Expo app or commit it to Git.

## Run with Docker Compose

Create `server/.env` from the example and fill in the Supabase server credentials, then start the API:

```powershell
Copy-Item server/.env.example server/.env
docker compose up --build --renew-anon-volumes
```

The API listens on `http://localhost:3000`. Check `http://localhost:3000/health`. Compose passes `server/.env` to the container at runtime; the Docker build excludes local env files. Changes under `server/` restart the development server automatically.

The API container uses Node.js 22 to meet the Node.js engine requirement of the resolved Supabase client dependency.

## Toggle the current user's availability

The endpoint requires the existing `toggle_profile_is_free` function. The historical
`20261006000000_toggle_profile_is_free.sql` does not include the current live timer
semantics; do not replay it onto the live project. See the confirmed timer contract below.

```http
POST /profiles/me/is-free/toggle
Authorization: Bearer <Supabase access token>
```

The server validates the access token with Supabase Auth, derives the profile ID from the authenticated user, and returns the updated state:

```json
{ "is_free": true }
```

Run the endpoint tests without connecting to Supabase:

```powershell
npm run test:profile-toggle
```

## Group management MVP

Implementation uses existing `rooms`, `room_members`, and `profiles`. `users`,
availability mutations, timers, extensions, and push registration are unchanged.
The migration is **not applied automatically**. Review existing policies, grants,
role checks, dependent functions and external clients before applying
`supabase/migrations/20261111000000_group_management_mvp.sql` in a separate,
approved deployment. It requires the existing tables, profile columns and the
`rooms_room_key_unique` unique index/constraint described in the schema audit.

All endpoints require a Supabase Bearer token:

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/groups` | `{ "name": "Friends" }` -> 201 `{ group: { id, name }, invite_code }` |
| POST | `/groups/join` | `{ "invite_code": "..." }` -> 201, or 200 when already joined; `{ group }` |
| GET | `/groups` | `{ groups, next_offset }`; no invitation codes |
| GET | `/groups/:id/members` | `{ members: [{ id, username, is_free, free_until }], next_offset, evaluated_at }` |
| GET | `/groups/:id/invite-code` | `{ invite_code }`; current membership AND original MVP creator required |
| DELETE | `/groups/:id/members/me` | 204; repeat requests return 404 after membership is gone |

Lists accept `limit` (1..100, default 50) and `offset` (0..100000, default 0),
ordered by UUID. Offset pagination is intended for small groups; membership
changes between pages can shift results. It is not a snapshot cursor.
Invalid input/code returns 400, invalid auth 401, creator-only denial 403,
missing membership/room 404, missing profile 409, exhausted quota 429 with
`Retry-After: 60`, and unavailable dependencies 503. Responses are not cached.

Create and join each enforce a persistent 60-second quota of 5 requests/user and
30/IP, shared across API instances. Malformed code attempts count. Limiter
failure denies access. Set a stable `GROUP_RATE_SECRET` shared by instances;
otherwise the server service-role key is used as the HMAC key. Stored limiter
keys contain no raw IP or invitation. Expired limiter entries are pruned on use.
Express does not trust forwarded IP headers. Behind a proxy all requests can
share the proxy's quota; configure a validated proxy topology before changing
this behavior. Authentication happens before these quotas, so an edge limit is
also recommended for unauthenticated traffic.

New codes are 32 lowercase hexadecimal characters from UUIDv4 (122 random bits).
This deliberately favors stronger entropy over the earlier 10-character idea.
Existing mixed-case six-character keys remain case-sensitive and unchanged.
Only room-key unique collisions are retried, up to three attempts. Creation and
creator membership are one transaction. Do not automatically retry a timed-out
creation: the first request may already have committed; check the group list.

`mvp_created_by` and `mvp_archived_at` are nullable additions; no existing row is
backfilled. Last-member departure archives only a newly-created MVP room, retains
the room/key for future history, and rejects later joins. No room is deleted.
Legacy rooms have no known creator, so this API cannot recover their keys and
does not archive them. A creator who has left cannot retrieve the key; other
members can continue sharing an already-known code. No ownership transfer or
code rotation is included. Auth-account deletion can leave an empty room and
sets its creator reference to NULL; automatic cleanup is intentionally deferred.

The service role is server-only. Express checks membership before ID-scoped RPCs;
the RPC rechecks inside a room lock, including creator-only invitation retrieval.
Join and leave serialize on the room row. Direct anon/authenticated table grants
are revoked and service RPC execution is restricted to service_role. Table-level
REVOKE also removes corresponding column privileges. Inherited grants and
SECURITY DEFINER functions still need a predeployment audit; this
migration does not silently drop unknown functions or policies.

### Confirmed timer contract

The database owner confirmed: `set_profile_is_free` supports unlimited ON with a
NULL deadline and resets the deadline when turning expired availability back ON;
`extend_profile_is_free` extends only active timed ON by 30 minutes from its
existing deadline; `auto_expire_free_status` turns OFF at `free_until <= now()`
and clears the deadline. The live toggle sets a one-hour timer on ON and clears
the deadline on OFF. These definitions were reported by the owner, not fetched
as full function bodies by this implementation.

Member reads use `coalesce(is_free, false) AND
(free_until IS NULL OR free_until > now())`. They never invoke expiration,
extension, or mutation functions. NULL is_free is displayed as OFF. An expired
row still awaiting cleanup is displayed OFF without changing its stored values.
`evaluated_at` is the same transaction-start time used for the predicate, matching
the existing expiration contract. `statement_timestamp()` was replaced: in a
multi-statement/long transaction it advances while `now()` stays fixed. A new API
transaction reevaluates time; lock waits do not advance that transaction's epoch.

The temporary `GROUP_TIMER_POLICY`/`timerPolicyVerified` gate has been removed;
authorized member reads execute without an environment override. Missing RPCs,
DB outages and permission failures still return 503. Deploying the reviewed
group migration remains required; removing the gate does not install the RPC.

Historical drift: `20261006000000_toggle_profile_is_free.sql` only flips is_free
and leaves free_until untouched. It is not the current live toggle definition.
Do not replay that historical function onto the live DB. It has been left
unchanged, as have all existing timer and Push functions. A reproducible fresh
database needs an independently reviewed export of the exact live timer SQL;
the behavioral summary is not sufficient to reconstruct its full implementation.

The group migration revokes direct anon/authenticated access to rooms and
room_members; profile/device-token privileges and timer RPC privileges are not
changed. This can still affect an existing SECURITY INVOKER notification function
that reads rooms as an authenticated user. Audit actual owners, execute/table/
column grants, policies, triggers, and job roles before deployment using the
read-only `supabase/tests/group_timer_permissions_audit.sql`. SECURITY DEFINER
and service-role paths must also be checked with their actual execution role.
No production permission or Push end-to-end compatibility is claimed without
that audit; no timer/Push specification is changed to work around permissions.

### Local verification

HTTP tests do not use Supabase:

```powershell
node --import tsx --test tests/test-profile-toggle.ts tests/test-groups.ts
```

For DB verification use an **empty isolated database only**. Load, in order:

1. `supabase/tests/fixtures/group_mvp_schema.sql` (minimal test-only existing schema).
2. `supabase/migrations/20261111000000_group_management_mvp.sql`.
3. `supabase/tests/group_mvp.test.sql` (assertions roll back their data).
4. `supabase/tests/group_availability.test.sql` (expiry boundaries, NULL,
   expired/re-ON/extended states, transaction time and read-only invariants).

Use `psql -v ON_ERROR_STOP=1 -f <file>`. Do not load the fixture into a real
Supabase project. It is not a full schema backup and does not reproduce unknown
production policies, triggers, role checks, timer jobs, or Push behavior.
For concurrency tests, use the fixture/migration in a `postgres:16` container
named `imahima-group-mvp-verification`, with `--network none` and temporary data:

```powershell
node tests/test-group-db-concurrency.mjs
```

The script refuses an unexpected image or network, then verifies leave/join,
simultaneous departures, and shared quota races. Its own records are cleaned up.
An authenticated end-to-end test on a disposable Supabase instance with exact
live timer functions and notification jobs, plus a production policy/dependency
audit, remain release prerequisites. The fixture tests model confirmed output
states; they do not execute or replace the production timer functions.
