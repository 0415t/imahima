# Issue #35：権限是正migration・隔離検証報告

既存18本のmigrationとアプリ本体は変更していません。本番用コードは末尾に追加するH1〜H4の4本です。
コミット前確認の6件を修正し、修正確定後に新規の隔離環境A・B・Cで全検証を実施しました。
最終結果は **263チェック成功・0失敗**。再適用前と異常系テスト後のA・B比較は、各16項目すべて一致しました。

## 対象と変更範囲

- main / worktree base: `aff689da63c04e3a48e5b8f541d9a1573ad1b382`
- branch: `codex/issue35-acl`
- worktree: `C:/Users/User/workspace/imahima-issue35-acl`
- 本作業での変更は検証コード・設定・報告書・結果JSONのみ。新規4本にも追加変更なし。
- 既存18本はGitと元作業ツリーの双方に照合。アプリ本体のtracked差分なし。
- 共有DBへの接続、共有migration適用・repair、コミット・Push、Issue・PR更新は未実施。

## 6件の対応と誤実装の検出

| 指摘 | 修正 | 再現・検出結果 |
| --- | --- | --- |
| migrateの確認順序 | エンジン・コンテナのポート・クラスタ識別を確認後、SELECTのみの空DB判定をbootstrapより前に実行 | 旧順序が拒否前にdefault ACLを変えることをトランザクション内で再現。修正版の再実行はカタログ・default ACL・履歴全列・プロフィール/roomのdigestが無変更 |
| failuresの事前修復 | 永続的なH1/H4再適用と履歴SQL更新を除去。事前比較を必須化し、SQL異常系はすべてロールバック | 意図的なTRUNCATE権限差分を、本番と同じ比較関数で検出。異常系終了後は全カタログと履歴全列が開始前と一致 |
| GRANT OPTION未検査 | PUBLIC/anon/authenticated/service_roleのrelation・column・function・schema ACLをgrantorとis_grantable込みで検査 | 許可済み権限へのWITH GRANT OPTIONをtable/column/function/schemaで付与し検出。anon/service_roleも検出。PUBLICへの通常付与を検出し、PUBLIC WITH GRANT OPTIONはPostgreSQL自体が拒否することを確認 |
| 重要仕様の不足 | 30/60/120/180分の初回期限、期限クリア、OFF/期限切れ/非所属への通知防止、2グループ経由の重複排除、lease回復・旧token拒否・上限、再ON/退出後の通知無効化、ON競合、延長の実ロック待ち、本人端末削除を追加 | 初回期限を1分に変更、期限クリアを削除、通知適格性を常にtrue、受信者を二重生成する4種類の関数誤実装をA/B双方で検出。各SQLはロールバック |
| CLI誤成功 | No migrations foundを拒否。Local/Remote双方の22 versionを完全一致検査。専用Cでmigrationを明示有効化し将来migrationを実適用 | 旧正規表現の誤成功を再現。欠落・remote不一致・無効configを拒否。Cは23本、A/Bは22本を維持。実テーブル生成・履歴・ACL・再dry-runまで成功 |
| 報告書 | UTF-8で再作成。現行コード・結果・コミット対象を記載 | UTF-8厳密デコードと文字化け検査を実施。途中JSON13件はignoreし、実ファイルは保持 |

Realtimeの否定テストでは、同じ送信の認可済み受信者、または独立した有効roomの配信を正の対照として待機します。退出後の再参加・復旧も確認しました。

## 最終環境と適用順序

最終runは `verified`。この修正確定後に3つとも新規作成し、旧runをresetしていません。

| 環境 | project | API / DB | 経路 |
| --- | --- | --- | --- |
| A | imahima-issue35-verified-a | 48321 / 48322 | 新規DB、既存18本の順序適用、空の分類manifest、H1→H2→H3→H4 |
| B | imahima-issue35-verified-b | 49321 / 49322 | 6テーブル・7履歴・9正常OFFプロフィール・3roomを合成再現。restriction/H1を先行、通知/timer/index/H2、chat/H3、分類/archive/H4、合成環境だけの履歴補完 |
| C | imahima-issue35-verified-c | 50321 / 50322 | A同等の22本構築後、公式CLIで検証専用20990101000000を適用 |

H1は列ACLもリセットします。H4後にH1だけ再実行するとH4の補完権限を失うため、通常経路は前方適用のみです。failure内の再適用はトランザクションの中だけで、必ずロールバックします。

既存roomの実分類は推測していません。Bでは由来を明示した合成MVP/legacyデータを使用し、未分類・重複・未知ID・根拠なしなどは適用失敗と原子性を確認しました。Bの履歴補完は共有DB repairの根拠や承認ではありません。

## 成功・失敗の内訳

| Category | Passed | Failed |
| --- | ---: | ---: |
| migration | 48 | 0 |
| cli-provision | 23 | 0 |
| feature | 92 | 0 |
| realtime-lifecycle | 8 | 0 |
| regression | 20 | 0 |
| specification | 20 | 0 |
| normal-management | 6 | 0 |
| failure | 22 | 0 |
| integrity | 8 | 0 |
| comparison | 16 | 0 |
| Total | 263 | 0 |

チェック単位には、migration適用記録と複数assertionをまとめたACL検査が含まれます。件数を独立した業務シナリオ数とは扱いません。事前比較16項目は別の保存記録であり、最終比較16件と重複集計していません。

調整中には7件の失敗を検出しました。PUBLIC拒否エラー文言の不一致2件、CLI出力形式・無効設定・stderr取得不足による5件です。すべて修正後の新規通し実行で成功しました。旧runのエラーログ・先行結果はignored runtimeに保持し、最終集計に混ぜていません。

## 権限と機能

是正前のBではprofiles/users/deviceに広範な権限がありました。是正後はクライアントの公開プロフィール列・本人編集列、users SELECT、本人端末SELECT/DELETE、所属roomイベントSELECTに限定。service_roleは現行INVOKER関数・サーバー処理に必要な列と操作のみです。通知DEFINERの内部書込み権限はcallerに付与しません。

11テーブル、77列、33関数、関連スキーマを検査し、PUBLICのアプリtable/function付与、通常ロールの保守権限、不要なEXECUTE、GRANT OPTIONを拒否します。Auth登録関数の本文・初期OFF動作は維持し、search_pathだけ固定しています。

実Auth登録、プロフィール表示/本人編集と拒否、端末登録/本人削除/無効端末削除、タイマー/OFF/無期限/延長/競合、終了前通知/暇ON通知/worker、グループ作成/参加/退出/招待/アーカイブ、チャットRETURNING */履歴/削除/冪等性/並行quota/ページング、Realtimeを検証しました。

テストfixtureの管理権限はpostgres等に分離し、通常API・RPCはservice_roleまたは実JWTで実行しています。外部Pushはモック、メール送信は無効、コンテナ外向きNEW通信は遮断しcurl timeoutで独立確認しました。

## 再適用前・異常系後のA/B比較

`pre-failure-comparison.json`と`final-comparison.json`を別々に保存しています。16項目はgrantor/GRANT OPTION、列/default/RLS/owner、制約、index、関数本文/引数/default/設定/owner、trigger、policy、table/column/function/schemaの実効権限、PUBLIC付与、Cron、publication、その対象table、履歴です。

比較前にH1/H4の永続再適用はありません。両比較とも差分なし。異常系の前後でもカタログと履歴全列が一致します。比較だけに依存せず、権限allowlist・業務仕様の期待値と誤実装の検出を併用しています。

関数のCRLFと、Bに明示的に入れたAuth関数の単一コメントだけを正規化します。任意の意味的差分を消す正規化、ユーザーデータのA/B同一性、無関係なplatform OIDの一致は主張しません。

## 最終コミット候補

全40ファイル。上の本番用4SQL以外は検証・記録用です。

```text
docs/issue35-acl-verification.md
supabase/migrations/20261118000000_harden_core_runtime_privileges.sql
supabase/migrations/20261118000001_harden_notification_runtime_privileges.sql
supabase/migrations/20261118000002_harden_chat_runtime_privileges.sql
supabase/migrations/20261118000003_harden_archive_runtime_privileges.sql
verification/issue35/.gitignore
verification/issue35/README.md
verification/issue35/acl.mjs
verification/issue35/block-egress.mjs
verification/issue35/catalog.mjs
verification/issue35/cli-assertions.mjs
verification/issue35/compare.mjs
verification/issue35/db.mjs
verification/issue35/failures.mjs
verification/issue35/features.mjs
verification/issue35/integrity.mjs
verification/issue35/migrate.mjs
verification/issue35/normal-management.mjs
verification/issue35/package-lock.json
verification/issue35/package.json
verification/issue35/realtime-lifecycle.mjs
verification/issue35/regressions.mjs
verification/issue35/reports/cli-provision-results.json
verification/issue35/reports/comparison-results.json
verification/issue35/reports/environment-handoff.json
verification/issue35/reports/failure-results.json
verification/issue35/reports/feature-results.json
verification/issue35/reports/final-comparison.json
verification/issue35/reports/integrity-results.json
verification/issue35/reports/migration-results.json
verification/issue35/reports/normal-management-results.json
verification/issue35/reports/pre-failure-comparison.json
verification/issue35/reports/realtime-lifecycle-results.json
verification/issue35/reports/regression-results.json
verification/issue35/reports/specification-results.json
verification/issue35/reports/summary.json
verification/issue35/safety.mjs
verification/issue35/specifications.mjs
verification/issue35/stacks.mjs
verification/issue35/tsconfig.json
```

途中経過13件の `*-initial.json` / `*-attempt-*.json` はgitignoreで除外し、削除していません。`.runtime`、依存パッケージ、DBディスク、ローカル接続情報、生成した将来migrationも対象外です。

コミットメッセージ案：`fix(db): harden runtime privileges and verify migration paths (#35)`

## 残存課題と既存環境への影響

共有適用前には、実room3件の由来・管理区分、実DBの列default/制約定義、pg_cronの配置/version、外部クライアント、その他grantee、バックアップと復元、worker/Cron停止再開、履歴補完根拠と復旧手順を確認する必要があります。重複indexは保持しており、実負荷の評価は未実施です。実端末Push・本番負荷・UI操作の保証は含みません。

元作業ツリーと既存18本・アプリ本体、共有DB、既存ローカルDB/コンテナ、旧WSL環境は変更していません。専用エンジン上に作成した検証環境は停止し、volumeを保持しました。

例外として、隔離指定を追加する前の診断用CLI実行が、ユーザー共通の `C:/Users/User/.supabase/telemetry.json` を更新しました。DBや認証内容の変更ではなくCLI補助メタデータですが、既存環境への変更が完全にゼロとは報告できません。変更前の内容がないため推測で復元せず、以後はSUPABASE_HOMEをignored runtimeに固定しました。最終run中に共通ファイルの追加更新がないことも確認しています。

検証手順は `verification/issue35/README.md`、結果とSQL/検証コードのhashは `reports/summary.json` を参照してください。コミットせず停止しています。

補足：移行直後と機能テスト終了後の全カタログhashは同一ではありません。Realtimeが両環境で `realtime.messages` 用の `supabase_realtime_messages_publication` を初期化するため、publicationと対象tableが1件から2件に増えます。アプリ用 `supabase_realtime` は `public.room_message_events` を対象に維持されています。A/B間の差分は前後ともなく、異常系テスト自身の前後は全カタログ・履歴が完全一致する別チェックで確認しています。
