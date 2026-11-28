# バックエンドテスト管理表

## 判定と実行環境

Lv.1 は単体、Lv.2 はDB結合、Lv.3 は機能結合、Lv.4 はバックエンド全体結合、Lv.5 はフロント・バックエンド結合、Lv.6 はE2E・実機テスト。

## 現行構成と検証状態

今回の棚卸し対象は main の `09b67f58029d546a248c4a020afce8160090de94`。必須CIは `backend-static`、`backend-offline`、`backend-db` の3ジョブを維持する。Offlineの必須登録は20ファイルで、過去の19ファイルに `test-migration-ledger.mjs` が追加されている。DBは引き続きSQL 3本であり、台帳のOffline検査は全migrationのDB適用を検証しない。

下の機能別マトリクスと「実行証跡と更新」の成功結果は、明記した過去SHAの記録として保持する。現行SHAに対するGitHub Actionsの結果は本更新では未検証で、過去の277件成功を現行20ファイルの結果として転記しない。今回のローカル検証は末尾の別記録で管理し、CI成功と区別する。専用環境が必要な延期DB・Integration・Deviceも現行SHAでは未検証。

## 機能別テストカバレッジマトリクス

判定は末尾の実行証跡に記載した基準SHA `15ee3717c685f1f4eac9776b0cab71939e0d5be8` に対するもの。機能全体の保証範囲は直下の対応表で確認する。後続コミットへの成功の転記は行わない。

- **CI済** は、そのセルに対応付けたテストがすべて必須CIで成功した状態。
- **手動済** は、対応する対象SHAと成功証跡を確認できる手動実行。
- **一部（CI）** は、対応するテストの一部がCIで成功し、残りの同レベルの検証が未実行または未整備の状態。**一部** は、部分実装・部分検証のみを確認できる状態。
- **未検証** は、該当テストが存在し、基準SHAの成功証跡を確認できない状態。
- **未実装** は、該当レベルのテストを確認できない状態。**対象外** は、そのレベルでの検証を計画していない状態。今回、対象外と断定できるセルは設けていない。

| 機能 | Lv.1 | Lv.2 | Lv.3 | Lv.4 | Lv.5 | Lv.6 |
| --- | --- | --- | --- | --- | --- | --- |
| 認証・セッション | CI済 | 未検証 | 一部（CI） | 未検証 | 未実装 | 未実装 |
| プロフィール・暇状態 | CI済 | 一部（CI） | 一部（CI） | 未検証 | 未実装 | 未実装 |
| 暇タイマー・延長 | CI済 | 未検証 | 一部（CI） | 未検証 | 未実装 | 未実装 |
| グループ管理 | CI済 | 一部（CI） | 一部（CI） | 未検証 | 未実装 | 未実装 |
| チャット | CI済 | 一部（CI） | 一部（CI） | 未検証 | 未実装 | 未実装 |
| 暇ON通知 | CI済 | 未検証 | 一部（CI） | 未検証 | 未実装 | 未実装 |
| チャット通知 | CI済 | 未検証 | 未検証 | 一部 | 未実装 | 未実装 |
| 終了前通知 | CI済 | 未検証 | 一部（CI） | 未実装 | 未実装 | 未実装 |
| Push通知基盤 | CI済 | 未検証 | 一部（CI） | 未検証 | 未実装 | 一部 |

| 機能 | 対応するID・ファイルと未検証範囲 |
| --- | --- |
| 認証・セッション | Lv.1/3は `AUTH-01`。Lv.2は `DB-PROFILE` 等の所有権・RLS、Lv.3は `INT-AUTH` の実Authとストレージ復元、Lv.4は `INT-CHAT` 等の実JWT経路が基準CIで未実行。実端末の復元は未整備 |
| プロフィール・暇状態 | Lv.1は `PROFILE-01`、Lv.3は `PROFILE-02`。Lv.2は `DB-GROUP` の暇表示のみ成功し、`DB-PROFILE` の保護列・権限は延期。Lv.3/4の実Auth・更新経路は `INT-AUTH`、`INT-MEMBER` に残る |
| 暇タイマー・延長 | Lv.1は `TIMER-02/03` と `PUSH-03`、Lv.3は `PROFILE-02`、`TIMER-01`。Lv.2の `DB-TIMER` と `DB-RACE`、Lv.3/4の `INT-AUTH` の延長経路は未実行。`DB-GROUP` の表示状態fixtureは実タイマー処理の検証に数えない |
| グループ管理 | Lv.1/3は `GROUP-01`。Lv.2は `DB-GROUP` 成功、`DB-RACE` の参加・退出競合は未実行。Lv.3は `DB-HTTP`、Lv.4は `INT-CHAT` のグループ回帰が未実行 |
| チャット | Lv.1/3は `CHAT-01`、Lv.3に `HTTP-01`。Lv.2は `DB-CHAT` 成功、`DB-RACE` の並行送信・削除等は未実行。Lv.3の `DB-HTTP`、Lv.4の `INT-CHAT` とRealtime配送は未実行 |
| 暇ON通知 | Lv.1/3は `MEMBER-PUSH-01/02`。Lv.2は `DB-OUTBOX`、`DB-RACE`、Lv.4は `INT-MEMBER` が未実行。実DBによる受信者・leaseと通常起動ワーカーの通し経路は基準CIの保証外 |
| チャット通知 | Lv.1は `CHAT-PUSH-01`。Lv.2/3は `tests/test-chat-message-db.mjs`（`DB-OUTBOX`）の実DB・ワーカーが未実行。Lv.4の `INT-CHAT-PUSH` は配線と部分検証資産があり、実JWT送信から模擬Expoまでの全体結合は未実装 |
| 終了前通知 | Lv.1は `END-PUSH-01` と `PUSH-03`。Lv.2は `DB-TIMER`、Lv.3は `INT-END` と `DB-RACE` が未実行。実ワーカーと実DBの組合せはLv.3として管理し、独立したLv.4全体試験は未確認 |
| Push通知基盤 | Lv.1は `PUSH-02/03`、Lv.3は `PUSH-01`、`MEMBER-PUSH-02`。Lv.2の端末・キュー権限は `DB-OUTBOX` 等で未実行。Lv.4/6は `DEVICE-PUSH`。Expo受付スクリプトは存在するが基準SHAで未実行で、端末受信・操作のLv.6は手動確認を要する部分実装 |

全機能のLv.5は `UI-E2E` の未実装範囲。Lv.6の自動実機E2Eも未整備。表の「CI済」は対応する既存ケースの成功を示し、未知の異常系や機能の全仕様を網羅したことは意味しない。

初期CIの受入範囲は、`backend-db` による **Lv.2の実PostgreSQL結合**と、`backend-offline` による **Lv.1およびモックを利用したLv.3の機能結合**。Offlineでは実HTTPをループバックで使う場合も、DBや上流サービスは注入・模擬する。実HTTP/APIから実PostgreSQLまでを通るLv.3は手動検証の資産があり、CIへの追加は別Issueで扱う。Lv.4〜6、全23マイグレーションの通し検証、延期中のSQL 6本は初期CIの対象外。

| プロファイル | 入口・前提 | CI |
| --- | --- | --- |
| Static | Node 24.15.0／npm 11.12.1。ルートで `npm ci`、`npm run typecheck`、`npm run lint`。lint用に `npm ci --prefix verification/group-chat-local` と `npm ci --prefix verification/issue35` も実行 | `backend-static` |
| Offline | `npm test`。ルートの依存のみ。ループバック、注入したAuth・DB応答、模擬Expoを利用 | `backend-offline` |
| DB | `npm run test:db`。ローカルLinux Dockerと固定版PostgreSQL 16で代表SQL 3本を実行。残りのSQL／Nodeスクリプトは各行の専用環境で起動 | `backend-db`。並行系は任意候補 |
| Integration | 専用Supabaseまたは承認済みの検証先。実Auth／PostgREST／Realtime、必要に応じて模擬Expo。既存環境を再利用する入口ではデータ・証跡の前提を確認 | 手動。自己完結したセットを任意CI候補とする |
| Device | 専用アカウントと端末。受信・表示・タップ後の挙動を実機で判定 | 手動 |

lintは追跡済みのJS／TS系ソースと、Gitが無視しない新規ソースを列挙する。フロント、サーバー、スクリプト、テスト、統合・検証コードが対象。Gitで無視する `node_modules/`、`.expo/`、生成済み `expo-env.d.ts`、`dist/`、`web-build/`、生成ネイティブフォルダ、`.runtime/`、ローカル専用検証コード・成果物は、クリーンなチェックアウトのソースに含まれない。TypeScriptは既存のルート設定でアプリ・サーバー・TSテストを検査する。Expo生成型が存在すれば取り込む。

## Offline 必須

各行は `npm test` の必須実行単位。ファイル名は `tests/` 基準。表中のシナリオは実装済み。個別のケース名・件数・結果はCIの `backend-offline` アーティファクトを参照する。テストまたはスイートにskip・TODOがある場合や、タイムアウト、取消、ゼロ件、不完全なTAPは失敗とする。

`tests/` 配下を再帰的に探索し、`test-*.拡張子`、`*.test.拡張子`、`*.spec.拡張子` のJS／TS系ファイルを登録チェックの候補にする。候補は [Offlineランナー](../../scripts/test-offline.mjs) の必須リストか、実行プロファイルと理由を記した対象外リストのどちらか一方に登録する。ファイルの欠落・未登録・二重登録は実行前に失敗する。テストの実行対象は必須リストで明示する。

| ID | シナリオ | Lv. | ファイル | 境界 |
| --- | --- | --- | --- | --- |
| AUTH-01 | Auth SDKの例外・応答を401/503に分類しルートへ伝播 | 1/3 | `test-auth-classification.ts` | SDKエラーと下流を注入 |
| PROFILE-01 | 暇表示の期限、取得失敗・逆順応答 | 1 | `test-availability-display.ts` | 仮想時計・取得モック |
| PROFILE-02 | toggle、明示ON/OFF、延長のHTTP契約 | 3 | `test-profile-toggle.ts` | Auth・RPC注入 |
| GROUP-01 | 作成・一覧・招待・参加・退出、actor・入力の検査 | 1/3 | `test-groups.ts` | Auth・RPC注入、版番号検査 |
| CHAT-01 | 送信・履歴・差分・削除、認可とエラー変換 | 1/3 | `test-chat.ts` | ループバックHTTP、Auth・DB注入 |
| HTTP-01 | Auth・所属・RPC期限、切断、遅延応答 | 3 | `test-timeouts.ts` | 上流モック、一部実SDK |
| TIMER-01 | 通知からの延長の認証、入力、結果変換 | 3 | `test-extend-from-notification.ts` | Auth・RPC注入 |
| TIMER-02 | 通知アクションからの延長と表示更新 | 1 | `test-free-end-action.ts` | 模擬セッション・HTTP |
| TIMER-03 | iOS・Android・Web分岐、重複処理防止 | 1 | `test-notification-runtime.ts` | ExpoとOSを模擬 |
| END-PUSH-01 | 終了前通知のclaim、取消、再試行 | 1 | `test-free-end-notifications.ts` | RPC・送信注入 |
| MEMBER-PUSH-01 | 暇ON宛先の適格性、部分受付・停止 | 1/3 | `test-member-free-notifications.ts` | RPC・送信モック |
| MEMBER-PUSH-02 | SDKのHTTP停止、部分受付・停止 | 3 | `test-member-free-transport.ts` | 実SDKとループバックの模擬Expo |
| CHAT-PUSH-01 | チャット宛先の逐次claim、期限・取消・停止 | 1 | `test-chat-message-notifications.ts` | RPC・送信注入 |
| PUSH-01 | テスト通知の認証、レート制限、予約解除 | 3 | `test-notifications.ts` | Auth・端末・送信注入 |
| PUSH-02 | Expo受付結果、無効トークン・部分受付 | 1 | `test-push-notification-service.ts` | SDKクライアント注入 |
| PUSH-03 | Android受信データ、claim再試行、通信期限 | 1/3 | `test-review13.ts` | 模擬端末とSDK、仮想時計 |
| SERVER-01 | 通常サーバーの依存配線とワーカー有効・無効 | 1 | `test-server-composition.ts` | 起動と下流を注入 |
| SERVER-02 | 通知の配線・停止、通信境界、cleanup | 1/3 | `test-member-free-review.mjs` | 注入とループバック |
| HARNESS-01 | ワーカー待機、拒否、タイムアウト | 1 | `test-worker-barrier.ts` | 補助コードの単体検証 |
| LEDGER-01 | 台帳の固定prefix・依存順・適用前提・SQLハッシュ、追加migrationと改行差の検査 | 1 | `test-migration-ledger.mjs` | ファイルと一時fixtureのみ。DB接続・SQL適用なし。過去19ファイルのCI証跡には含まない |

手動Offlineの `node --import tsx --test tests/test-chat-review.mjs` は、一時クローンへのGit操作と一時ファイル作成を伴うため今回の必須セットから外す。Issue #35 のOfflineは `npm --prefix verification/issue35 run test:offline`。22本時点の履歴を前提とする検査は、現行23本の合格証跡として使用しない。

## DB・Integration・Device

`backend-db` は毎回作成したコンテナに対し、グループfixture、グループmigration、チャットfixture、チャットmigrationの順に適用する。その後 `group_mvp.test.sql`、`group_availability.test.sql`、`group_chat_mvp.test.sql` を直列に実行する。コンテナはネットワークなし・公開ポートなし・データtmpfsで、SQLはコンテナ内のUnixソケットへ送る。全migration、実Auth・Realtime、通知ワーカーはそれぞれの専用環境で扱う。

新規 `supabase/tests/**/*.test.sql` は [DBランナー](../../scripts/test-db.mjs) の必須一覧または理由付きの延期一覧に登録する。必須テストが追加・変更された場合は、検証ブロック数と完了条件も確認する。ローカル実行では `.runtime/backend-db/` に実行ごとのJSONを保存し、`DB_TEST_REPORT` で保存先を指定できる。Docker接続先は既定のローカルソケット・Windows名前付きパイプに限定し、Docker環境変数による接続先の上書きやローカルDBの接続情報は使用しない。

実装状態と、下記の基準SHAにおける実行結果を分けて記載する。「未実行」は基準runでの状態を示し、過去の手動検証はその対象SHAと証跡で管理する。NodeのTSランナーは、特記がなければルートで `node --import tsx --test <file>` を使用。専用環境の作成手順は [サーバーREADME](../../server/README.md)、[ローカルチャット検証](../../verification/group-chat-local/README.md)、[Issue #35検証](../../verification/issue35/README.md) を参照。

| ID | シナリオ | Lv.／プロファイル | 実装状態・入口と前提 |
| --- | --- | --- | --- |
| DB-PROFILE | 保護列、所有者、書き込み権限 | 2／DB | 実装済み。 `profile_write_permissions.test.sql` |
| DB-GROUP | 作成・参加・退出、所属・暇表示 | 2／DB | 実装済み。 `group_mvp.test.sql`、`group_availability.test.sql` |
| DB-CHAT | 送信・重複・削除・quota・RLS | 2／DB | 実装済み。 `group_chat_mvp.test.sql` |
| DB-TIMER | 通知延長、claim期限・再試行 | 2／DB | 実装済み。 `extend_from_notification.test.sql`、`free_end_notification_claims.test.sql`、`group_timer_notifications.test.sql`、`notification_processing_retry.test.sql` |
| DB-OUTBOX | 暇ON／チャット宛先と更新の原子性、lease・backoff | 2/3／DB | 実装済み。 `member_free_notifications.test.sql` と `node --import tsx tests/test-chat-message-db.mjs`。後者は専用PG17、`ISSUE36_PG_BIN`、模擬Push |
| DB-RACE | 並行送信・退出・quota・通知claim・タイマー | 2/3／DB | 実装済み。 `tests/test-chat-db-concurrency.mjs`、`tests/test-group-db-concurrency.mjs` は `node <file>`。 `tests/test-member-free-concurrency.ts` は専用DB URL、`node --import tsx integration/test-notification-db-concurrency.ts` は隔離Docker DB |
| DB-HTTP | HTTP→実DBチャット、ロック期限 | 3／DB | 実装済み。 `tests/test-chat-db.ts` と `tests/test-chat-lock-timeout.mjs` の隔離PGケース。 `CHAT_ISOLATED_DB=1`、Auth注入・psql転送 |
| INT-AUTH | 登録、セッション復元、暇状態の延長 | 3/4／Integration | 実装済み。 `npm run test:login`、`test:persistence`、`test:integration:extend`。専用ユーザー・Auth、延長はAPI・DBも使用 |
| INT-CHAT | 実JWT、チャット／グループ、退出・アーカイブの権限、Realtime正負対照と再接続 | 4／Integration | 実装済み。 `tests/test-chat-db.ts` の `CHAT_LOCAL_DB=1` ケース、`verification/group-chat-local` の `test:integration`、`test:final`、`test:archive`、`test:timeouts`。診断は受信欠落を別途判定 |
| INT-MEMBER | 暇ON APIから実キュー／ワーカーと模擬Expoまで | 4／Integration | 実装済み。 `tests/test-member-free-{api,entrypoint,push-integration}.mjs`。専用Auth・DB・設定、同一実行で生成したentrypoint証跡が前提 |
| INT-END | 終了前通知の受信者、再試行、競合 | 3／Integration | 実装済み。 `npm run test:integration:free-end`。ローカルAuth Admin・DB、模擬Push |
| INT-CHAT-PUSH | 実JWT送信→通常起動ワーカー→模擬Expo | 4／Integration | 部分実装。Offline配線と実DB・実ワーカー試験あり。全経路の一体検証は未実装 |
| DB-MIGRATIONS | 全23本の空DB適用、既存データ付き更新、権限 | 2／DB | 部分実装。Issue #35の `verify:migrations` 等とSQL監査は対象版・専用環境に依存。現行の全適用とアップグレードのCI証跡が未整備 |
| UI-E2E | 実ExpoアプリとAPI／Authの結合、セッションの復元 | 5／Integration | 未実装。モックによる表示・ストレージ検証あり |
| DEVICE-PUSH | Expo受付、端末受信、表示・操作 | 4/6／Device | 部分実装。送信入口は `npm run test:integration:push`。登録端末での結果は手動。実送信のためCI対象外 |

## ローカルでの結果確認

リポジトリのルートで Node 24.15.0／npm 11.12.1 を使用する。Offlineにはルートの依存が必要で、未導入なら `npm ci` を実行する。Staticを再現するときは上記プロファイル表の検証用2ディレクトリにも `npm ci` を実行する。DBランナーはNode組込みAPIとローカルLinux Dockerを使用し、npm依存の追加導入は不要。共有DBのURL・認証情報や実Pushを使用しない。

以下はPowerShellの例。実行ごとに異なるディレクトリを使い、終了コードを直後に保存する。JSON内のSHAはHEADを示すため、未コミット変更がある場合は `git status --short` と差分も別途記録する。

```powershell
$runDirectory = ".runtime/local-tests/$(Get-Date -Format yyyyMMdd-HHmmss)-$([guid]::NewGuid().ToString('N'))"
$env:OFFLINE_TEST_REPORT = "$runDirectory/offline/report.json"
npm test
$offlineExit = $LASTEXITCODE
$offline = Get-Content -Raw $env:OFFLINE_TEST_REPORT | ConvertFrom-Json
$offlineExit
$offline | Select-Object sha, os, arch, node, npm, status, errors, counts
$offline.files | Select-Object file, status, exitCode, signal, timedOut

$env:DB_TEST_REPORT = "$runDirectory/db/report.json"
npm run test:db
$dbExit = $LASTEXITCODE
$db = Get-Content -Raw $env:DB_TEST_REPORT | ConvertFrom-Json
$dbExit
$db | Select-Object sha, os, arch, node, image, status, cleanup, error, failure, cleanupError
$db.setup
$db.tests
```

Offlineの成功条件は終了コード0、`status=passed`、`errors` が空、全20ファイルが成功し、`fail/cancelled/skipped/todo` がすべて0であること。失敗したファイルの `stdout`、`stderr`、`error`、`timedOut` をJSONで確認する。`OFFLINE_TEST_REPORT` 未指定時はJSONを保存せず、端末ログのみになる。

DBの成功条件は終了コード0、`status=passed`、setup 4項目とSQL 3本が成功し、各SQLの `completed=true`、`rollback=true`、検証ブロック数が順に3・2・8、`cleanup=passed` であること。失敗時は `failure` と各setup／testの `error`、`stderr`、`exitCode` を確認する。SQLの生ログは保存せず、SQLSTATE・入力行と安全な分類のみを残す。DB用環境変数の未指定時は `.runtime/backend-db/<runId>/report.json` が保存先になる。

`running`／`pending`／`interrupted` は成功ではない。JSONが存在しない場合も成功とせず、起動・出力先のエラーを確認する。cleanup失敗や中断時は同じ `DB_TEST_REPORT` を維持して `node scripts/test-db.mjs --cleanup` を実行し、JSONのcleanup結果を再確認する。接続先・コンテナ所有確認のガードは解除しない。確認後は `Remove-Item Env:OFFLINE_TEST_REPORT, Env:DB_TEST_REPORT` でこのセッションの出力先指定を解除できる。

GitHub Actionsでは各ジョブの終了結果と、常時保存する `backend-offline`／`backend-db` artifact内のJSONを照合する。版確認・依存導入などテスト開始前に失敗した場合、JSONがないこともあるためActionsの該当stepログを確認する。Push／PR作成前のローカル成功はGitHub Actions上の成功証跡ではない。

## 今回のローカル検証（2026-11-28）

対象は `chore/issue-39-test-ci`、HEAD `09b67f58029d546a248c4a020afce8160090de94` に本CI workflow・管理表の未コミット変更を加えた作業ツリー。Windows x64、Node 24.15.0／npm 11.12.1。GitHub Actionsは未実行。下記はローカル成功であり、上記の過去SHAの機能別CI判定を更新する根拠にはしない。

| 検証 | 結果・証跡 |
| --- | --- |
| Static | `npm run typecheck`、`npm run lint` が終了コード0。既存の導入済み依存を使用し、pg解決エラーは再現せず。今回クリーンな `npm ci` は未実施。依存追加・lockfile変更なし |
| Offline | `npm test` が終了コード0。20ファイル・287件成功、fail／cancelled／skipped／todoは各0。JSONは `.runtime/issue39-mvp/offline/report.json`、端末ログは同ディレクトリの `run.log` |
| DB | `npm run test:db` が終了コード0。setup 4項目とSQL 3本成功、ブロック数3・2・8、全件完了マーカー・rollback確認、cleanup成功。JSONは `.runtime/issue39-mvp/db/report.json` |
| Workflow | 既存依存のjs-yamlでYAMLを解析し、3ジョブ名と版確認スクリプトの一致を確認。追加した版確認をGit Bashで実行して終了コード0。Ubuntu／Actions上での実行・artifact保存は未検証 |

初回のサンドボックス内テストはGitの所有者判定で開始前に停止したため、Git設定を変更せず通常ユーザー権限で再実行した。共有DBへの接続・変更、実Push送信は行っていない。ローカル成果物はGit管理対象外であり、別環境での再現時は上記手順で新しい証跡を採取する。

## 実行証跡と更新（過去の基準run）

基準は `main` の `15ee3717c685f1f4eac9776b0cab71939e0d5be8` と [Actions run 44941911947](https://github.com/0415t/imahima/actions/runs/44941911947)。OfflineとDBのJSONで、チェックアウトしたSHAが基準と一致することを確認した。

| 実行区分 | 基準runの結果 | 検証範囲・証跡 |
| --- | --- | --- |
| 必須CI・`backend-static` | 成功 | Node 24.15.0／npm 11.12.1 の照合、`npm ci`、TypeScript型チェック、全体lint |
| 必須CI・`backend-offline` | 19ファイル・277件成功。失敗・skip・TODO・取消は各0件 | 上のOffline必須表のLv.1と模擬境界でのLv.3。[Offline JSON](https://github.com/0415t/imahima/actions/runs/44941911947/artifacts/14721528922) |
| 必須CI・`backend-db` | SQL 3本成功、全件rollback・完了マーカーあり、cleanup成功 | `DB-GROUP` と `DB-CHAT`。fixture 2本とmigration 2本の適用後、順に検証ブロック3・2・8を確認。[DB JSON](https://github.com/0415t/imahima/actions/runs/44941911947/artifacts/14721424277) |
| 手動・延期したDB | 基準runでは未実行 | `DB-PROFILE`、`DB-TIMER`、`DB-OUTBOX`、`DB-RACE`、`DB-HTTP`、`DB-MIGRATIONS`。実タイマー、通知キュー、並行処理、実HTTP→実DB、全migrationは未評価 |
| 手動・Integration／Device | 基準runでは対象外 | `INT-AUTH`、`INT-CHAT`、`INT-MEMBER`、`INT-END`、`INT-CHAT-PUSH`、`UI-E2E`、`DEVICE-PUSH`。実Auth・Realtime・実機と部分実装の通し経路は未評価 |

- CI証跡は run URL、対象SHA、OS、Node/npm、必須ファイル別の結果とログを参照。ローカルのJSON取得は `OFFLINE_TEST_REPORT` に出力先を指定する。手動は対象SHA、環境、シナリオID、合否と証跡を残す。旧SHAの成功は新SHAに転記しない。
- レポートは開始時と各ファイルの開始・終了時に保存する。全体が `running` のレポートは途中経過で、最終結果は `passed` または `failed`。CIではOffline実行ステップの上限を10分、ジョブ全体を15分とする。
- 合否・前提・モック境界が異なる場合は行を分ける。対象ファイル内の入力バリエーションは、個別に追跡する必要がなければまとめる。
- ケースや実行条件を変えるPRで、管理表と必須ファイル一覧を更新する。skip理由、未検証の範囲、フォローアップ先を記録し、接続文字列や秘密値は証跡に含めない。
- 新機能には機能別マトリクスの行を追加し、テスト追加・変更時に該当セルと対応IDを更新する。CI化時は成功証跡と対象SHAを確認してから状態を変更する。実装済みでも未実行なら未検証とし、新しいコミットで未実行のケースに過去の成功を転記しない。詳細一覧・実行証跡・マトリクスの状態を照合する。
