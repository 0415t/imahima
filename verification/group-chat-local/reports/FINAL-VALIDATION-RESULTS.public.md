> Anonymized historical record; original retained locally. Historical failures remain unchanged. Channel connection refusal is not an MVP criterion. Fresh event delivery to the repaired historical room remains UNTESTED. See [current guidance](../../../docs/group-chat-verification.md).

# グループチャットMVP 最終検証（2026-11-16 JST）

既存再現roomの後続修復は[ROOM-REPAIR-RESULTS.public.md](./ROOM-REPAIR-RESULTS.public.md)参照。修復前の失敗記録は以下に保持する。

後続修正: [管理フラグ・所属トリガーの実装と専用ローカル検証](../../../docs/group-archive-implementation.public.md)。以下の不具合発見・失敗記録は保持する。新規アーカイブ経路は修正済みだが、既に再開された既存roomの手動修復は別承認待ち。

**完成判定: 未完了。作成者実削除後の最後の退出・アーカイブに仕様違反を実測した。** 本体コード、DB定義、RPC、RLS、既存マイグレーションは修正していない。フロントエンド、Push、コミット、pushにも着手していない。

## 1. 接続先・安全性

専用`imahima-chat-local`のみ。API `http://127.0.0.1:56321`、DB `127.0.0.1:56322/postgres`。既存の`connectVerified()`でCLI未リンク、Docker project/workdir/network/loopback binding、DBクラスタ識別子とpostgresロールを検査した。

今回の削除対象は成功試行で新規作成したA/D/Eの3ユーザーだけ。削除直前に作成ID一覧、以前から存在するユーザー一覧との非重複、Authのメールとusernameを照合した。生存B/C、初回ハーネス失敗の5ユーザー、以前のユーザー・roomは削除していない。

成功試行の末尾で、作業前から存在するauth.usersのID、profiles、rooms、room_members、messages、eventsの件数と集約digestが一致。対象バックエンド/既存マイグレーションのSHA-256も開始前後で一致した。追加のアーカイブ再現はこの成功試行で作成したroom・B/Cだけを使用した。

## 2. 実Auth削除と競合

成功試行: `final-<RUN_ID>`。16成功、0失敗、1未実施。

| ケース | 実測結果 |
| --- | --- |
| 削除前 | 実JWTで送信/履歴/本人削除。再送200、異本文409、他人削除403。準備完了待機付きRealtimeで受信 |
| Aの実削除 | Auth Admin APIのhard delete成功。今回作成したAだけが対象 |
| 削除後JWT | チャット4APIすべて401 |
| 参照整合性 | Aのauth.users/profiles/room_membersは0件。messagesは保持しsender_id=NULL。未削除本文を保持、tombstone本文NULL。Bの送信者と履歴を維持 |
| 作成者FK | rooms.mvp_created_byはNULL。物理room削除なし。この状態が後述のアーカイブ不具合につながる |
| イベント | Auth削除で作成/削除イベント件数は変わらず、参照切れなし。配信は5メタデータ列のみ |
| 削除済み接続 | 接続中のAと非所属Cは、削除後にBが送信した3イベントを受信しない。各イベントはB受信を正の対照とし、追加2秒観測。channel状態とエラーを照合。有限回の検証であり絶対保証ではない |
| 削除→送信 | B作成roomでDの送信RPCをroomロックで待機させた。DのAuth削除が先にコミット後、解放すると送信404、再送401、メッセージ0件 |
| 送信→削除 | Eの実送信RPCのトランザクションを保持し、Auth削除のDB待機を確認。送信COMMIT後に削除成功。メッセージ1件をsender=NULLで保持、削除後再送401 |

実Authユーザーを削除せずエラー型を模擬した第3段階の未実施項目は、今回の上記試験で補った。今回の競合順序はpg_blocking_pidsとトランザクション境界で確認したものであり、単に同時に呼び出した結果だけではない。

## 3. 最終回帰と件数

| 層・実行 | 成功 | 失敗 | 未実施 | 範囲 |
| --- | ---: | ---: | ---: | --- |
| 最終HTTP/SDKモック回帰 | 77 | 0 | 0 | 認証分類、タイムアウト、チャット、グループ、暇状態toggle API |
| 専用ローカル成功試行 | 16 | 0 | 1 | 上記削除、実JWT、PostgREST、RPC/RLS、Realtime、差分、グループ、並行処理 |
| アーカイブ追加試験 | 0 | 1 | 0 | 作成者削除後、全員退出しても旧コードで再参加できた |
| 上記最終セット合計 | 93 | 1 | 1 | 全項目を実DB試験とは呼ばない |
| 初回ハーネス試行（別記録） | 3 | 1 | 後続未到達 | メールの大文字/小文字ガードで削除前に停止。結果を削除しない |

初回実行`final-<RUN_ID>`は、Authがメールを小文字に正規化する一方でハーネスが入力の大文字ラベルと比較したため停止。Auth削除は0件で5ユーザーすべての残存を読み取り確認した。削除ガードの正規化比較だけを修正し、次の試行は別の新規ユーザーで実施した。

専用ローカルで追加確認した回帰:

- 11並行送信: 10成功/1制限、room_seqの一意性、二重削除は1イベント。
- 一般JWTはmessages直接SELECT・管理RPC4本の実行を拒否。eventsは現所属者のみ読取。
- 切断中の作成/削除を固定上限・2ページのREST差分で回収し本文NULLを取得。JWT refresh後に再購読・新着受信。
- グループ作成/一覧/招待取得/参加/メンバー/退出、作成者以外の招待取得403。
- 暇状態ON無期限/未来期限/期限切れ/OFFの4状態を、新規Bのprofilesだけで確認。グループ読取はプロフィールを変更しない。
- SQLカタログで一般ロールの権限、publicationにeventsのみがあること、イベント参照切れ0件を確認。

実タイマー更新・延長・期限切れ関数はこの専用環境に存在せず、実結合回帰1件は未実施。定義の追加はしない。モックのtoggle API成功と、実タイマー処理の成功を同一視しない。

別の隔離PostgreSQLは今回接続・変更していない。過去のSQL3組・並行処理成功は`docs/group-chat-db-implementation.public.md`の履歴として参照する。既存SQL試験はfixture、一時関数/トリガー作成を含み、この環境へ無条件流用するとAuth既存オブジェクト保護/DB定義変更禁止条件に反するため再実行していない。現環境では既存RPC・実RLS・カタログ照会で回帰した。

対象の型チェック・Lint・差分チェックは成功。既存のフロントエンドを含む全体型チェックの成功とは主張しない。

## 4. 完成を妨げる不具合

追加実行`<RUN_ID>`で実測。

1. 今回新規作成したA作成roomにBが所属している。
2. AをAuth APIで実削除し、mvp_created_byがNULLとなる。
3. 最後のメンバーBがExpress退出APIで204を受ける。
4. メンバー0件でもmvp_archived_atはNULLのまま。
5. 生存テストユーザーCが元のコードで参加すると201となる。
6. Cの履歴取得が200となり、8件の過去メッセージを取得できる。

詳細設計の「全員退出したroomは再参加不可」に違反する。RLSを越えて他roomが読めた事象ではないが、roomライフサイクル上は受入条件違反であり、完成阻害（高）と判定する。

根拠:

- `supabase/migrations/20261111000000_group_management_mvp.sql:9`: mvp_created_byのFKはON DELETE SET NULL。
- 同`:132`: 最後の退出でアーカイブする条件がmvp_created_by IS NOT NULL。
- 同`:99`: joinはmvp_archived_at IS NULLのroomを受け付ける。
- `docs/group-chat-mvp-detailed-design.public.md:16`: 全員退出roomは再参加不可。

修正案（未実装、承認が必要）:

- 作成者参照と、MVP管理roomかどうかを独立させる。作成者アカウント削除で失われない管理マーカーを検討する。
- 既存legacy room保護を維持するため、既存データのNULLを一律にMVP/legacyと決めつけない。安全な識別・バックフィル方法を先に決定する。
- 独立マーカーを退出RPCに利用し、全員退出後のアーカイブ/再参加拒否を確認する。
- Auth削除のCASCADE自体が最後の所属を消す場合にも、同じroomライフサイクルを維持する必要がある。今回実測したのは「作成者削除後に最後の生存メンバーが退出」の順序。全員がアカウント削除で消える場合は関連する未検証リスクとして、別途試験が必要。
- 修正のロック順序と送信/退出/アカウント削除競合を再レビューする。今回は本体コードやDB定義を修正しない。

追加再現後は、問題を隠すためのroom削除、手動アーカイブ、Cの強制退出などの復旧を行っていない。

## 5. 過去の未解決事項

### 25秒タイムアウト

元の失敗は原因未確定として維持する。第3段階でAuth約5秒、PostgREST約8秒、HTTP全体約20.02秒の期限を実測した。元の失敗の相関ログがないため、原因解消・修正済みとは記載しない。

再現せず、独立した20秒期限が確認できていることから、この単発事象だけを現時点の機能完成阻害にはしない。ただし運用上の未解決事項として残す。今回の完成判定を止める主因は実測済みアーカイブ不具合である。

最小計測案（本体には未実装）: サーバー生成の要求ID、受信/認証/所属/RPC開始終了/HTTP終了の単調時計経過時間、期限発火/クライアント切断、上流status・SDK error種別・SQLSTATE。JWT/本文/招待コード/秘密キーを記録しない。クライアント開始・サーバー受信・終了を対応付け、未到達とDB待機を区別する。

### Realtime初期欠落

通常のSUBSCRIBEDはchannel join完了であり、Postgres Changesの準備完了とは限らない。既存の追加調査`<RUN_ID>`の有効9試行では、通常の即時3回・1.5秒待機3回すべてで欠落、wait:trueは3回受信。欠落6試行もREST差分で回収成功。

暖機済み既存roomは15試行受信、初期同期競合3試行も復元成功。新規roomフィルターは9試行受信。探索段階の購読エラーや未完了試行は正常な無受信と混ぜない。証跡は既存`.runtime/realtime-investigation-analysis.json`と元JSONに保持。

今回の最終試験ではwait:trueで準備完了を待ち、実REST差分同期・JWT更新・再接続を確認した。初回24件の1失敗を成功に書き換えない。frontendは対応SDK、準備待機、必須REST同期、退出/削除後の遅着データ破棄を実装する必要がある。

## 6. 成果物・引き継ぎ

- `final-validation.mjs`: 実Auth削除、競合、回帰、既存データ/ソース保持照合。
- `final-creator-exit.mjs`: 完成阻害不具合の実API再現。
- `.runtime/final-<RUN_ID>.json`: 初回ハーネス失敗（保持）。
- `.runtime/final-<RUN_ID>.json`: 成功試行16項目/未実施1件、相関証跡。
- `.runtime/<RUN_ID>.json`: アーカイブ不具合の期待/実測値。

秘密情報は結果JSON/報告へ出力していない。今回の新規テスト履歴を保持したまま停止する。次は上記ライフサイクル不具合の修正設計・承認・修正・回帰が必要。フロントエンド着手や共有DB適用の承認とは別である。
