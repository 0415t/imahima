# Node.js API server

## 暇ON時のグループメンバー通知（member_free）

既存の `PUT /profiles/me/is-free` とtoggle RPCからの実効OFF→ONをDBトリガーで検出します。
`rooms` / `room_members` の共通所属者のうち、その時点で実効ONのユーザーだけを保存します。
本人・OFF・期限切れは除外し、複数roomにまたがる同じ受信者もイベントごとに1件です。
有効なONへの再ON・30分延長・OFFではイベントを作りません。期限切れ後の再ON、
短時間でのOFF→ONは新しいイベントです。toggleは従来どおり生のフラグを反転するため、
APIの再試行が必要な操作は明示的なPUTを推奨します。

### DB適用（事前承認を得た専用ローカルDBのみ）

既存12本の後に `supabase/migrations/20261112000000_member_free_notifications.sql` を適用します。
新規空DBでは全マイグレーションをファイル名昇順に適用してください。
Supabase Authのスキーマ・ロールとpg_cronの初期化が前提です。既存DBのresetは不要です。
本番・リモート接続や既存プロジェクトDBへの適用はこの検証手順の対象外です。

PowerShellで、接続先が作成済みの専用ローカルDBであることを確認してから実行します。
接続例のポート・DB名は自身の検証環境に合わせ、既存Supabaseのポートは指定しないでください。

```powershell
# 認証情報は履歴に直書きせず、必要ならpsqlのパスワードプロンプトを利用
$env:MEMBER_FREE_TEST_DB_URL = 'postgresql://postgres@127.0.0.1:55432/imahima_member_free_test'
psql -X --dbname=$env:MEMBER_FREE_TEST_DB_URL -v ON_ERROR_STOP=1 -1 -f supabase/migrations/20261112000000_member_free_notifications.sql
psql -X --dbname=$env:MEMBER_FREE_TEST_DB_URL -v ON_ERROR_STOP=1 -f supabase/tests/member_free_notifications.test.sql
```

SQLテストはトランザクション内でfixture作成・遷移・対象抽出・障害注入・lease・再試行・権限を確認し、
最後にROLLBACKします。`auth.users`の確認日時列に依存しません。
別接続による実並行テストも用意しています（psqlがPATH上に必要）。

```powershell
# 子psqlは非対話実行。必要な場合だけ環境変数のURLにローカル専用認証情報を設定する。
# loopbackホスト・imahima_*test*というDB名・空の通知イベントテーブルを必須とする。
npx tsx --test tests/test-member-free-concurrency.ts
```

接続先未指定では並行テストはskipします。既存の権限テスト・通知延長SQLテストも専用DBで回帰確認してください。
今回のマイグレーションは一度だけ適用する追加マイグレーションです（再実行による重複CREATEはエラー）。

### ジョブ起動とAPI確認

`server/.env` の `MEMBER_FREE_NOTIFICATIONS_ENABLED=true` で送信ジョブを有効化します。
既定は無効です。イベント作成はDBトリガーにより常時行われ、有効化後に有効な送信待ちを処理します。
既定の間隔は5秒、バッチ20件、lease120秒、最大試行3回です。
`MEMBER_FREE_NOTIFICATIONS_INTERVAL_MS` と `MEMBER_FREE_NOTIFICATIONS_MAX_ATTEMPTS` で調整できます。
プロセス終了時には終了前通知ジョブと両方の停止を待ちます。

```powershell
node --env-file=server/.env --import tsx server/index.ts
```

外部送信の前に、必ずローカルDBのSQLテストとモック単体テストを完了してください。
実送信には別途承認・Expo認証設定・受信端末のToken登録が必要です。
承認後のAPI確認では、ローカル専用ユーザーA/Bを同じroomへ追加し、Bを先にONにします。
AがOFFの状態から、Aの認証トークンで以下を送ります（本文から他人のIDを指定できません）。

```http
PUT /profiles/me/is-free
Authorization: Bearer <ローカル検証ユーザーAのアクセストークン>
Content-Type: application/json

{"is_free":true,"duration_minutes":30}
```

ジョブ無効のまま `member_free_events` と `member_free_notifications` にA→Bが1件できること、
再ONで増えないことを確認できます。有効化後はBの登録端末へ `member_free` / `eventId` / `notificationId`
付きで「〇〇さんが暇になりました！」を送ります。名前が空なら「メンバーが暇になりました！」です。
受信者抽出関数 `member_free_recipients(actor, room_ids)` は独立しており、将来のroom選択に利用できます。
現在のトリガーはroom_ids未指定で全所属roomを対象にします。

### 状態遷移・再試行・制約

- `profiles.free_period_id` はDBが管理するON期間識別子。延長時は維持し、OFF/期限切れ→ONで更新します。
  発信者・受信者それぞれの期間IDを保存し、別のON期間に古いイベントを送らないようにします。
- ON更新・イベント・受信者の保存は同一トランザクションです。保存エラーはON更新ごとロールバックします。
  Push処理は確定後に行うため、送信失敗でONを取り消しません。
- 送信待ちは `UNIQUE(event_id, recipient_user_id)` で重複排除。claimは `FOR UPDATE SKIP LOCKED` とlease tokenを使います。
  発信者/受信者の実効ON・同じON期間・共通roomをclaim時と送信直前に確認します。
- 受信者ごとに登録端末へ送信します。1件以上の受付成功は `sent` とし、残りの端末へ再送しません（既存A方式）。
  `accepted_count` と失敗分類の集計を保存します。端末単位の履歴は保存せず、レシート監視も対象外です。
- 受付0件で恒久失敗のみは `cancelled`。一時失敗/結果不明は `failed`、5秒から最大300秒の指数バックオフで再試行し、
  最大回数では `exhausted`。停止中のprocessingはlease切れ後に再取得します。
- 再検証と外部送信は別処理のため、その間のOFF/退会による競合は完全には排除できません。
  Expo受付後の停止・完了記録失敗・結果不明の再試行でも重複し得ます。`sent` は受付成功であり端末配信完了ではありません。
- ジョブ無効中のoutboxも蓄積します。履歴の保存期間・削除ジョブは未実装です。運用時は滞留・exhaustedを監視してください。
- フロントのONボタン・グループ選択・通知設定・通知タップ遷移は今回変更していません。

モック単体テスト（Supabase/Expoへの外部接続なし）：

```powershell
npx tsx --test tests/test-member-free-notifications.ts tests/test-push-notification-service.ts tests/test-free-end-notifications.ts tests/test-profile-toggle.ts tests/test-notifications.ts tests/test-extend-from-notification.ts tests/test-free-end-action.ts
npx tsc --noEmit
```

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

- `is_free: true` を設定すると、`free_until` が現在時刻+指定時間に設定される
- `duration_minutes` は省略可能（デフォルト: 60）。許可値: 30, 60, 120, 180
- `is_free: false` を設定すると、`free_until` が `null` になる
- 有効判定は `is_free = true AND free_until > now()`。期限切れの場合は `is_free: false` が返る

成功時のレスポンス:

```json
{ "is_free": true, "free_until": "2026-11-04T18:00:00.000Z" }
```

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
