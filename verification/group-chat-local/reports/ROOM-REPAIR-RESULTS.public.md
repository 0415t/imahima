> Anonymized historical record; original retained locally. Historical failures remain unchanged. Channel connection refusal is not an MVP criterion. Fresh event delivery to the repaired historical room remains UNTESTED. See [current guidance](../../../docs/group-chat-verification.md).

# 既存不具合再現roomの修復（2026-11-16 JST）

対象: `<VERIFICATION_ID>`。**修復は完了、API/行データ認可を確認。ただし「新規Realtime接続自体の拒否」は確認できず、無条件の完成判定は保留。**

## 1. 修復前

- 専用`imahima-chat-local`、API 127.0.0.1:56321、DB 127.0.0.1:56322/postgres。Dockerラベル/ネットワーク/loopbackポート、クラスタ識別子<LOCAL_DB_ID>、postgresロールを照合。
- room名`final-<RUN_ID>`、mvp_managed=true、アーカイブ日時NULL。
- 所属1人: `<VERIFICATION_ID>`。Authメタデータ・profilesの名前が`final-<RUN_ID>-C`、Auth削除なし。
- 招待コードあり、32文字、room間で一意。実値はログ/結果に保存しない。
- メッセージ8件（論理削除2）、イベント10件（created 8/deleted 2）。元のfinal実行の保持件数、成功HTTP送信/削除の記録、不具合再現記録の履歴8件と一致。

DBは最初にREAD ONLYで照合。条件不一致時は更新しない実装。

## 2. 実施した変更

`repair-archived-fixture.mjs`を今回の明示承認に基づき1回実行した。

1. BEGIN、lock_timeout=5秒、statement_timeout=60秒。
2. 対象roomをFOR UPDATE、既存所属をFOR SHAREでロック。
3. ID・名前・管理フラグ・NULL日時・所属・履歴/イベント件数を再照合。
4. 対象ID/名前/管理フラグ/NULL日時を条件に、mvp_archived_atだけを更新。
5. 更新1件と他データの不変を確認してCOMMIT。

確定時刻: **2026-11-16 14:14:33.926 JST**（DB値`2026-11-16T05:14:33.926Z`）。

所属、招待コード、本文、イベント、他roomを修復処理では変更しない。検証用ログインで既存検証ユーザーCの新しいAuthセッションを取得した。招待試験に伴う通常のレートカウンター更新は発生するが、適用前に期限切れ行0件を確認し、既存カウンター行が削除されていないことも確認した。

## 3. API・Realtime

実Auth JWT→Express→PostgREST→RPCを使用。

| 確認 | 結果 |
| --- | --- |
| 旧招待コード参加 | 400 |
| 元から所属するCの履歴 | 404 |
| Cの差分同期 | 404 |
| Cの新規送信 | 404。保存なし |
| Cのメッセージ削除 | 404。本文変更なし |
| 他の有効roomの履歴/差分/メンバー | すべて200 |
| グループ一覧 | 対象を除外、有効roomを表示 |
| Cの直接PostgRESTイベントSELECT | HTTP200、配列は空。元のイベント10件はDBに保持 |
| 実authenticatedロールでの所属判定関数 | target=false、control=true。対象の所属は1件のまま |
| 新規Realtime購読 | 対象/有効roomともSUBSCRIBED。接続自体は拒否されなかった |

Realtimeの重要な区別: Postgres Changesのchannel参加/DB binding準備完了と、各行のRLS認可は別である。今回、対象roomのデータ認可拒否は確認できたが、「新規channelがSUBSCRIBEDにならない」という条件は満たしていない。権限を変更してこの差を隠していない。

対象へのメッセージ/イベント追加は禁止されているため、このroomへの新規INSERTを用いたWebSocket配送試験は未実施。無受信0.5秒だけを配信停止の証明とは扱わない。修正トリガー工程の別の新規fixtureでは、管理者メタデータprobeと正の対照イベントによる非配信検証が記録されているが、今回の対象で再実施したとは数えない。

## 4. データ保持・変更範囲

修復前後およびAPI検証後に以下が一致した:

- 全profiles、全room_members、全messages、全room_message_eventsの件数/集約digest。
- 対象以外の全roomsの件数/集約digest。
- 対象roomのアーカイブ日時以外の全カラム、招待コード実値。
- 対象の所属1人、メッセージ8件（削除2）、イベント10件。
- 関連バックエンドコード・既存migrationのSHA-256。

本体コード、DB定義、RPC/RLS/GRANT、migration、フロントエンドは変更なし。チーム用/他の検証環境に接続していない。新規room/ユーザーやprobeは作成せず、削除・初期化・Push・コミット・pushなし。

## 5. 最終確認の件数

| 種別 | 成功 | 失敗 | 未実施 |
| --- | ---: | ---: | ---: |
| 修復・実API/RLS・接続観測・保持照合 | 11 | 0 | 2 |
| 認証/タイムアウト/チャット/グループ/暇状態HTTPモック | 77 | 0 | 0 |
| 新規Realtime接続拒否という受入条件 | 0 | 1 | 0 |
| 合計 | 88 | 1 | 2 |

最後の1件は、実行例外やデータ漏えいではなく、要求の「新規購読拒否」を接続拒否として厳密に評価した結果。元の実行結果11成功/0失敗/2未実施は保持し、独立したacceptance JSONに期待値/実測値を追加した。

未実施2件は、今回対象への新規INSERT配送試験（保持条件により実施不可）と、実タイマー更新・延長の結合試験（専用環境に関数なし）。対象バックエンドの型チェック・新規検証ハーネスのLint・差分チェックは成功。

## 6. 過去の未解決事項

- 元の25秒タイムアウト: 原因未確定を維持。20秒HTTP期限の別実測成功を原因解消とは記載しない。
- 初回Realtime購読失敗: 原因未確定を維持。後続成功で元の失敗記録を削除しない。
- 実タイマー更新/延長: 未実施を維持。モックのtoggle成功と区別する。

## 7. 完成判定・成果物

既存アーカイブ不具合の修正と、このroomの履歴保全を伴う閉鎖は完了した。ローカルでAPIとRLSによるデータアクセス拒否を確認した。

ただし今回の「新規購読拒否」を接続自体の拒否として必須とする場合は、現行Postgres Changes方式では達成していない。この差を無条件合格に読み替えず、接続拒否まで必要かの仕様確認/別設計が残る。バックエンド全体を無条件に完成とは判定しない。共有/本番への適用は未承認・未実施。

- `repair-archived-fixture.mjs`: 1回限りの修復・検証。再実行するとアーカイブ日時NULL条件で停止する。
- `.runtime/<RUN_ID>.json`: 修復前後・実HTTP・Realtime状態・保持照合。
- `.runtime/<RUN_ID>-acceptance.json`: 元結果ハッシュと接続拒否条件の評価。

結果を確認して停止した。手動の追加変更・アーカイブ解除・権限変更は行わない。
