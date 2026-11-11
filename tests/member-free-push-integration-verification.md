# 通常起動・Push通知ワーカー検証結果

実施日: 2026-11-11（日本時間）。実機配信・外部Push・本番デプロイなし。

## 結論

通常の`server/index.ts`、実Auth、実PostgREST、実DBのキューとleaseを使い、Expoへの送信HTTPだけをモック化した統合テストが成功した。
専用環境・モック送信を維持してタイマー機能との統合テストへ進める。
外部受付とDB完了記録の間のクラッシュでは重複送信が起こり得るため、実配信のexactly-onceは保証されない。

## 実行環境と安全確認

- DB: `127.0.0.1:55439/imahima_member_free_test`
- 起動前にDB名とクラスタ識別子`7706764719554813981`を前回の秘密設定の記録と照合。一致しなければログイン・fixture変更・API起動を行わない。
- Auth/RESTの実コンテナ設定も`host.docker.internal:55439/imahima_member_free_test`だけを指すことを確認。
- 前回の専用AuthユーザーA/B・room・鍵を再利用。既存開発Authのユーザー・DBを使用／変更していない。
- 開始時のキューは、依頼文のpendingではなく前回の検証でcancelledとなった2件。既存記録をresetせず、専用APIからOFF→ONで新しいイベントを生成した。
- 書き込みは専用Authのログインセッション、専用A/Bプロフィール、新規イベント・通知、検証用の架空端末トークンとlease時刻注入に限定。
- 架空端末トークンは実機に対応しない値。検証中のみ登録し、当該トークンだけを終了時に除去。終了時トークン数0をDBで確認。
- Dockerリソースの作成・変更・再起動・削除なし。前回の専用サービスは稼働を維持。
- 既存開発DB・共有DB・本番DBへの接続なし。

## 起動方法

```powershell
node --test tests/test-member-free-push-integration.mjs
```

テストが通常APIを以下の形式で起動する（秘密値は設定ファイルからメモリ内で渡す）。

```text
node --require ./tests/member-free-push-mock.cjs --import tsx server/index.ts
SUPABASE_URL=http://127.0.0.1:55440
HOST=127.0.0.1
PORT=55442（競合ワーカーは55443）
FREE_END_NOTIFICATIONS_ENABLED=true
MEMBER_FREE_NOTIFICATIONS_ENABLED=true
FREE_END_NOTIFICATIONS_INTERVAL_MS=1000
MEMBER_FREE_NOTIFICATIONS_INTERVAL_MS=1000
MEMBER_FREE_NOTIFICATIONS_MAX_ATTEMPTS=3
```

APIでfixtureを準備する段階は両ワーカーfalse。独立した通常APIプロセスを起動し、不正Bearer拒否、実ログイン、B→AのON、レスポンスとDB時刻の一致、再ONの重複排除を各シナリオで検証する。
送信SDKや通知サービス、claim/validate/complete RPC、認証処理は本物。Push HTTPレスポンスだけをインメモリで返す。
送信モックは実機宛てを受け付けず、この実行の架空トークンだけを許可。その他の外部HTTPはガードが拒否する。
検証用APIプロセスは終了時に停止。前回から稼働する専用APIには設定変更なし。

## 期待と実測

| シナリオ | 期待 | 実測 |
|---|---|---|
| 成功 | pending→processing→sent、試行1、accepted_count=1 | 一致 |
| 独立2ワーカー | 有効lease中は2番目が取得・送信しない | 2番目のモック呼び出し0、試行1、成功後も再送なし |
| 一時失敗 | failed、初回5秒バックオフ後に再取得 | failed(1)→sent(2)、accepted_count=1 |
| 連続一時失敗 | 最大3回でexhausted | exhausted、試行3、モック3回。その後も増加なし |
| 恒久失敗 | cancelled、再試行なし | InvalidCredentialsをモックしcancelled、試行1、モック1回 |
| 受付前の強制終了 | processing保持、lease中は再取得不可、期限後に回復 | 期限後sent、試行2、新lease。古いleaseの完了要求false |
| 受付直後の強制終了 | at-least-onceのため再送可能 | 回復後sent、試行2、モック上の受付2回を再現 |

lease回復では通常プロセスを強制終了し、DBのprocessingを残した。別プロセスが有効leaseを取得しないことを確認後、当該通知のlease_expires_atだけを過去へ移して期限切れを注入した。既定120秒を実時間で待つ試験ではない。
受付後クラッシュは、モック側の受付を記録した直後にレスポンスを保留してプロセスを終了することで、DB未完了の窓を模擬した。

## 実行したテスト

- 実DB統合テスト: 1件（6シナリオ）成功、skipなし。成功実行約57.4秒。
- SQL回帰: member_free_notifications / profile_write_permissions / extend_from_notification / free_end_notification_claims の4本成功。
- API・Pushサービス・両ワーカー・通知延長のモック回帰: 102件成功。
- `tsc --noEmit`: 成功。
- `git diff --check`: 成功。

## 発見事項と修正

製品コードに新たな不具合は確認されず、製品コード・DBマイグレーションの追加修正は行っていない。
初回モック実行で、SDKの小文字`post`に対し検証コードが大文字`POST`だけを許可していたため失敗した。モックを大文字小文字非依存へ修正。
失敗時の記録は`member-free-push-integration-initial-attempt.json`へ保持し、その実行の専用AをAPIでOFFにして正規claimのEligibility取消を実行後、再検証した。

今回のファイル:

- `tests/member-free-entrypoint-guard.cjs`: 競合試験用localhostポート55443も許可。
- `tests/member-free-push-mock.cjs`: SDK送信HTTPの成功・一時失敗・恒久失敗・保留・受付後停止のモック。
- `tests/test-member-free-push-integration.mjs`: 通常起動・実DB・独立ワーカー・再試行・強制終了の統合試験。
- `tests/member-free-push-integration-results.json`: 成功時のAPIレスポンス、キュー状態、各シナリオ結果。
- 本レポートと初回失敗の記録。

## 残る課題とタイマー統合への判断

- 有効lease中・完了後の重複処理は防止できたが、外部受付後のクラッシュや受付結果不明時には再送による重複があり得る。未実装なのは外部サービスを含むexactly-onceであり、今回のテストで保証されたものではない。
- 期限切れでも未再確保なら旧所有者の完了を受け付けるのが既存仕様。再確保後の古いlease完了は拒否される。
- Expoの受付と実機到達は別。実機配信・レシート確認は未検証。送信サービスのレシート監視は未実装。
- 部分受付時は受信者全体をsentとし、失敗端末だけの再試行は未実装（既存仕様）。
- タイマー統合は専用DB＋モック送信で着手可能。期限前後・自動OFF・延長・再ONによる旧通知失効・再試行中の期限切れを次の確認対象とする。
- 実機到達・実配信での重複抑制が解決済みという判断はしない。
