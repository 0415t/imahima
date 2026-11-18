> Anonymized historical record; original retained locally. Historical failures remain unchanged. Channel connection refusal is not an MVP criterion. Fresh event delivery to the repaired historical room remains UNTESTED. See [current guidance](../../../docs/group-chat-verification.md).

# グループチャット実JWT・PostgREST・Realtime統合検証

最終検証: [FINAL-VALIDATION-RESULTS.public.md](./FINAL-VALIDATION-RESULTS.public.md)（2026-11-16）。作成者実削除後のアーカイブ不具合を実測し、完成判定は保留。過去の結果は以下に保持する。

追加検証: [第3段階のタイムアウト・異常系・競合結果](./PHASE3-RESULTS.public.md)（2026-11-16）。以下の初回24件の結果は履歴として保持し、追加試験の成功と合算して書き換えない。

実施日: 2026-11-13。対象は `imahima-chat-local` のAPI 127.0.0.1:56321、DB 127.0.0.1:56322、確認済みクラスタ識別子のみ。

**本検証24件中23件成功・1件失敗。初回作成イベントのフィルター付き購読で欠落を観測し、成功扱いにはしない。** 初回購読時の同期手順について追加検証が必要であり、無条件のフロント接続・公開可能という結論にはしない。

実行ID: `<RUN_ID>`。

## 検証経路

`integration-api.ts`で既存createApp、groupService、chatService、serverSupabaseを実際に使用した。ローカルAuthのパスワードログインから取得したJWTをExpressのauth.getUserへ渡し、service_roleでPostgREST→既存RPCに到達する。認証・RPCのモックは使用していない。APIは127.0.0.1:56331に限定し、fetchも専用Supabase以外の接続を拒否。dotenvや通知ワーカーはimportしない。

`integration-test.mjs`でA/B/CをローカルAuthに作成。登録トリガーによるprofiles自動作成も成功。A/B所属roomとAだけの別roomをグループAPIで作成した。Cは最後まで非所属。実ユーザーのパスワード・access/refresh JWTはメモリだけに保持し、ログへ保存しない。CLI接続情報も診断ログと秘密設定ファイルを分離した。

## 成功した確認

| 項目 | 結果 |
|---|---|
| ローカルAuthユーザー・実JWT・プロフィール自動作成 | A/B/Cすべて成功 |
| JWTなし・不正JWT | 全4APIで401 |
| 送信者 | JWT由来IDとDTO/DBが一致、送信者偽装フィールドは400 |
| 新規送信・再送・異本文 | 201 / 200（同一ID）/ 409 |
| 他人削除・本人論理削除 | 403 / 200、削除後再送でも本文NULL |
| Unicodeコードポイント | 絵文字499/500成功、501・空白のみ400 |
| 非所属・退出後API | 送信/履歴/削除/差分すべて404 |
| 履歴・イベントページング | 削除状態を取得、固定カーソルの差分を取得 |
| 一般JWTの直接アクセス | 本文表・グループ/チャットRPC6本すべて403 |
| HTTPとRPC JSONの区別 | 例: PostgREST HTTP200 + JSON409/403/429をExpressが409/403/429へ変換。非所属読取は直接RPC200/JSON404とExpress404を別記録 |
| 全room合計送信制限 | 削除済み1件を含む10件成功、11件目429、Retry-Afterあり。同ID再送は200 |
| JWT更新（所属中） | 受信継続 |
| 退出後JWT更新・新接続 | 配信を受けず、API権限も復活しない |
| 再参加 | 参加前の履歴・新着受信が復旧 |
| 通信断中の作成・削除 | 2ページの差分からtombstoneを復元、再接続後の受信も成功 |
| 本文の配信防止 | 観測46受信レコードすべてイベントの5メタデータ列のみ |
| C/他room | Cは全期間0受信。Bも別roomをフィルター/フィルターなしのいずれでも0受信 |

## 退出後配信停止

Bの既存フィルター付き・フィルターなし購読を維持し、退出APIの204とDB上の非所属を確認してからAが送信した。2回の退出それぞれ3件、計6件の別イベントで確認した。

各イベントは退出後のDB確認時刻より後に作成され、Aの受信を正の対照とした。Bの接続と各channelのjoined状態を確認したうえで、A受信後さらに2秒の観測窓でB/Cの受信なしを確認。JWT更新/再接続後にも別イベントで非配信を確認した。

これは有限の観測結果であり、あらゆる遅延下の非配信を数学的に保証するものではない。送出済みパケットの到着取り消しも検証対象外。通常クライアントの退出時購読解除・表示停止は引き続き必要。

## 失敗した1件: 初回作成イベントの受信欠落

全7購読でSUBSCRIBEDを確認し、最初のA送信を実施したところ、以下を観測した。

| 観測 | UTC時刻/結果 |
|---|---|
| Aのroomフィルター購読成立 | 09:16:36.892 |
| Bのroomフィルター購読成立 | 09:16:36.921 |
| Bのフィルターなし購読成立 | 09:16:36.928 |
| DB上の作成イベント | 09:16:37.050799、event_seq=1 |
| Bのフィルターなし受信 | 09:16:37.183 |
| A/Bのroomフィルター付き受信 | 12秒以内に受信せず。最終記録にもなし |
| 同メッセージの削除イベント | event_seq=2、A/B両方が受信 |

対象message_idは `<VERIFICATION_ID>`。DB保存とBのフィルターなし受信はあるため、メッセージ送信全体の失敗ではない。後続のフィルター付き配信は成功している。

初回購読登録・キャッシュ・SDK/サーバー間のタイミングを疑うが、**根本原因は未確定**。購読後の初回送信1回で観測したもので、再現率も未確定。調査中のrealtime.subscription.created_atはtimestamp without time zoneであり、Nodeのローカル時刻解釈を混同して原因を断定しない。

対応案（未実装）:

1. 同じSDK/Realtime版で、初回・再接続・複数channel・フィルター有無を分けて再現させる。
2. SUBSCRIBEDを履歴の完全性の証明にせず、設計済みの「購読→履歴と基準番号→差分同期→バッファ反映」をクライアントに実装し、初期化中の欠落も回収できるか追加検証する。
3. 通知が一切来ない場合もDB差分へ収束する低頻度同期の間隔を決める。
4. 必要ならSDK/Realtime側の調査・更新を別承認で行う。RLSや所属制御を緩める対処はしない。

## 検証ツールで発生した問題

- 初回起動 `<RUN_ID>`: WindowsのNode --importに絶対パスを渡して起動失敗。ユーザー/room作成前。file URLへ直すハーネス修正だけを行い、その失敗記録も保持した。
- 終了監査: publication全数を1と仮定した監査器が停止。Realtime自身が`realtime.messages`を別の`supabase_realtime_messages_publication`へ追加していたため、publicスキーマのアプリ表と分けて監査するよう修正。`public.messages`は公開されていない。アプリ用DDL/権限を変更したものではない。

上記は本検証24件とは別のハーネス/監査器の問題。本検証の失敗1件を修正済みとして扱わない。

## 保持データと環境への影響

| 対象 | 残った件数 |
|---|---:|
| Authユーザー/profiles | 各3 |
| rooms | 2 |
| room_members | 3 |
| messages | 24（論理削除2） |
| room_message_events | 26 |
| グループ操作レート制限キー | 4 |

全メッセージ/イベントはこの実行のユーザー/roomへ帰属する。テストデータ、Authセッション、Supabase5コンテナ、ボリュームを保持。検証で起動したExpressプロセスとWebSocket購読だけ終了した。既存27コンテナのID/設定/マウント/ネットワーク、9ボリュームのメタデータ、既存.envとCLIリンクのハッシュは一致。既存Auth定義・RPC権限・RLSと既存マイグレーションのSHA-256も一致。

チーム用Supabase/暇通知検証環境のDBへは接続・変更せず、実Push・コミット・pushも未実施。既存サービスによる自然なデータ更新がないことまで保証する比較ではない。

## 成果物と再実行

- `integration-api.ts`: 専用API起動、実認証/実RPC、外向き接続拒否、IPCによるHTTP/RPCステータス記録。
- `integration-test.mjs`: 実JWT・API・Realtimeの統合検証。
- `integration-audit.mjs`: データ作成後も実行可能な読み取り専用の保持監査。
- `.runtime/integration-<RUN_ID>/results.json`: 全24件、HTTP/RPCステータス、購読状態、退出時刻、受信レコード。
- 同ディレクトリの`event-receipt-matrix.json`: DBイベントID・作成時刻・送信者と全受信者の対応。
- `preservation-audit.json`: 接続先・環境保持・残存件数。
- `harness-notes.json`: ツール起動/監査器の失敗と対処。

現在はユーザーとデータが残っているため、空環境を要求する `npm run test:integration`、`npm run verify:schema` は再実行しない。自動resetや削除は行わない。現在の保持監査は専用ディレクトリで `npm run audit:integration`。追加検証には、保持ユーザーの新しい認証セッションの取得方法と、既存データを保つテスト段階を先に準備する。
