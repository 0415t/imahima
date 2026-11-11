# ローカルDB検証結果（2026-11-11）

ユーザー承認に基づき、新規専用リソースのみで検証した。本番・共有DBへの接続なし。

## 環境

- Docker Desktop 4.60.1 / Engine 29.2.0
- Image: `public.ecr.aws/supabase/postgres:17.11.0.011`
- Container: `imahima-member-free-test-db`
- Volume: `imahima-member-free-test-data`
- Active network: `imahima-member-free-test-host-net`
- 未使用で保持したネットワーク: `imahima-member-free-test-net`（internalではポート転送されないため切替）
- DB: `imahima_member_free_test`
- Publish: `127.0.0.1:55439` → container `5432`
- Supabase CLI・ホストpsqlはインストールせず、イメージ内psqlを使用。
- `anon`, `authenticated`, `service_role`, `supabase_auth_admin`, `auth.users`, `auth.uid()`を確認。
- `pg_cron 1.6.4`, `pgcrypto 1.3`, `uuid-ossp 1.1`を確認。
- `cron.database_name`は専用DB名へ設定。auto-expireジョブも専用DBを参照。

## 結果

- 全13マイグレーションをファイル名順に適用成功。
- SQL: member_free_notifications / profile_write_permissions / extend_from_notification / free_end_notification_claims の4本成功。
- 実DB並行テスト: 1件成功、skipなし。同時ONのイベント重複防止と独立claimワーカーの二重取得防止を検証。
- 通知ワーカーのモックテスト: 17件成功、skipなし。
- 終了時のauth.users / profiles / member_free_events / member_free_notificationsは各0件。

## 修正と再実行

- 新規SQLテストの変数idと列idの曖昧参照を列修飾で修正。
- 旧通知SQLテストは、ログインを検証しないためemail_confirmed_at依存を除去。Authトリガー作成済みプロフィールはUPSERTで更新。
- 並行テストに専用コンテナ固定のDocker実行モードを追加。Docker起動オーバーヘッドにより初回30秒で時間切れとなったため、このモードのみ120秒に変更。再実行は約30.2秒で成功。
- モックテスト初回はサンドボックス内のos.userInfoでENOMEM。権限拡張下で再実行して成功。

PowerShell（Docker API権限が必要）:

```powershell
$env:MEMBER_FREE_TEST_DB_URL = 'postgresql://supabase_admin@127.0.0.1:55439/imahima_member_free_test'
$env:MEMBER_FREE_TEST_DOCKER = '1'
node --import tsx --test tests/test-member-free-concurrency.ts
```

Dockerモードは固定の専用コンテナ内のUnixソケットを使う。ホスト公開ポートを経由する並行テストではない。
SQLの再実行時は最新のsupabaseディレクトリを専用コンテナの`/tmp/imahima-supabase`へコピーし、`docker exec`のpsqlで各tests/*.test.sqlを実行する。適用済みマイグレーションを再適用しない。

## 影響と検証範囲

既存コンテナの停止・再起動・削除、既存ボリュームの変更、既存DBへのSQL実行は行っていない。既存DBは稼働を継続。新規専用リソースは削除せず保持した。

この環境はDBイメージ同梱のAuth初期スキーマを使用し、GoTrue/Auth HTTP・PostgREST・APIサーバーは起動していない。現行Authサービスによる追加マイグレーション、ログイン、API経由の動作、実端末へのPush配信は未検証。モック以外の外部Push送信なし。
