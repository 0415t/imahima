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

Apply `supabase/migrations/20261006000000_toggle_profile_is_free.sql` to the Supabase project before using the endpoint. The function toggles one `profiles.is_free` value atomically.

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

## Set the current user's availability explicitly

Apply `supabase/migrations/20261104000000_profile_free_until.sql` to the Supabase project before using the endpoint. The function sets `profiles.is_free` explicitly and manages a timer via `free_until`.

```http
PUT /profiles/me/is-free
Authorization: ****** access token>
Content-Type: application/json

{ "is_free": true, "duration_minutes": 60 }
```

- 新規ONまたは期限切れ後の再ONで時間を指定すると、`free_until` が現在時刻+指定時間に設定される
- `duration_minutes` の許可値は 30, 60, 120, 180。省略または `null` はタイマーなしの無期限ON（`free_until: null`）になる
- 既に有効なON状態で再度ONを指定した場合、指定時間にかかわらず既存の `free_until` を維持する。無期限ONもそのまま維持する
- `is_free: false` を設定すると、`free_until` が `null` になる
- 有効判定は `is_free = true AND (free_until IS NULL OR free_until > now())`。期限切れの場合は `is_free: false` が返る

成功時のレスポンス:

```json
{ "is_free": true, "free_until": "2026-11-04T18:00:00.000Z" }
```

無期限ONの成功時は `{ "is_free": true, "free_until": null }` が返る。

## Send a test push notification

Apply `supabase/migrations/20261017000000_create_user_device_tokens.sql` and sign in on a physical device so the Expo Push Token is stored in `user_device_tokens` before using the endpoint.

```http
POST /notifications/test
Authorization: ****** access token>
```

The server validates the access token with Supabase Auth, fetches only the authenticated user's device tokens, and sends a fixed test notification via the Expo Push API. The request body cannot specify a destination user or push token.

- `200 { "sent": 1 }` — accepted by the Expo Push API (push ticket `status: "ok"`)
- `200 { "sent": 0, "message": "No registered devices" }` — no registered devices
- `401` — missing or invalid access token
- `429` — rate limited (one successful test notification per user per minute; failed sends and users without devices do not consume the limit)
- `502` — failed to send to the Expo Push API

Tokens reported as `DeviceNotRegistered` in push tickets are deleted from `user_device_tokens`. Set `EXPO_ACCESS_TOKEN` in `server/.env` to authenticate against the Expo Push API (optional but recommended). Never expose it to the Expo app.

**Known limitation / future work:** delivery is only confirmed at the push-ticket stage. A ticket `status: "ok"` means the Expo Push API accepted the notification, not that the device received it. Delayed verification via push receipts (`getPushNotificationReceiptsAsync`) and cleanup of tokens that fail at the delivery stage are future work.

Run the endpoint tests without connecting to Supabase or Expo:

```powershell
npm run test:notifications
```

## Explicit integration and live push tests

`npm test` runs the tests under `tests/`. The following scripts live under
`integration/` and run only when explicitly selected. Each command loads `.env.test`.

- `npm run test:integration:extend`: requires the API on `localhost:3000`, Supabase
  app credentials (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`),
  `TEST_EMAIL`, `TEST_PASSWORD`, and `ALLOWED_TEST_EMAILS`. The test account must
  initially be OFF with `free_until: null`.
- `npm run test:integration:free-end`: requires the dedicated local Supabase on
  port 55321 with migrations applied, `SUPABASE_URL`, and
  `SUPABASE_SERVICE_ROLE_KEY`. It changes DB fixtures and mocks Expo Push delivery.
- `npm run test:integration:push`: requires the API on `localhost:3000`, Supabase
  app credentials, `TEST_EMAIL`, `TEST_PASSWORD`, and registered device tokens.
  This command sends a real push notification to the test user's devices.

The existing `npm run test:login` and `npm run test:persistence` commands also run
scripts under `integration/`, outside normal test discovery. They continue to load
`.env` via dotenv and require the Supabase app credentials and test account above.
