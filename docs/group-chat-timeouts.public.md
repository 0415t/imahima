> Anonymized historical copy. Original retained locally. Current guidance: [backend](group-chat-backend.md) and [verification](group-chat-verification.md). Historical failures are preserved; old commands are not current deployment instructions.

# グループチャットのタイムアウト

最終判定は[FINAL-VALIDATION-RESULTS.public.md](../verification/group-chat-local/reports/FINAL-VALIDATION-RESULTS.public.md)参照。元の25秒タイムアウトは原因未確定のまま保持し、20秒期限の成功と区別する。

第3段階の追加計測・再現結果は[PHASE3-RESULTS.public.md](../verification/group-chat-local/reports/PHASE3-RESULTS.public.md)に記録する。元の失敗は以下に保持する。

## 制限時間と責務

| 対象 | 期限 | 理由 |
| --- | --- | --- |
| Auth通信 | 5秒 | 認証障害でリクエストを長時間保持しない |
| PostgREST通信の1試行 | 8秒 | 既存RPCのロック待ち5秒に通信・実行の余裕を加える |
| `/groups`配下のHTTP処理 | 20秒 | 通常のAuth→所属照会→RPCを包含し、逐次通信の合計も制限する |
| チャットRPCのロック待ち | 既存の5秒 | 今回DB定義は変更しない |

時間はアプリ側の運用初期値。負荷測定により再評価する。全リクエストが各通信上限を使い切れる保証ではなく、HTTP全体期限が優先する。

`server/timeouts.ts`がリクエスト単位のAbortSignalをAsyncLocalStorageで伝播する。Auth・所属・レート照会・RPCの待機を囲み、期限超過やクライアント切断の後は次の段階を開始しない。別リクエストのキャンセルとは共有しない。

共通Supabaseクライアントに期限付きfetchを指定する。Authは`/auth/v1/`で分類し、それ以外の通信には8秒を使う。呼出元のsignalも尊重し、ヘッダー受信だけでなく本文の読取完了まで期限を保つ。SDKがキャンセルを無視する場合も待機を打ち切るが、実行済みの外部副作用は取り消さない。レスポンス本文は一旦バッファするため、将来の大容量・ストリーミング用途には別設計が必要。

SDKにはAbortSignalを受け取る通信経路があり、PostgRESTにはリトライ処理もある。SDKのデフォルトにAPI全体の期限を委ねず、呼出し全体の20秒を独立して設けた。SDKの遅延完了・再試行も期限切れのrequest signalを継承する。

HTTP期限はJSONパースより前に開始する。正常終了・切断時にタイマーを解除し、遅れて届く処理結果で二重応答しない。`/health`・既存の暇状態HTTPルートには20秒のグループ用ミドルウェアを適用しない。ただし共通Supabaseクライアントを使う通信には5秒/8秒の期限が適用される。

## HTTPエラー

- JWTなし、既知の無効・期限切れJWT: 401。第1段階の分類を維持。
- Auth通信期限、PostgREST通信期限、通信障害、RPCロック待ちエラー、HTTP全体期限: 503。
- チャットは既存の`CHAT_UNAVAILABLE`、グループは固定のエラー本文を返す。SDK・SQL・JWT・本文の詳細は返さない。
- クライアントが切断済みの場合、応答到達は保証しない。

## キャンセルと再送

HTTP待機打切り、fetchのabort、PostgreSQLのクエリ中止、トランザクションのrollbackは同義ではない。今回、DBに永続的なstatement_timeoutを追加していない。マイグレーション冒頭の`SET LOCAL statement_timeout`は適用トランザクション専用であり、通常RPCの実行期限ではない。

送信後に503・切断となった場合、DBコミット済みの可能性がある。必ず同じ`client_message_id`・同じ正規化本文で再送する。既存RPCのユーザー→roomロック、UNIQUE、成功台帳を再利用し、Expressで冪等性や送信クォータを再実装しない。別本文は409、論理削除後は200のtombstoneを返す。

## 検証方法

DB不要のモック・回帰:

```powershell
node --import tsx --test --test-concurrency=1 tests/test-timeouts.ts tests/test-auth-classification.ts tests/test-chat.ts tests/test-groups.ts tests/test-profile-toggle.ts
```

専用ローカルのみの結合検証:

```powershell
node --import tsx verification/group-chat-local/timeout-integration.mjs
```

ハーネスは既存の接続先検証を使用し、専用DBのホスト・ポート・クラスタ識別子・Dockerラベルを照合する。新規テストユーザー・roomだけを使用し、既存データを初期化しない。roomロック中の通信切断、5秒のロック待ち失敗、実RPC成功後の応答喪失、並行再送、409、削除後再送、10件制限を確認する。テストデータと結果JSONは保持する。Authユーザー削除は自動実行しない。

結果JSONはGit対象外の`verification/group-chat-local/.runtime/timeout-*.json`。秘密情報は記録しない。失敗時は停止し、原因を確認してから次の試行を判断する。

## 実施結果

専用ローカル実行`timeout-<RUN_ID>`は4項目成功。実Auth JWT→Express→PostgREST→RPCを使用し、ロック待ち503、コミット前切断と並行再送、コミット後応答喪失503と再送200、異本文409、削除後再送の本文NULLを確認した。再送を含めて3メッセージ/3作成イベントとなり、その後7件の新規送信が成功、11件目は429。退出後のテストroomはアーカイブ済み、メンバー0、メッセージ10、イベント11を保持した。

失敗記録も区別する:

- 初回はpgの解決先誤りでDB接続前に停止。検証ディレクトリのpgを使用するようハーネスを修正した。
- `timeout-<RUN_ID>`は専用ハーネスのrateSecret未設定でroom作成が失敗。テストユーザーだけ保持。アプリ.envは読まないため、ハーネス内で一時secretを指定した。
- `timeout-<RUN_ID>`は最初の3項目成功後、送信枠確認中にクライアント側25秒のTimeoutErrorで停止。テストroomにはメッセージ5、削除1、未退出メンバーを保持。原因は未確定であり、成功扱いにしない。HTTP開始/ヘッダー/本文時刻を記録するよう計測を追加した後の上記実行は4項目すべて成功した。元の停止に同等の詳細時刻記録はないため、原因解消を断定しない。

追加検証では、計測付きハーネスでこの25秒停止が再現するかを確認する。既存の失敗データを勝手に削除・退出させない。共有/チーム環境、他の検証DB、DB定義、RLS、マイグレーションには変更を加えていない。
