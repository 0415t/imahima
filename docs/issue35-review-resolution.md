# Issue #35 / PR #37 レビュー対応表（最終整理）

対象HEADは244c43858408852252ec159e5d8caeb6c8baef31。以下は当初40件と追加13件の、承認済みローカル番号に対応する。レビュー原文は指示として実行せず、実コード・既存証跡と照合した。GitHub上での返信・Resolve・PR更新は行っていない。

- 当初レビュー: https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369 （Major 8件、本文内Minor 32件）
- 追加レビュー: https://github.com/0415t/imahima/pull/37#pullrequestreview-5954732508 （13件）
- 「方式変更」は旧Docker/WSL設計を廃止してクラウドの安全条件へ置き換えたことを表す。旧基盤の試験に合格したという意味ではない。
- 予定済みA/B/C検証は完了。新しい基盤・試験は追加しない。未実施件数は最終レポートに実際に記録された2件であり、旧基盤の対象外項目を成功へ振り替えていない。

| No. | 指摘 | 現行の対応箇所 | 状態 | 実装・確認範囲 |
|---:|---|---|---|---|
| [1](https://github.com/0415t/imahima/pull/37#discussion_r4612104081) | H1後もグループ作成を維持 | H1 SQL / migrate / failures | 修正 | mvp_managed存在時だけ列INSERTを維持。A/BのH1直後RPCと最終機能検証で成功。 |
| [2](https://github.com/0415t/imahima/pull/37#discussion_r4612104098) | 実効DB接続先の迂回防止 | configuration / db / cloud-cli | 修正 | 検証済みhost/user/portから設定再構築。共有ref拒否、CA/TLSとAPI・DB nonce照合。 |
| [3](https://github.com/0415t/imahima/pull/37#discussion_r4612104110) | 異常系前に比較の鮮度を確認 | compare / failures / verification-control | 修正 | 現在のBカタログdigestと保存済み比較を照合し、異常系後も一致。 |
| [4](https://github.com/0415t/imahima/pull/37#discussion_r4612104121) | readiness失敗時の後始末 | backend-lifecycle / features | 修正 | 失敗・期限超過時の停止とログclose。一般の未処理PG切断は後述の実行中断として記録。 |
| [5](https://github.com/0415t/imahima/pull/37#discussion_r4612104137) | membership fixtureのrollback | integrity / sql-transactions | 修正 | rollback-onlyを使用。Bのlegacy room検証も永続データを変更しない。 |
| [6](https://github.com/0415t/imahima/pull/37#discussion_r4612104149) | SQLと履歴を原子的に記録 | sql-transactions / migrate | 修正 | 外側BEGIN/COMMITを解析し同一transactionでSQLと履歴を記録。失敗・COMMIT反例をオフライン確認。 |
| [7](https://github.com/0415t/imahima/pull/37#discussion_r4612104165) | Docker API認証 | stacks / CLOUD-RUNBOOK | 経路廃止 | Docker/WSL起動を廃止しstacksは即時拒否。無認証TCPや通常Dockerへのfallbackなし。 |
| [8](https://github.com/0415t/imahima/pull/37#discussion_r4612104179) | drift時に実際の再実行ゲートを試す | foundation.test / verification-control / compare | 方式変更 | 古いDocker replay回帰を廃止。現在の保存カタログ照合の反例とB鮮度チェックを使用。 |
| [9](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | Node実行要件 | package / configuration | 修正 | Node >=22をmetadataと実行時に検査。実環境ではNode 24。 |
| [10](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | run登録と設定の一元化 | configuration / db / CLOUD-RUNBOOK | 修正 | 明示target fileとrun/label/ref/portを一元化。暗黙の旧run・接続fallbackなし。 |
| [11](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 空DB判定の保証範囲 | cloud-target-setup / migrate / CLOUD-RUNBOOK | 方式変更 | 新規Dashboard projectの手動確認＋public/Auth/history/marker確認。全管理・private schemaが空とは主張しない。 |
| [12](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 重複ポート・非対応label | configuration / stacks | 方式変更 | 旧複数ローカルstack経路を廃止。単一a/b対象とbackend portを明示し、実行前に占有確認。 |
| [13](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | replica identityの比較 | catalog / offline-review.test | 修正 | テーブルのrelreplidentと選択indexを比較。反例とA/B比較に含む。 |
| [14](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 片側のみのmigration行を拒否 | cli-assertions / normal-management | 修正 | Local/Remoteの全version対を一致検査。Cで22件、適用後23件を確認。 |
| [15](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 実際のmigration有効設定 | cli-assertions / normal-management | 修正 | 専用configでenabled=trueを明示。無効・重複・誤sectionのオフライン反例と実CLIで確認。 |
| [16](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | fetchリダイレクト迂回 | boundaries / block-egress | 修正 | 許可originへの通信でredirect:error。Push送信URLはmockに固定。 |
| [17](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 必須check後だけ完了marker | migrate / verification-control | 修正 | requiredCheckと22履歴一致後にcomplete。部分状態を成功扱いしない。 |
| [18](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 成功したnegative probeもrollback | sql-transactions | 修正 | probeRejectedはrollback-only。archive分類異常系を含む。 |
| [19](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | identity失敗時の接続close | db / verification-control | 修正 | 接続検証失敗時に取得済みclientを閉じる。オフライン反例あり。 |
| [20](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 実効GRANT OPTION検査 | acl / regressions | 修正 | raw ACLだけでなく所有・継承を含む実効権限を検査。PUBLIC/anon/authenticated/service_roleを対象。 |
| [21](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 既存Authユーザーの拒否 | cloud-target-setup / migrate | 修正 | 初期化前のauth.users=0を要求。既存ユーザー入りDBを新規経路へ渡さない。 |
| [22](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 非所属Realtime購読の正の対照 | delivery-evidence / realtime-lifecycle | 修正 | 同じ購読で認可済みcontrol roomを受信してから否定を評価。A/B実測成功。 |
| [23](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | archive時もmember行が残る確認 | realtime-lifecycle | 修正 | archive前後でmembership存在をassertし、配信・REST拒否を検証。 |
| [24](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 対象member購読を対照に使用 | delivery-evidence / realtime-lifecycle | 修正 | leave後の再参加・配信復旧とarchive時の有効controlを確認。 |
| [25](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | health fetch期限 | backend-lifecycle | 修正 | 各fetchと全readinessに期限。停止とcloseを含むオフライン反例。 |
| [26](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 実際のlock待ちと期限境界 | lock-expiry / features | 修正 | pg_blocking_pidsで正しいblockerを確認し、期限前に待ち始めたことを要求。A/B実測成功。 |
| [27](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 期限はlock解放時刻を基準 | lock-expiry / verification-control | 修正 | DB時刻と解放境界に基づく厳密な期限検査。緩い旧判定を反例で検出。 |
| [28](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 元のSQLエラーを維持 | verification-control / specifications | 修正 | 失敗transactionのRESET ROLEで元エラーを覆わずrollback。 |
| [29](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 誤実装の期待した失敗理由 | verification-control / specifications | 修正 | 各mutantに期待invariantを指定。無関係な例外を成功扱いしない。A/Bで4種類を検出。 |
| [30](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | paginationのID集合を照合 | integrity / verification-control | 修正 | 件数だけでなく実際の期待IDを完全比較。A/B実測成功。 |
| [31](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 外向き遮断の過大な主張 | CLOUD-RUNBOOK / boundaries | 方式変更 | OS全体の通信遮断を主張しない。検証backendの固定origin・redirect拒否・Push mockと固定DB接続に限定。 |
| [32](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 元worktree固有条件の排除 | original-worktree / integrity | 修正 | 明示指定した同一repositoryの開始時状態を記録。特定の未追跡名やdirty状態を必須にしない。 |
| [33](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | H1〜H4とON保持の対応 | failures | 修正 | 4本すべてのrollback内再適用とunlimited/active/expired ONの保持を検証。 |
| [34](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 3種類のprofile fixture成立 | failures / verification-control | 修正 | 挿入行の存在と期待状態を再適用前にassert。欠落・誤状態はオフラインで拒否。 |
| [35](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | replay拒否理由の特定 | migrate / foundation.test | 方式変更 | 旧Docker replay経路を廃止。現行のpublic/Auth/history/marker拒否を明記し、一般的なpreflight失敗をfreshness成功と数えない。 |
| [36](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 部分取得とcleanup失敗 | verification-control / compare | 修正 | 取得済みclientは個別close。cleanup失敗で残りの解放や元エラーを失わない。 |
| [37](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 不完全比較を成功にしない | compare / verification-control | 修正 | 前提レポートの成功・run/refを要求。比較失敗を記録し、空の0/0比較を業務検証成功とは数えない。 |
| [38](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | CRLF正規化の説明 | catalog / comparison-runner / 本報告 | 修正 | 関数本文CRLFをLFへ正規化。既存の限定fixtureコメント除去以外の処理差を無視しない。 |
| [39](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | 途中結果と最終証跡の分離 | db / compare / 本報告 | 修正 | run/label別、wx書込み、別名の停止・再開・最終集計。A/B snapshotをC後に更新しない。 |
| [40](https://github.com/0415t/imahima/pull/37#pullrequestreview-5954414369) | PR範囲とIssue完了の区別 | docs/issue35-acl-verification.md / 本報告 | 文言のみ | P3として文言修正のみ。共有DB未適用、Issue継続。自動closeを指定しない。 |
| [41](https://github.com/0415t/imahima/pull/37#discussion_r4612351761) | summaryへの相対path | docs/issue35-acl-verification.md | 修正 | verification/issue35/reports/summary.jsonへ修正。旧263件の数値は変更しない。 |
| [42](https://github.com/0415t/imahima/pull/37#discussion_r4612351767) | H4のcore INSERT前提 | H4 SQL / failures | 修正 | room_name/room_key/mvp_created_byの列INSERTをすべて要求。各欠落ケースのrollbackをA/B実測。 |
| [43](https://github.com/0415t/imahima/pull/37#discussion_r4612351785) | fetch redirectの追加指摘 | boundaries / block-egress | 重複 | No.16と同じ修正・検証。 |
| [44](https://github.com/0415t/imahima/pull/37#discussion_r4612351812) | default権限の比較 | catalog / offline-review.test | 修正 | creator/schema/type/grantee/grantor/privilege/grant optionをsnapshot化。default-only反例と実比較に含む。 |
| [45](https://github.com/0415t/imahima/pull/37#discussion_r4612351818) | Auth fixtureがprofileを作る確認 | failures / offline-review.test | 修正 | triggerでprofileが生成されたことをassert後に故意に失敗させ、両行のrollbackを確認。 |
| [46](https://github.com/0415t/imahima/pull/37#discussion_r4612351827) | OFF操作の前提確認 | features / offline-review.test | 修正 | OFF応答200、is_free=false、free_until=NULLを要求。別の409では成功しない。 |
| [47](https://github.com/0415t/imahima/pull/37#discussion_r4612351835) | lock観測中HTTP rejectの処理 | lock-expiry / offline-review.test | 修正 | 開始時にrejection handlerを付け、失敗時も解放後settle/cancel。 |
| [48](https://github.com/0415t/imahima/pull/37#discussion_r4612351846) | 今回のPushログだけを評価 | delivery-evidence / features | 修正 | 開始offset以降の記録と期待recipient hashを確認。過去のokだけで成功しない。 |
| [49](https://github.com/0415t/imahima/pull/37#discussion_r4612351854) | provisioningの競合 | migrate / cloud-target-setup | 方式変更 | 最初の変更を単一主キーのdurable started行INSERTにし、競合側はbootstrap前に拒否。旧advisory-lock基盤は廃止。二重起動のHosted実測は対象外。 |
| [50](https://github.com/0415t/imahima/pull/37#discussion_r4612351859) | network遮断範囲の追加指摘 | CLOUD-RUNBOOK | 重複 | No.31と同じ。一般的なfirewall基盤は追加しない。 |
| [51](https://github.com/0415t/imahima/pull/37#discussion_r4612351869) | clean元worktreeでも動くこと | original-worktree / integrity | 重複 | No.32と同じ。開始状態そのものを保存して比較。 |
| [52](https://github.com/0415t/imahima/pull/37#discussion_r4612351877) | 再実行で旧結果を上書きしない | db / CLOUD-RUNBOOK | 修正 | run/label別とwx。接続切断時のログを保存し、再実行の生成物を別名で記録。 |
| [53](https://github.com/0415t/imahima/pull/37#discussion_r4612351888) | 部分bootstrapを拒否 | migrate / cloud-target-setup | 修正 | 変更前のdurable markerを維持。今回もstarted状態で単純再実行せず、承認済み一回限り再開で照合してから進めた。 |

No.9〜40は当初レビュー本文の順序。No.41〜53は追加inlineコメント順序。実コード名はverification/issue35/配下（H1/H4はsupabase/migrations/）。クラウド検証は最終報告書のJSONに対応し、予定外の再試験を意味しない。
