# Issue #35 / PR #37 コミット前最終報告

2026-11-19。予定済みのオフライン検証と一時Supabase projectによるA/B/C検証は完了し、ユーザー承認済み。今回は文書・コミット候補・秘密情報の最終整理のみ。新規試験、DB接続、共有DB操作、コミット、Push、PR更新は行っていない。Issue #35は共有DBへの適用・動作確認まで継続する。

## 作業状態と変更範囲

- ブランチ: codex/issue35-acl
- HEAD / PR #37 head: 244c43858408852252ec159e5d8caeb6c8baef31
- main / PR base: aff689da63c04e3a48e5b8f541d9a1573ad1b382。取得したPR metadataはopen、mergeable=true。
- コミット・stageなし。作業ツリーの既存差分は保持。
- 本番用変更はH1の条件付きmvp_managed INSERT権限とH4のcore INSERT前提チェック。どちらも事前にユーザーが許可した最小修正。
- 既存18本、H2/H3、アプリ本体は不変。H1/H4を含む実環境検証時の22 SQLと既存検証コード・fixtureのハッシュも不変。
- 旧Docker/WSLの実行経路は廃止。stacks.mjsは即時拒否、旧safety.mjsは削除対象。廃止した運用コードはGit履歴と非公開archiveに保持し、現在の実行候補に含めない。
- [レビュー53件の対応表](issue35-review-resolution.md)を参照。GitHub上の返信・Resolveは未実施。

## 確定結果

| 環境・段階 | 成功 | 失敗 | 未実施 | 確認内容 |
|---|---:|---:|---:|---|
| 最終オフライン | 110 | 0 | 0 | 75件の既存cloud/review反例と35件のB再現検証 |
| B限定再開のオフライン | 17 | 0 | 0 | Vaultの厳密な組合せと停止時状態・履歴・データの反例 |
| A | 106 | 0 | 1 | 新規DBの22本適用、機能・権限・Realtime・異常系 |
| B | 103 | 0 | 1 | 既存構造の合成再現、履歴補完、追加適用、保持と全スイート |
| C | 2 | 0 | 0 | 公式CLIの22件認識、23本目適用、履歴・ACL、再dry-run |
| 実環境A/B/C合計 | 211 | 0 | 2 | 現在の完了済みレポートだけを集計 |

過去の263件は最初のコミット時のDocker構成による歴史的結果で、今回の211件やオフライン127件へ加算しない。途中の失敗・中断は消しておらず、最終成功件数へも加算していない。29 mjsの構文検査は最終オフライン時に成功。今回、新しい試験・構文試験の再実行はしていない。

未実施2件は同一種類の試験がA/Bに1件ずつ記録されたもの。Hosted環境でsupabase_adminのロール継承を故意に変更する権限がなく、注入を実行していない。実効GRANT OPTION、ロールmetadata、前提ガードとオフライン反例を用い、管理ロールの権限を強制変更していない。その他、旧Docker API/firewall/全管理schema pristine検証は旧方式の対象外であり成功と数えない。

## 検証範囲

Auth登録・初期OFF、プロフィール表示/本人編集と禁止書込み、端末登録/本人削除/他人拒否、初回30/60/120/180分の期限精度、OFF/期限切れでの期限クリア、ON競合、実lock待ち後の期限、終了前通知・暇ON通知、対象者選別・複数groupの重複排除、lease/再試行/古いtoken拒否、group管理・archive、chatのRETURNING star/idempotency/pagination、Realtimeの非所属・leave/rejoin/archive/Auth削除、quota/rate limitを検証した。

期限誤計算・期限クリア欠落・通知対象条件の迂回・通知重複、GRANT OPTION誤付与などの意図的な誤実装を既存テストが検出。H1直後のgroup作成、H4の必須列INSERT欠落、SQL/history原子性、異常分類のrollback、H1〜H4再適用時のON値保持も確認した。外部Pushはmock、メールは送信防止設定を使用。実端末Push、UI操作、本番負荷、共有DBでの動作は保証範囲に含めない。

## A/B比較・Cの状態

- A/Bの対象カタログ17項目は、以下の既知の物理差を除いて一致。SQL・コード・fixtureのハッシュは完全一致。
- profilesはBに削除済み第5列の欠番がある。A/Bの論理列順・型・default・権限は一致し、欠番だけを厳密に検証して別記録。未知の欠番や順序差は許容しない。全物理構造が同一とは主張しない。
- 関数本文のCRLFはLFへ正規化する。既存の限定的なsyntheticコメント除去は残るが、任意の処理差・コメント差を無視するものではない。
- Bの元プロフィール9件・room3件は保持。実roomの分類を推測せず、由来を明示したMVP/legacy合成データと分類不能ケースを使用。
- CはBの比較後に実施。公式Supabase CLI 3.1.0で20990101000000_issue35_forward_probe.sqlを非公開のunlinked CLI作業dirだけに追加した。
- C後のBは履歴23件。元22件のSQL本文、既存アプリの構造・権限、アプリ11＋Auth3テーブルの件数・データhashが不変。probeは空で、PUBLIC/anon/authenticated/service_roleの権限なし。
- 適用後の公式CLI一覧は23件、再dry-runはup to date。既存migrationの再適用はない。Cスクリプト全体は一回限りの設計。
- C前のA/B snapshot・比較結果は保持し、C後状態で上書きしていない。C後のB全体を22件時点のAと再比較するものではない。
- Aはユーザーが削除済み。Bは保持中。削除・初期化や追加検証を自動実施しない。

## 例外と途中停止

1. Vault: 共有DBの調査値はsupabase_vault 0.3.1/schema vault、Bは0.3.2/schema vault。Aの拡張versionは保存証跡にない。imahimaのmigration・アプリ・通知・CronにVault呼出しは見つからず、公式0.3.2のupgrade SQLは2つのVault SECURITY DEFINER関数のsearch_pathをpg_catalog, pg_tempに固定する安全性修正。ユーザー承認により、この正確な組合せだけをBで許容した。他拡張・配置・ACL/default権限・履歴の検査は維持。拡張変更なし。
2. 最初のBはVault完全一致ガードで停止。履歴7件・合成データを残したまま、停止時カタログ、7件のSQL本文、identity/nonce/TLS/SSL、データ・Cron・権限・全拡張の状態を照合した。一回限りの補助手順で履歴補完と追加適用へ進み、markerだけを消した再実行はしていない。
3. 次のB機能検証は40成功後、pg.ClientのConnection terminated unexpectedlyで中断。ユーザー移動によるネットワーク断の可能性が報告されたが、根本原因を断定していない。新規接続で状態・22履歴・残存合成データ・期限切れrate窓を確認し、コードやmigrationを再適用せず機能スイートを再実行した。47件と後続スイートは成功。
4. 切断時の未処理Client errorはプロセスを終了させた。接続の自動再試行や一般的な回復機構は追加していない。再発時は停止して状態確認が必要。

限定的な再開手順はAで実行済みの共通コードではない。既存コードとfixtureを変更せず、非公開runtimeに追加した3ファイルのhashを別記録した。[実行不能な原文写しとhash](../verification/issue35/evidence/issue35-20261119-182033/resume-evidence.json)をレビュー用に保存する。写しは運用entryではなく、既存Bに再実行してはならない。

以前の診断CLIがユーザー共通telemetry.jsonを更新した履歴は旧報告書に残す。変更前内容がなく推測復元していない。現在のCLI経路は専用HOME/USERPROFILE/SUPABASE_HOMEとtelemetry無効設定を使う。既存環境への影響が歴史全体で完全にゼロだったとは主張しない。元作業ツリー・既存18本・アプリ本体の不変は確認済み。

## 証跡とコミット範囲

- [A集計](../verification/issue35/reports/cloud/issue35-20261119-182033/a/execution-summary.json)
- [B最終集計](../verification/issue35/reports/cloud/issue35-20261119-182033/b/execution-summary-final.json)
- [C集計](../verification/issue35/reports/cloud/issue35-20261119-182033/b/c-execution-summary.json)
- [A/B/C最終集計](../verification/issue35/reports/cloud/issue35-20261119-182033/b/abc-execution-summary.json)
- [候補ファイル全件](issue35-commit-files.tsv)。status Dは削除対象。stageは行わない。

候補は本番H1/H4の最小差分、凍結済み検証コード・安全ガード、設定テンプレート、読み取りmetadata fixture、最終文書、cloudの確定済みJSON21件、再開手順の実行不能な写し。既存コミットにあるH2/H3・18本・旧結果14件は再変更しない。

対象外は.runtime全体、実target JSON・DB接続情報・APIキー・password・実nonce・CA/秘密鍵・rawログ・snapshot・個人データ、node_modules、旧環境/volume、Cの23本目SQL。Bの途中停止JSON2件、旧途中JSON13件、文字欠落のある中間草稿3件は保持するがコミット候補に入れない。旧失敗ログは別名・hash付きarchiveで保持。実データのあるbackupはGitへ入れない。

秘密検査は候補ファイル全体で、設定ファイル中の実キー・password・nonceとそのJSON/URL表現、JWT・private-key・connection-stringを確認する。テンプレートplaceholderと明示的なsynthetic test値は実秘密と区別する。実nonceを本文・候補manifestへ出力しない。

## 共有DBへの適用前に残る作業

予定済みの検証は完了。以下は新しい検証基盤の開発ではなく、共有DB適用の承認前条件・運用手順であり、まだ実行していない。

1. 対象project identityを再確認し、現在の履歴・schema・ACL/GRANT OPTION・default ACL・関数・Cron・publication・拡張・行数/暇状態を読み取りで更新する。2026-11-19のスナップショットだけで現在の状態を断定しない。
2. バックアップ方式、取得時点、保管先、取得成功、復元担当、RPO/RTOと復元手順を確認する。標準dumpの除外範囲を確認し、Auth、アプリdata/schema、migration履歴、role/default ACL、Cron/publication等を必要範囲で確保。秘密情報は非公開保管。復元リハーサルを実施済みとは報告しない。
3. 履歴7件の元statements完全一致は未確定。履歴なしで効果があるinitial_schema/enable_pg_cron/group_managementの3件は補完候補であり、Bのsynthetic adoptionは共有repairの根拠ではない。実定義・依存・元履歴との照合とversion別判断を文書化し、repairを別承認する。
4. handle_new_userの実本文を確認し、日本語コメントによるhash差と処理差を分ける。初期OFFの現在動作を保持する。実roomは当時3件だったが、現在数と全IDの根拠付き分類が必要。作成者なし/空/archivedなどから管理区分を推測しない。
5. 旧版・他アプリ・外部workerの利用状況を確認する。特にprofilesへの直接INSERT/保護列UPDATE、service_roleの管理用途、select star/RETURNING・INVOKER row lockへの影響を整理。リポジトリの検証だけで未知クライアントへの無影響を断定しない。
6. メンテナンス時間と担当を決め、必要な書込み・worker・Cronを停止してその元設定を記録する。全停止が不要な処理を推測で止めず、適用台帳と復旧点を承認する。実データの暇状態をOFFへ初期化しない。
7. Bで確認した順序・同じSQL hashをversion別台帳にする。restriction→H1を先行し、通知/timer修正/index→H2、chat→H3、根拠付き分類/archive→H4へ進む。各SQLと履歴記録は同一transaction。既存7件や適用済みSQLを盲目的に再実行しない。通常CLIの時刻順一括pushがこの移行順序を再現するとは仮定しない。
8. 合意した履歴補完と不足SQLだけを、別途承認された共有DB用手順で実施する。今回のcloud runnerは共有refを拒否する検証専用であり、本番用にguardを外して流用しない。
9. 各段階の構造・権限・データ保持を確認し、最終22件と実スキーマを照合する。検証用ユーザー・通知・messageを共有DBへ投入しない。利用者の実操作や通知再開は別途承認された範囲で確認する。
10. worker/Cronを記録した設定に戻し、通常migration管理へ戻す。version一覧一致とpendingなしを確認。以後は新しい前方migrationを通常CLIで管理する。Cはその経路の根拠だが、共有DB実行済みを意味しない。

停止条件: identity/TLS/backup不足、未知の履歴やschema/ACL/拡張差、room未分類、他クライアント影響未解消、lock/statement timeout、SQL失敗、想定外のデータ変化があれば停止。版差例外を他拡張へ拡大しない。H1だけの恒久再適用で後続権限を修復しない。

復旧手順: 失敗した現在のtransactionをrollbackし、最後にcommitしたversionと状態を記録。前段のcommitは自動で戻らないため書込み再開を急がない。承認済みsnapshot/適用台帳と照合し、最小の前方是正かバックアップ復元を判断する。必要なら利用者の書込みを停止したまま合意した復元点へ戻し、Auth・履歴・role/default ACL・Cron/publicationも整合させる。GRANT ALL、RLS無効化、履歴削除・推測repairで通さない。復元によるデータ損失や共有DB操作は別承認が必要。

バックアップ状況、実room分類、外部クライアント、共有DBの最終履歴補完判断は未確定。共有適用・確認が完了するまでRefs #35として継続し、自動closeを指定しない。

## コミット案

fix(db): address ACL review and verify hosted migration paths (#35)

コミット本文ではRefs #35、H1/H4の最小修正、211/0/2、offline 110+17、Vault/物理差/再開、共有DB未適用を明記する。コミット・Push・マージは未承認。

## 最終整理の確認結果

- コミット候補71項目: 変更21、新規49、削除1。全件はissue35-commit-files.tsv。
- 内訳: 本番SQL 2、検証コード/設定/運用文書37、metadata fixture 3、再開処理の実行不能な記録4、確定結果JSON 21、docs/文書4。
- 削除1件は旧safety.mjs。H2/H3と元18本・アプリ本体は対象差分なし。
- 対象外: 中間草稿3件、B途中停止JSON2件、従来の途中JSON13件、全非公開runtime/キー/nonce/ログ/snapshot、Cの23本目SQL。
- 候補全文の実秘密値・JWT・private-key・接続文字列検査で該当0。UTF-8/末尾空白確認とgit diff --check成功。
- stage済みファイル0。コード・SQL・fixtureは実環境検証時のhashと一致し、再開記録の原文写しも元hashと一致。
- 既存証跡は変更せず保持。今回はDB接続・検証項目追加・試験再実行・project削除・コミット・Push・PR更新なし。
