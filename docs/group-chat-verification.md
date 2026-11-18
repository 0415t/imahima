# バックエンド回帰の実行手順

専用ローカル`imahima-chat-local`だけを使用する。APIは`127.0.0.1:56321`、DBは`127.0.0.1:56322`。各ハーネスの接続先・Dockerラベル・保存済みDB識別子の検証が失敗したら停止する。共有.env、ルートCLIリンク、他のコンテナには接続しない。既存データを初期化しない。

## データを保持した検証

リポジトリルートのPowerShellで実行する。DBを使用するテストは順番に実行する。テストごとに専用ユーザー・roomを新規作成し、Auth削除試験はその実行で新規作成した削除対象のみを削除する。履歴・既存fixture・新規roomは保持する。

```powershell
node verification/group-chat-local/verify-schema.mjs
node --import tsx --test --test-concurrency=1 tests/test-auth-classification.ts tests/test-timeouts.ts tests/test-chat.ts tests/test-groups.ts tests/test-profile-toggle.ts
$env:CHAT_LOCAL_DB='1'
node --import tsx --test tests/test-chat-db.ts
Remove-Item Env:CHAT_LOCAL_DB
node --import tsx verification/group-chat-local/archive-regression.mjs
node --import tsx verification/group-chat-local/timeout-integration.mjs
node --import tsx verification/group-chat-local/integration-test.mjs
node verification/group-chat-local/verify-schema.mjs
node scripts/check-chat-commit.mjs
git diff --check
```

`test-chat-db.ts`の専用ローカル項目は実JWT→Express→PostgREST→RPCとAuth削除・Realtimeを検証する。旧PostgreSQL単体fixture項目は`CHAT_ISOLATED_DB=1`の明示指定が必要であり、今回は他環境への接続を避けるため実行しない。ルート`npm test`は共有.envを参照する別用途のテストを含むため、この限定回帰では使用しない。

`verify-schema.mjs`は既存データを許容し、Authオブジェクトの定義・権限を確認する。ユーザー件数やroom件数を固定しない。管理フラグ・所属トリガー・最小権限も検査する。結果は`.runtime/reports/`に毎回別名で保存する。

## 過去の条件の再現

今回更新前のスクリプト・README・記録の原本とSHA256一覧は、ローカル`.runtime/history/precommit-*/`に保持する。原本はGit対象外。空DB専用の旧手順は現在非推奨であり、既存DBに適用・リセットしてはならない。`verify-schema.mjs --expect-empty`は新しく承認された空環境でのみ使う歴史的チェック。

`integration-test.mjs --legacy-subscribe`で通常購読という旧条件を選択できる。既定は準備完了を待つ購読。初期欠落はREST同期で回収できるが、その成功のみで過去の欠落原因が消えたとは判断しない。

## Git管理と安全性

汎用ハーネス・設定・SQL・匿名化済み記録は管理候補。`.runtime/`、`.env.local`、`node_modules/`、CLI `.temp/`、分類manifest、環境固有の修復・適用スクリプト、原本記録は除外する。匿名化版は原本を上書きしない。実JWT・キー・接続URI・実行固有IDをコミットしない。検査スクリプトは値を表示せず、ファイル名と検出種類だけを報告する。

Realtimeはデータ取得・配送の認可を受入条件とし、接続成立だけを失敗判定にしない。修復対象roomの新規配送試験、実タイマー更新・延長試験は未実施として保持する。過去の失敗は匿名化した履歴にも残す。
