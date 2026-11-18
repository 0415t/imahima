# PR #26 最新レビュー対応と旧スレッド再評価

2026-11-17。開始時の`.review-pr26`は`feat/group-chat-backend`、HEAD `5e1b3e9`、作業ツリーはクリーン。GitHubのPR headも同一で、baseは`main` (`885b606`)。他worktree・他PRの変更は取り込んでいない。コミット・ステージ・Push・PRマージ・スレッドResolveは行っていない。

## 最新2件

### 大文字・小文字混在URLのエラー分類

[指摘](https://github.com/0415t/imahima/pull/26#discussion_r4600459236)は妥当。`requestDeadline`は既にcase-insensitiveだったが、`app.ts`のgroup判定と`chat.ts`の`isChatPath`はcase-sensitiveだった。修正前の追加テストは、resourceが大文字の場合に`INVALID_INPUT`欠落、prefixも混在の場合にHTML応答で失敗した（lowercase 1成功、混在2失敗）。

両正規表現に`i`を追加した。期限判定と同じURL範囲になり、ルーターの前後関係や認証は変更しない。lowercase・大文字resource・混在prefixの不正JSON/サイズ超過で、400 `INVALID_INPUT` / 413 `PAYLOAD_TOO_LARGE`、`Cache-Control: no-store`、RPC未実行を確認。既存の混在URLタイムアウトに混在POST送信も追加し、Auth・membership・RPC停止時の503 `CHAT_UNAVAILABLE`を確認。通常のチャット4 APIとグループ・タイマー・通知の回帰も成功。

### DBロックタイムアウトの証拠不足

[指摘](https://github.com/0415t/imahima/pull/26#discussion_r4600459247)は妥当。従来の「HTTP 503、全体4500ms以上、解除後の再送201」は、最初のAuthだけがタイムアウトしても成立する。これを満たすAuth503のテストデータに対し、新しい証跡検査が拒否することを確認した。

送信をawaitせず開始し、共通の期限付き`waitForBlockedRpc`で、この新規テストの`chat_send_message`がroom blockerの待機連鎖に入ったことを確認してから結果を待つ。request IDを保存してAuth・membership成功、当該send RPCの処理時間、SQLSTATE `55P03`またはRPCのAbort/Timeoutだけを検証する。別requestの失敗、membership失敗、即時RPCエラー、別RPC、重複試行では合格しない。fetcherはエラー/成功のいずれでもstage時間を記録し、DB応答からはSQLSTATEのみを保存する。

同ファイルの固定100ms待機もDB barrierへ置換した。COMMIT hookはHTTP 200のRPC応答に限り通知する。request完了・失敗・期限のrace、遅延responseの解放、HTTP close、blocker rollback/end、監視接続endという既存cleanupを維持し、blockerのquery_timeoutも10秒にした。DB待機確認は失敗時に未完了監視を待ち直さない。既存接続・他セッションの強制キャンセルは追加していない。

## 古い未解決6件

| 指摘 | 個別判定 | 現在の根拠・今回の検証 |
|---|---|---|
| bind-loopback: Docker接続先 | 修正済み | `dockerSocket()`を使用しCLIと同じDOCKER_CONTEXT / DOCKER_HOST / active context優先順位でunix/npipeを解決。start前にも非対応endpointを拒否。優先順位・socket・拒否の回帰成功。実daemon切替は未実施。 |
| local-stack: 秘密情報の権限 | 修正済み（POSIX実効値は未検証） | runtimeに0700、秘密情報の新規作成に0600、既存2ファイルもchmod。既存内容保持テスト成功。Windows環境でありPOSIX mode検証分岐は実行していない。Windows ACLの保証とは区別する。 |
| realtime: 保護対象ファイル不在 | 修正済み | 前後snapshotで共通の`fileFingerprint`を使用し、ENOENTだけをnullにする。作成・変更・削除、その他readエラーの回帰成功。 |
| realtime: 履歴100件超 | 修正済み | initial/fresh/coldの各履歴取得に`completeHistory`を使用。全ページを取得し初回watermarkを保持。250件・cursor反復の回帰成功。実Realtime全体は未実施。 |
| timeout: COMMIT待機の無期限停止 | 修正済み | `waitForBarrier(commitSeen, first, ...)`で早期完了・失敗・5秒期限を監視しfinallyへ戻る。barrierの異常系、遅い観測query、launcher cleanup回帰成功。今回hookの成功条件も明示。 |
| app: deadlineのcase不一致 | 修正済み | 実際の期限判定元`timeouts.ts`はgroup/chat両方`i`指定、router進入前に分類を保存。混在URLのAuth・membership・RPC停止とPOST送信で503コードを検証。今回のparser不一致は別問題として上記で修正。 |

GitHub上では最初の5件がOutdated、古いappの期限指摘は未解決かつOutdatedではない状態だった。分類はコードとテストに基づき、GitHubのResolve状態を勝手に変更していない。「現行構成では該当しない」として除外した指摘はない。実環境の未検証条件は修正済み判定と別に残す。

## 変更ファイル

- `server/app.ts`: groupパースエラー判定をcase-insensitive化。
- `server/chat.ts`: chat URL判定をcase-insensitive化。
- `verification/group-chat-local/timeout-integration.mjs`: 対象sendのDB barrier、request別RPC証拠、期限・後処理、固定待機除去。
- `verification/group-chat-local/timeout-evidence.mjs`: request別証拠の検査（新規）。
- `tests/test-chat.ts`: 混在URLのパースエラー/サイズ超過。
- `tests/test-timeouts.ts`: 混在POST送信の期限回帰。
- `tests/test-chat-review.mjs`: Auth503誤認・stage証拠の正常/異常系。
- `tests/test-chat-lock-timeout.mjs`: 新規隔離DB専用の実lock timeout回帰（新規）。
- `docs/pr26-latest-review.md`: 本記録（新規）。

## 実施結果

| 実行 | 成功 | 失敗 | skip |
|---|---:|---:|---:|
| `node --import tsx --test "tests/**/*.ts"`（helperロードを含む） | 202 | 0 | 2 |
| `node --test tests/test-chat-review.mjs` | 20 | 0 | 0 |
| 隔離fixtureで`node --import tsx --test tests/test-chat-lock-timeout.mjs tests/test-chat-db.ts` | 2 | 0 | 1 |
| `node tests/test-chat-db-concurrency.mjs` | script成功 | 0 | 0 |

単体のskip 2件は実DBモード未指定によるもの。隔離fixtureのskip 1件は実Supabase/Auth/Realtimeモード。関連3ファイルを指定した回帰も42成功・失敗0・skip 0（全体実行と重複するため加算しない）。全体TypeScript (`tsc --noEmit`)、変更8コードファイルのESLint、構文確認、`git diff --check`、commit hygiene（staged 0、issues 0）は成功。

DB統合は新規`imahima-chat-db-verification`のみ。名前が未使用であることを確認し、`postgres:16`、専用task label、network none、公開ポートなし、PGDATA tmpfsで起動。本起動は内部TCPのpg_isreadyで同期確認。fixtureとmigrationはこの新規DBだけに適用し、元からあるDB・本番・共有Supabaseには適用していない。テスト側もlabel/image/network/port/tmpfsを検査し、Authはstub、RPCは実PostgreSQLを使用。room lock待機の実測後、SQLSTATE `55P03`とHTTP503、message未作成を確認した。別の既存HTTP→実RPCテスト、およびquota/冪等性/連番/重複削除/leave-send両方向の競合回帰も成功。終了時は作成IDとlabelを再照合し、今回のtmpfsコンテナだけを停止・削除した。既存volumeは変更しない。

途中の失敗: 修正前URL回帰の2失敗は再現確認。新規DBテストの初回はDockerのtmpfsオプションが空文字であることを未設定と誤認し、assertで停止した（HTTP/RPC既存テスト1成功、新規1失敗、skip 1）。存在キーの検査へ修正し、別の新規fixtureで再実行して上表の結果になった。初回失敗は成功として計上しない。

## 残存リスク・マージ時の懸念

- 元の`timeout-integration.mjs`全体は実Auth/PostgREST経由で再実行していない。既存専用スタックの所有パスは元worktreeであり、このworktreeからの所有確認を迂回しない。新規隔離テストはAuthをstubにしており、実PostgreSQLの期限/RPC検証と区別する。
- 実daemon context切替、POSIX実効mode、実Realtime/購読/配送、実スタックへのOS signal注入は未検証。過去のRealtime初回欠落・歴史的room配送・単発client timeoutを今回解消済みにはしない。
- 既存roomの分類入力、chat/archive migrationの適用順序とその間の書込み、既に空のroomの是正は別の運用判断。マージだけではDB適用や是正は完了しない。
- 今回の変更は未コミットでPRに未反映。コード修正・ローカル検証とCodeRabbitによる承認/Resolveは別扱い。今回は外部送信・Resolve・コミット・Push・PRマージは行わない。
