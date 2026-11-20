# Chat message Push notifications (Issue #36)

## Scope and confirmed behavior

This is the backend implementation. Notifications target only the other members
of the message's room who are effectively ON at the recipient-selection snapshot
inside the new-message transaction. HTTP arrival time and worker execution time
are not used to add recipients later. No notification aggregation is performed.

The existing `chat_send_message` transaction and `(sender_id,client_message_id)`
deduplication remain unchanged. A `created` message event trigger inserts the
recipient outbox rows in that same transaction. Any outbox error aborts the
message and event as well; the caller retries the SAME client_message_id. A
deduplicated retry never inserts another message/event/outbox row. Do not replay
historical migrations or regenerate notifications for old messages.

The new forward migration adds:

- `room_members.push_membership_id`, generated on insertion and when room/user
  identity changes. Role-only changes preserve it; direct replacement is refused.
  Existing memberships receive generations without changing their original data.
- `chat_message_notifications`, unique by message/recipient. The recipient's
  free_period_id and membership generation are captured once. No message body is
  copied into the outbox. The sender's display name IS captured (bounded to 2000
  codepoints before display formatting), including for use after Auth deletion.
- Private generation, enqueue, eligibility and deletion-cancellation functions;
  public claim/validate/complete RPCs accessible only to service_role.

OFF then ON, or leaving and rejoining, cannot reactivate an old notification.
Extending the current ON period and changing a membership's role do not replace
its generation. Validity checks require the original room to remain unarchived,
the message to remain undeleted, and the recipient's current membership, ON
period and effective deadline to match. They do NOT require the sender to remain
ON, remain a member, or retain an Auth account. Auth deletion keeps messages via
the existing sender_id SET NULL behavior; the approved saved name is still used.

Logical message deletion cancels all unsent pending/failed/processing rows in
the deletion transaction. The final validation fetches the current body only if
the message is undeleted. It does not resurrect a deleted body from a snapshot.

## Deadline, leases and acceptance

expires_at is fixed to the original message.created_at plus five minutes. At the
deadline (including equality) no new claim/reclaim or send is allowed. Reclaim
checks eligibility again; a new lease token invalidates the previous worker.
Backoff is 5 * 2^(attempt-1) seconds, at most 300 seconds, and is capped at the
expiry rather than extending it. Default maximum attempts is three (1..10).

The worker validates before token lookup and again immediately before sending.
The send budget is bounded by the request timeout and the DB-reported remaining
lease/notification lifetime, minus the entire validation roundtrip and a 25ms
safety margin. Agent/socket abort and later-chunk suppression use the existing
Push service. An optional absolute Expo expiration is passed through; the service
also stops starting chunks past this deadline. Legacy callers keep their existing
30-second send budget and message fields.

An expired notification loses send eligibility; expiration is not a five-minute
physical-deletion policy for audit rows. State cleanup is performed by claim or
completion, not by a new Cron job. Unsent terminal states are cancelled, expired
or exhausted. Retention/physical purging is a separate operational policy.

One confirmed Expo acceptance completes the WHOLE recipient, including partial
device success. Accepted counts survive send/cleanup timeout and stop abort. A
fresh bounded signal records confirmed acceptance even after the send signal is
aborted. Completion with the same token can record an already-confirmed send
after cancellation/expiry/exhaustion; this does NOT authorize another send.
Only the current retained token can do this: an older token from before a lease
reclaim is rejected. Repeating the same sent acknowledgement/count succeeds
without changing its original count or timestamps; different counts or other
terminal-state updates are rejected. This is a server-trusted historical
acceptance record, not proof from a client or permission to send again.
Unknown/temporary results with zero confirmed acceptance
are retried within the original deadline; permanent-only failures are cancelled.

| Current state | Completion | Rule |
|---|---|---|
| processing | sent | Current token and positive confirmed acceptance; expiry does not erase historical acceptance |
| cancelled / expired / exhausted | sent | Same retained current token and positive confirmed acceptance; never grants send eligibility |
| sent | sent | Same token and identical count returns true without updating the row |
| sent / cancelled / expired / exhausted | failed or cancelled | Rejected; terminal state cannot restart retries |
| any | any | Superseded or unrelated token is rejected |

Exactly-once external delivery is not guaranteed. A provider acceptance followed
by a lost response, crash or failed DB completion can cause duplicate delivery.
Eligibility changes after the last DB check cannot recall in-flight/accepted
notifications. Provider expiration limits queueing, but does not remove a
notification already displayed on a device. `sent` means Expo acceptance, not
device delivery. Push receipts are not added in this issue.

## Payload contract with frontend Issue #34

Display: title `imahima`; body `<saved sender name>: <message preview>`.
The display-only formatter replaces line breaks with spaces, strips control and
bidi override/isolate characters, and truncates at Unicode grapheme boundaries:
name at most 40 graphemes/400 UTF-8 bytes; preview at most 80 graphemes/2400 bytes.
An ellipsis marks truncation. Empty/unrepresentable values use safe labels.
The serialized message is rejected above 3500 UTF-8 bytes to reserve wrapper
headroom under the provider's 4096-byte ceiling. Original stored text is unchanged.

`data` has exactly these routing fields:

| Field | Value |
|---|---|
| version | 1 |
| type | chat_message |
| roomId | message room UUID |
| messageId | message UUID |
| notificationId | recipient outbox UUID |

No tokens, JWTs, names or full message text are put into data or application logs.
The frontend must authenticate, validate IDs/type/version, recheck current room
access through the existing APIs, then navigate to that room's chat screen.
Logged-out launches must wait for authentication; deleted/inaccessible rooms or
messages must not reveal cached private content. Never treat payload as authority
or execute a route URL supplied by a notification. The actual chat screen and
tap handler are NOT implemented here (user-approved backend-only scope, #34).
The existing free_end notification action remains unchanged.

## Configuration and permissions

`CHAT_MESSAGE_NOTIFICATIONS_ENABLED=true` opts in; otherwise the worker is off.
`CHAT_MESSAGE_NOTIFICATIONS_INTERVAL_MS` defaults to 5000 (integer 1000..2147483647).
`CHAT_MESSAGE_NOTIFICATIONS_MAX_ATTEMPTS` defaults to 3 (integer 1..10).
Enabled-worker configuration is validated before listening. Each claim requests
one row with a 120-second lease. After processing/completion returns, the worker
immediately claims the next row, up to 20 per cycle. Empty/error responses or a
stop request end the cycle; overlapping cycles are suppressed. Waiting work is
not leased and consumes no attempts. DB backoff/max-attempt rules are unchanged;
a failed completion leaves the row leased until recovery, not immediately due.
Each dependency call has a 10-second budget, and
worker stop has a 5-second budget inside the existing server's shutdown budget.

RLS is enabled on the outbox, no client policies or Realtime publication are
added, and even service_role has no direct table access. The three public RPCs
are restricted SECURITY DEFINER functions with empty search_path. Private helpers
are not callable by application roles. Existing H1-H4 grants are not broadened.
Do not put service credentials in the frontend or enable a worker against a DB
which has not received the new migration through an independently approved plan.

## Verification

- PR #40 review fixes (2026-11-21): before fixing, a final-attempt lease sweep
  changed a row to exhausted and rejected its retained token's sent completion.
  The original unresolved barrier exited a standalone child with status 13 and
  skipped cleanup. The repaired barrier has normal, early-finish, rejection and
  timeout unit coverage. A deliberately early-finishing real worker in an
  isolated PG17 fixture now fails with status 1 and reaches worker/DB cleanup.
- Lease revision verified on 2026-11-21: `npm test` reported 275 passed,
  3 skipped, 0 failed (278 total). The dedicated chat mock suite has 24 tests.
  The isolated PG17 runner passed 20 groups: the previous 16 DB groups, one
  old-batch reproduction, and three real-worker/DB scenarios with mock Push.
  The latter are partial component integration, not an HTTP/Auth/PostgREST
  end-to-end path. Full type checking and scoped lint/diff checks are separate.
- `npm test`: mocked HTTP/worker/transport and existing regressions; no live Push.
- `node tests/test-chat-message-db.mjs`: requires an explicit ISSUE36_PG_BIN
  pointing to PostgreSQL17 binaries. Creates a unique fresh cluster under ignored
  `.runtime`, clears inherited PG/Supabase connection settings, binds only
  127.0.0.1 on a fresh port, and verifies its data_directory before tests.
  Applies real historical application migrations/H1-H4 then the new migration,
  using nonsuperuser postgres and independent service_role connections. Synthetic
  auth.uid/users and inert Cron fixtures replace platform services. The server
  is stopped in finally and results are retained. No .env or shared DB is used.
  Additional scenarios connect the real worker to the isolated RPCs with a mock
  Push transport: waiting-work preservation during a blocked send, parallel
  workers, and backoff. Old batch behavior is reproduced inside a rolled-back
  transaction. Preceding lease expiry is simulated in the fixture instead of
  sleeping for 120 seconds. Auth/PostgREST/HTTP remain outside these scenarios.
- This does not validate a real Auth HTTP service, Realtime delivery, real
  Supavisor, mobile tap navigation, devices or external Push delivery. Existing
  Issue #35 evidence and the retained B environment must not be overwritten or
  repurposed. Shared migration application, worker enablement and real Push
  require separate authorization.
