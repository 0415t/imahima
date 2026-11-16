# Current verification (retained data)

See [current backend](../../docs/group-chat-backend.md) and [safe test procedure](../../docs/group-chat-verification.md).
Run `npm run verify:current` for a read-only schema/permissions audit. It permits retained test data and does not assume fixed global user/room counts.

Original records remain local; anonymized copies are under `reports/*.public.md`.
Realtime acceptance concerns data access and delivery, not channel connection refusal. Fresh delivery to the repaired historical room remains UNTESTED.

## Historical setup instructions below (deprecated on the current stack)

Do not rerun empty-database checks, migrations or resets on the retained environment. The original instructions below remain as history.

# グループチャット用の独立ローカルSupabase

専用プロジェクト `imahima-chat-local`。Supabase CLI **3.1.0**をこのディレクトリのpackage.json/package-lock.jsonに固定する。親リポジトリのSupabase CLIリンク、`.env`、`server/.env`を使用・変更しない。

**更新:** 承認を受けたアプリ用スキーマ適用は完了した。現在の適用記録・確認方法は[SCHEMA-APPLICATION.md](./reports/SCHEMA-APPLICATION.public.md)を参照し、検証は `npm run verify:schema` を使う。以下の空スキーマに関する記述は基盤構築時点の履歴である。

**統合検証後の状態:** 実JWT/API/Realtime検証は23成功・1失敗。ユーザー/テストデータを保持しているため、現在は `npm run audit:integration` を使う。詳細と初回購読イベント欠落の未解決事項は[INTEGRATION-RESULTS.md](./reports/INTEGRATION-RESULTS.public.md)を参照する。空環境専用のverify/testを再実行してデータをリセットしない。

今回の構築範囲はSupabase基盤のみ。Auth/Realtime等が必要とするプラットフォーム初期化は実行するが、アプリ用マイグレーション・fixture・seed・テストユーザーは投入しない。

## 構成

| 対象 | 設定 |
|---|---|
| API/Kong | http://127.0.0.1:56321 |
| Auth | API配下 /auth/v1 |
| PostgREST | API配下 /rest/v1 |
| Realtime | ws://127.0.0.1:56321/realtime/v1/websocket |
| PostgreSQL | 127.0.0.1:56322 / database postgres |
| 将来のExpress用予約 | 127.0.0.1:56331（今回は起動しない） |
| Shadow DB用予約 | 56320（今回は起動しない） |
| Docker network | imahima-chat-local-net |
| DB volume | supabase_db_imahima-chat-local |

DB/Auth/REST/Realtime/Kongの5サービスを起動する。Storage、Studio、Edge Functions、Analytics、SMTP、通知ワーカーは起動しない。API/DBのホスト公開先は127.0.0.1のみ。専用ブリッジネットワークは他スタックと分離するが、外向き通信自体を遮断するものではない。アプリやPush送信処理は起動しない。

## 起動・停止（PowerShell）

必ずこのディレクトリで実行する。ラッパーはさらに絶対パスの--workdirを指定し、親ディレクトリ探索を防ぐ。

```powershell
Set-Location C:\Users\User\workspace\imahima\verification\group-chat-local
# 初回インストールまたは別PCへの再現時。ルートのpackage.jsonは変更しない。
npm ci --no-audit --no-fund
# 初回構築前だけ。今回作成済みのbaselineは上書きしない。
# node capture-baseline.mjs
npm start
npm run verify

# このプロジェクトだけ停止。データ・署名鍵を保持する。
npm stop
# 同じ設定で再起動
npm start
npm run verify
```

`local-stack.mjs`はstart/stop/statusだけを許可する。CLIは既存のSUPABASE/PG/Expo関連接続変数を引き継がず、専用設定を検証してから起動する。stopは専用project-idを指定し、--all/--no-backupは使用しない。db push、link、reset、リモート操作の実行機能はない。専用ディレクトリへのアプリmigration追加もラッパーが拒否する。

Docker Desktopではnetworkのhost_binding_ipv4指定だけではCLIの公開ポートがループバックに限定されなかった。そのため`bind-loopback.mjs`が、**このディレクトリの所有ラベルを持つ新規DB/Kongだけ**を同じイメージID・設定・名前付きボリュームでループバック版へ再作成する。KongのCLI生成設定はメモリ内で引き継ぎ、鍵を出力しない。旧コンテナは停止して新コンテナの正常性確認まで保持する。既存スタックやボリュームを変更・削除しない。起動時に補助処理が失敗したら、今回の専用コンテナだけを調査し、ラベルや作業パスの検証を迂回しない。

## 専用環境変数・秘密ファイル

`npm run verify`が接続先・コンテナ・DB識別子を確認した後に `.env.local` を生成する。API URL、ローカルanon/service roleキー、ローカルDB URL、DBクラスタ識別子、将来のExpress用ポートを含む。`.env.example`は形式の説明であり、その値を実鍵として使用しない。

JWT署名鍵は初回start時にこの環境専用として生成し、`.runtime/signing_keys.json`に保持する。Authの公開JWKSに対応するkidが存在することを検証する。署名鍵を紛失・交換すると既存セッションへ影響するため、起動のたびに再生成しない。CLIにはローカル開発用のAPIキーもあり、全て秘密値として取り扱う。

`.env.local`、`.runtime/`、node_modules、CLIの.temp/.branchesはGit対象外。CLIのstatus値は秘密設定として`.runtime/local-status.credentials.json`へ保存し、診断ログはJWT/APIキー/DB URLを伏せる。テストユーザーのパスワードと実JWTはメモリだけに保持する。秘密設定や環境変数ファイルの内容をチャット・Gitへ貼らない。

将来Expressを起動する際も、接続先をverifyで照合し、専用envを明示的に読み込む。生成env内のDOTENV_CONFIG_PATHは専用ファイルの絶対パスなので、通常のdotenvが親の`.env`を読むことも防ぐ。今回はExpressを起動していない。

## 構築時の確認結果

2026-11-13に以下を確認した。

- DB: postgres / PostgreSQL 17.11 / wal_level=logical。クラスタ識別子を`.runtime/identity.json`に記録し、再確認時に照合する。
- Auth・PostgREST・Realtimeはすべて専用DBコンテナを参照。
- Auth healthとRESTルートはHTTP 200。RealtimeはDocker health正常かつ実WebSocket接続・切断成功。
- CLIゲートウェイは `/realtime/v1/api/health` を公開していない（404）。Realtimeの判定にはDocker healthとWebSocketを使う。
- supabase_realtime publicationが存在し、INSERT配信有効・全テーブル配信ではない。
- auth.usersは0件。profiles/rooms/room_members/messages/room_message_eventsなどのアプリ用表・チャット/グループRPCは未作成。
- 既存27コンテナのID・設定・マウント・所属ネットワーク、既存9ボリュームのメタデータ、既存.envとCLIリンクのファイルハッシュを比較し一致。
- 専用ラッパーで停止・再起動後も全確認が成功し、DBクラスタ識別子と専用署名鍵を維持。

既存サービスは稼働し続けるため、ボリューム内のデータや自動再起動時刻が自然に変化しないとは保証しない。既存コンテナ/DBへの変更コマンドは実行していない。

`verify-local.mjs`は現在の「アプリ未投入・ユーザー0件」を前提とする。後工程でアプリ/テストデータを投入した後は、その段階の検証手順へ更新する必要がある。ユーザー作成・ログイン・JWT発行・Postgres Changesの購読/配信は今回未実施。

## 次工程の前提

1. 別途承認を得て、実SupabaseのAuthを壊さないアプリ用ベーススキーマを用意する。現在はprofiles/rooms/room_members等がないため、チャットmigration単独では適用できない。
2. 通常のPostgreSQL単体向けfixtureは、auth.usersやauth.uid()・ロールを定義するため、この環境にそのまま読み込まない。
3. profilesとAuth登録の連携、グループMVP、権限を整えてから、対象チャットmigrationをローカルDB識別子照合のうえ個別適用する。
4. 実JWT/PostgREST/RPC、Realtimeの退出後配信停止と再同期を検証する。既存のチーム用プロジェクトへのリンクや接続は不要。

今回はここまでの前提作成・マイグレーション適用・テストデータ作成を行わない。
