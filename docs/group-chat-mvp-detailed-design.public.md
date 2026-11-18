> Anonymized historical copy. Original retained locally. Current guidance: [backend](group-chat-backend.md) and [verification](group-chat-verification.md). Historical failures are preserved; old commands are not current deployment instructions.

# imahima グループチャットMVP 詳細設計案

作成日: 2026-11-13。対象ブランチ: feat/group-chat-backend。
状態: 設計レビュー用。ユーザー確定仕様と、追加で承認・実環境検証が必要な設計判断を区別する。
更新: 下記5項目はユーザー方針に基づき確定。技術的な実測成功を意味するものではない。
この文書だけを追加する。アプリコード、SQLマイグレーション、実DB、コミット、pushは対象外。
今回DBに接続していない。過去の監査結果は背景情報であり、現在の実DBを再検証したとは扱わない。

## 1. 確定仕様の整理

| 今回確定した詳細 | 仕様 |
| --- | --- |
| 500文字の数え方 | Unicodeコードポイント |
| 削除済みIDの再送 | 200で削除状態を返す。本文を復元しない |
| イベント保存期間 | MVPでは無期限 |
| 全員退出したroom | 再参加不可。既存アーカイブ仕様を維持 |
| 退出時の配信境界 | 退出確定後の新規配信を禁止。送出済みパケットの到着取消しは保証しない |

- 既存roomsごとに1チャット。現在の所属者だけが送信・履歴取得・新着受信可能。
- 新規参加・再参加では全履歴を閲覧可能。退出後は禁止。保存済みクライアントデータを
  遠隔消去する保証とは区別する。
- 再参加は既存グループ仕様上の有効roomが対象。全員退出でアーカイブされたMVP roomは
  既存joinで再参加できない。アーカイブ解除機能は今回追加しない。
- メッセージは無期限保存。本文最大500文字、空白のみ禁止。
- 現在の所属者かつ送信者本人だけが削除可能。論理削除しbody=NULL、deleted_atを保存。
- 削除表示は「メッセージが削除されました」。編集・復元・物理削除APIは提供しない。
- ユーザー単位・全room合計で直近60秒に成功送信10件まで。client_message_idで重複防止。
- 送信・履歴・削除・差分同期はExpress、RealtimeはSupabase。
- 既読、画像、添付、編集、Push、1対1は対象外。タイマー・既存通知の仕様を変更しない。

文字数はUnicodeコードポイント数で確定。追加提案として、空白判定はUnicode White_Space集合を
APIとDBで一致させる。UTF-16 lengthやPOSIX空白だけで実装しない。結合絵文字は複数文字に
数える。本文の前後空白は保存し文字数にも含める。CRLFをLFへ正規化してから検証・比較する。
NUL、不正Unicode、非文字列、未知の書込フィールドは400。正規化ルールは実装前に承認する。

## 2. 既存実装との整合性

| 根拠 | 確認事実 | 再利用・注意 |
| --- | --- | --- |
| server/app.ts:9-13 | createApp依存注入、/groupsルーター | チャットの依存を分離して追加、既存テストを維持 |
| server/index.ts:6-19 | auth.getUserで本人を決定、service接続 | p_actorは検証済みAuth IDのみ |
| server/groups.ts:18-39 | Bearer、no-store、API側所属確認 | 共通方針を再利用。JWT不備401、非所属404 |
| server/groups.ts:41-48 | 作成/参加前にレートRPCを別呼出し | 成功送信だけの課金にはそのまま使わない |
| server/services/groups.ts:8-23 | 所属SELECT、管理RPC | HTTP確認だけに依存せず新DB RPCでも再検証 |
| server/services/supabase.ts:10-15 | service_role、非永続セッション | 端末へキーを渡さない。RLS迂回を前提に認可 |
| supabase/migrations/20261111000000_group_management_mvp.sql:31-46 | 固定60秒窓で試行数を加算 | スライディング窓・成功時のみ・再送非加算とは異なる |
| 同SQL:52-55,157-160 | room一般権限をREVOKE、RPC serviceのみ | room_membersのGRANTを広げない |
| 同SQL:94-133 | 参加/退出がroom行FOR UPDATE | 新送信/削除も同じroom行をロック |
| 同SQL:139-145 | profilesから共有暇状態取得 | チャットはis_free/free_untilを読み書きしない |
| lib/supabase.ts:10-17 | autoRefreshToken=false、persistSession=true | 長時間利用のJWT更新手順が必要 |
| app/_layout.tsx:33-42 | Auth変更監視・session取得 | 自動更新・Realtime再認証の完成を意味しない |
| lib/push-notifications.ts:62-75 | 既存端末登録RPC | 新チャット通知を追加しない |
| tests/test-groups.ts:9、tests/test-group-db-concurrency.mjs:25 | Node HTTP/隔離DB競合テスト | 同じ方法でチャット契約・競合を検証 |
| .github/workflows/ci.yml:10-29 | Python向けCI | Node/DB/Realtimeテストは将来の実装範囲 |

基礎DDLは完全にリポジトリ管理されていない。supabase/tests/fixtures/group_mvp_schema.sql:6-21
は最小fixtureであり実DB全定義ではない。過去に確認されたprofiles.idとAuthの対応、
room_members.user_id→auth.users.idのFKは維持する。既存group_mvp_executeを置換しない。
public.usersは移行対象のテスト表で、チャットの参照元にしない。

## 3. DBテーブル・制約・インデックスの詳細案

### 3.1 messages

| カラム | 型/NULL/既定値 | 制約・役割 |
| --- | --- | --- |
| id | uuid NOT NULL、DB生成 | PK |
| room_id | uuid NOT NULL | FK rooms(id) ON DELETE RESTRICT |
| sender_id | uuid NULL可、新規時は必須 | FK profiles(id) ON DELETE SET NULL |
| room_seq | bigint NOT NULL | >0、UNIQUE(room_id,room_seq)、送信順序 |
| body | text NULL可 | 未削除なら1..500コードポイント、空白のみ不可 |
| client_message_id | uuid NOT NULL | UNIQUE(sender_id,client_message_id)、全roomで同一送信識別子 |
| created_at | timestamptz NOT NULL | RPC内でロック・認可後のDB clock_timestamp()、変更不可 |
| deleted_at | timestamptz NULL可 | 初回削除時のDB時刻、再削除で更新しない |
| last_event_seq | bigint NOT NULL | >0、最新の作成/削除イベント番号。追加提案カラム |

CHECKは「deleted_at IS NULL AND body IS NOT NULL AND 本文検証成功」または
「deleted_at IS NOT NULL AND body IS NULL」。NULLによるCHECKすり抜けを避ける。
sender_id=NULLは既存アカウント削除のFK動作だけで許容し、新規送信RPCはp_actorを必ず設定。
created_at、room_id、room_seq、client_message_id、未削除本文を通常更新する経路は作らない。

インデックス:
- PK(id)。UNIQUE(room_id,room_seq)を履歴・逆順max採番検索に使用。
- UNIQUE(sender_id,client_message_id)を再送判定に使用。別roomへの同じIDは409。
- (sender_id,created_at DESC)を全room成功送信制限とFK削除時の検索に使用。
- UNIQUE(room_id,id)をイベントの複合FK先として追加。

アカウント削除では本文/履歴を保持し送信者だけNULL。「退会済みユーザー」を表示する。
削除後は同じAuth IDで認証できず、元メッセージの本人削除APIも使えない。別途のアカウント
削除時本文消去は今回の確定仕様外。将来必要なら保持方針を再設計する。
表示名はprofilesの現在値。送信時名を複製せず、メールや端末情報を返さない。
sender_idのFK変化はチャットの本文編集ではなく、アカウント情報の変化として扱う。
プロフィール名変更/退会のリアルタイム通知はMVP外で、再取得時に反映する。

### 3.2 room_message_events（推奨）

| カラム | 型/NULL | 制約・役割 |
| --- | --- | --- |
| room_id | uuid NOT NULL | FK rooms(id) RESTRICT |
| event_seq | bigint NOT NULL | >0、PK(room_id,event_seq) |
| message_id | uuid NOT NULL | 複合FK(room_id,message_id)→messages(room_id,id) RESTRICT |
| event_type | text NOT NULL | CHECK IN ('created','deleted') |
| created_at | timestamptz NOT NULL | DB時刻 |

UNIQUE(room_id,message_id,event_type)。1メッセージにつき作成1件・削除は最大1件。
複合FKにより他roomのmessage_idを混ぜない。本文、本文ハッシュ、送信者名、JWT、
招待コード、旧行JSONは保存しない。messages.last_event_seqにイベントFKは設けない。
最新番号の整合性は同一トランザクションRPCとDML権限で保証する。

### 3.3 イベント方式の選択と保持期間

| 方式 | 利点 | 今回の問題 |
| --- | --- | --- |
| messagesのINSERT/UPDATEを直接購読 | テーブルが1つ | 送信カーソルだけでは過去行削除の差分を追えない。旧本文の配信リスクを別途抑える必要 |
| messagesに変更番号を持ち差分照会 | 1テーブルでも現在状態の同期は可能 | 変更される番号でのページ境界・同期上限・Realtime本文露出の扱いが複雑 |
| 本文なしイベント+現在状態API | 削除を追跡、順序・再送が明確、本文をRealtimeへ出さない | メタデータ表と採番・保存量が増える |

3番目を推奨。messagesとイベントは両方ともMVPでは無期限保存し、自動掃除を設けない。
メッセージとイベントの両方を無期限保存する方針は確定済み。
イベントに本文を複製しないため、作成イベントを再取得しても削除前の本文は復元できない。

採番はroom行ロック後に各表のmax(room_seq/event_seq)+1。インデックスで末尾を読む。
物理削除/イベント削除を提供しない前提なので番号を再利用しない。状態表やカウンタ列を
roomsへ追加しない。将来イベントを期限削除するなら、保持下限・永続カウンタ・410と
全再同期を先に導入する。max+1のまま末尾/全イベントを消すことは禁止する。
Postgres Changesの物理DELETEの認可制約も再評価し、安易な掃除ジョブを追加しない。

bigintはHTTPでは常に10進文字列。JSのNumberへ変換しない。Realtimeの数値は同期位置の
根拠に使わず、room UUIDと通知到着を差分取得の契機として扱う。

### 3.4 容量

最大500コードポイントはUTF-8本文だけで最大約2KB。10万件なら本文だけで最大約200MB、
実際は行・インデックス・イベント・削除時の旧タプル等が追加される。削除してもVACUUMや
バックアップ/WALの保持まで即消去されるわけではない。無期限保存はFree枠内の永久運用を
保証しない。容量監視・増加率・アップグレード判断を準備し、勝手な履歴削除はしない。

## 4. RPCとトランザクション設計

新規のchat専用RPCを提案する。既存group_mvp_execute/consume_rateは変更しない。
RPC名は設計上の仮称。全てservice_roleだけEXECUTE、SECURITY INVOKER、固定空search_path。
本人はExpressの検証済みJWTから渡し、DB側でもprofile/所属/room状態を確認する。

### send_room_message

1. 入力検証。ユーザー単位のトランザクションadvisory lockを固定のchat専用名前空間で取得。
   UUIDからキーを作る。ハッシュ衝突は余分な直列化にしかならず、認可には使わない。
2. room行FOR UPDATE。全send経路で「ユーザーロック→roomロック」を固定する。
3. 非アーカイブ/現在の所属を再検証。再送の場合も退出者には返さない。
4. 同一(sender_id,client_message_id)を検索。重複なら§7の規則で終了。
5. ロック待ち後のclock_timestamp()を判定時刻tとし、直近60秒の成功送信を確認。
6. room_seq/event_seqを採番。messages INSERTとcreatedイベントINSERT、last_event_seq設定。
7. 一緒にCOMMIT。イベント作成失敗なら本文保存もロールバック。クォータも増えない。

### delete_room_message

1. room行FOR UPDATE。非アーカイブ/所属/指定messageのroom一致を確認。
2. sender_id=p_actorを確認。他人は403、存在しない/他roomは404。
3. 既に削除済みなら200で現在のtombstoneを返す。新イベントなし。
4. body=NULL、deleted_at設定、次event_seqをlast_event_seqへ設定しdeletedイベントINSERT。
5. 同一トランザクションでCOMMIT。送信クォータは変更しない。

### list_room_messages / list_room_message_events

room行FOR SHAREで、認可・同期上限取得・現在状態の読取がsend/delete/leaveと交差しない
短い読取トランザクションにする。FOR SHAREはDB上の純粋なREAD ONLYトランザクションでは
使えないため、このHTTP GETを「DB read-only属性のRPC」とは定義しない。DMLは行わない。
同じロックを使う既存leave/joinの前後どちらかとして処理される。SQL Editorの監査SQLには
これらRPCを呼ばず、既存のREAD ONLY監査と混同しない。

複数roomをロックしない。APIはDBロック待ち時間を短く制限し、失敗は503+同じ送信IDで
再試行可能とする。タイムアウト後はCOMMIT済みの可能性を認め、二重保存しない。
将来別の書込経路を追加するときも同じロック/イベント規約を強制する。

## 5. API仕様

省略されていたパス変数は :roomId と :messageId と解釈する。
全APIでAuthorization: Bearer、no-store、UUID検証、現在の所属確認を必須とする。
GETにリクエスト本文はない。limitは1..100、既定50。カーソルはroomと方向を含む
バージョン付き形式として厳密検証し、内部のbigintを文字列で保持する。暗号化や署名を
認可の代用にしない。SQLは必ずroom条件を固定する。

### POST /groups/:roomId/messages

リクエスト:
```json
{"body":"こんにちは","client_message_id":"<VERIFICATION_ID>"}
```
201（再送200）:
```json
{"message":{"id":"<VERIFICATION_ID>","room_id":"<VERIFICATION_ID>","room_seq":"42","last_event_seq":"71","sender":{"id":"<VERIFICATION_ID>","username":"たろう"},"body":"こんにちは","created_at":"2026-11-13T03:00:00Z","deleted_at":null},"deduplicated":false}
```
bodyは正規化後1..500、blank禁止。client_message_idは必須UUID。sender_id、seq、時刻を
クライアントから設定させない。成功時のみ送信クォータを消費。返すlast_event_seqだけで
クライアントの全体同期位置を進めない。他人のイベントが間に存在し得るため。

### GET /groups/:roomId/messages

最初は?limit=50。過去ページは?limit=50&cursor=<next_cursor>。
```json
{"messages":[],"next_cursor":null,"has_more":false,"sync_event_seq":"71","evaluated_at":"2026-11-13T03:00:00Z"}
```
room_seq DESCで取得し、UIは昇順表示。最初の履歴をロック下で読んだ時点のevent上限を
sync_event_seqとして返す。削除済みも同じ順序位置に残し、body=nullとdeleted_atを返す。
過去ページは現在の状態を返すので、長時間の複数ページを一つのDBスナップショットとは
主張しない。メッセージごとのlast_event_seqで古い応答の上書きを防ぐ。

### DELETE /groups/:roomId/messages/:messageId

本文なし。本人かつ所属者だけ。200（繰り返しも200）:
```json
{"message":{"id":"<VERIFICATION_ID>","room_id":"<VERIFICATION_ID>","room_seq":"42","last_event_seq":"72","sender":{"id":"<VERIFICATION_ID>","username":"たろう"},"body":null,"created_at":"2026-11-13T03:00:00Z","deleted_at":"2026-11-13T03:01:00Z"},"already_deleted":false}
```
二度目はalready_deleted=true。senderの実プロフィールが消えていればsender=nullとする。
削除済み文言は表示側がdeleted_atから決める。削除前の本文を応答に含めない。

### GET /groups/:roomId/message-events

初回?after_event_seq=71&limit=50、以後は返却next_cursorを使用。
```json
{"events":[{"event_seq":"72","type":"deleted","message_id":"<VERIFICATION_ID>","created_at":"2026-11-13T03:01:00Z"}],"messages":[{"id":"<VERIFICATION_ID>","room_seq":"42","last_event_seq":"72","sender":{"id":"<VERIFICATION_ID>","username":"たろう"},"body":null,"created_at":"2026-11-13T03:00:00Z","deleted_at":"2026-11-13T03:01:00Z"}],"next_cursor":null,"has_more":false,"through_event_seq":"72","next_after_event_seq":"72"}
```
eventsは本文を持たない。messagesは対象message_idの重複を除いた現在の完全DTO。
createdイベントを再生しても現在削除済みならtombstoneしか返さない。
最初にroomロック下で上限Hを固定し、after<event_seq<=HをASCでlimit+1取得する。
next_cursorにはroom、直前番号、Hを含め、後続ページのHを変えない。
未完了ページではnext_after_event_seq=最後に返した番号、全完了時はH。
後続ページまでに新たな削除が起きた場合、messagesの現在状態のlast_event_seqがHより
大きいことは許容する。これは過去状態の再現APIではない。そのDTOを反映しても同期位置を
Hより先へ進めず、次の差分で新イベントを重複安全に取得する。
未来番号、負数、範囲外bigint、異なるroom/方向/バージョンのカーソルは400。
保持期間は無期限なのでMVPにカーソル期限切れ410は導入しない。

### 共通エラー

| HTTP | code例 | 動作 |
| --- | --- | --- |
| 400 | INVALID_INPUT / INVALID_CURSOR | 修正するまで同じ内容を自動再試行しない |
| 401 | UNAUTHENTICATED | JWT更新後に再試行。更新不能なら再ログイン |
| 403 | MESSAGE_NOT_OWNED | 所属者が他人のメッセージを削除しようとした場合 |
| 404 | GROUP_NOT_FOUND / MESSAGE_NOT_FOUND | 不存在・非所属・アーカイブを同様に扱う |
| 409 | CLIENT_MESSAGE_ID_CONFLICT / PROFILE_REQUIRED | ID変更での自動再送はしない |
| 413 | PAYLOAD_TOO_LARGE | JSONサイズ上限（本文500文字とは別） |
| 429 | MESSAGE_RATE_LIMITED | Retry-Afterとretry_after_secondsを返す |
| 503 | CHAT_UNAVAILABLE | 内部SQL/JWT/本文を露出せず、送信は同じIDで再試行 |

既存error文字列を維持しcodeを追加する案。既存グループAPIの契約は変更しない。
予期しない内部失敗も503として既存方針に揃える。DB制約違反の全てを400へ丸めず、
既知の入力違反と運用障害を区別する。

## 6. Realtime・RLS設計

### 公開範囲

- publication追加対象はroom_message_eventsだけ。購読はINSERT+room_idフィルター。
- messagesはpublicationに追加しない。既存publicationがFOR ALL TABLESでないことも確認。
- authenticatedにはイベント表のSELECTのみ。イベントRLSで現在の有効所属を検証。
- messagesの一般ロール権限は全て禁止。イベントのINSERT/UPDATE/DELETE/TRUNCATE等も禁止。
- service_roleにRPC EXECUTEと必要な表権限だけを付ける。広いデフォルト権限はCREATEと
  同一トランザクションで明示REVOKE。既存room/profileのGRANTを広げない。
- イベント表へのData API直接SELECTは同じRLS範囲で可能。本文は存在しない。

### 所属判定関数

非公開スキーマのchat_can_read_room(room_uuid)を提案。auth.uid()から本人を決定し、
非アーカイブroomとroom_membersの存在だけをbooleanで返す。任意のuser IDを受け取らない。
SECURITY DEFINERが必要なのは一般ロールにroom_members SELECTがないため。
所有者は監査済みの限定管理ロール、固定空search_path、全オブジェクト完全修飾、動的SQLなし。
PUBLIC/anon EXECUTEは禁止、authenticatedに必要なschema USAGE/EXECUTEだけ付与する。
関数が置かれるスキーマはData APIへ公開しない。実際の所有者・RLS適用/迂回能力・ロール
継承を監査する。SECURITY DEFINERを付けるだけで既存RLSを必ず越えられるとは扱わない。

### 公式仕様と実環境の境界

公式資料で確認: Postgres Changesは読める行の配信にRLSを利用し、購読者ごとに認可を行う。
publication設定とSELECT権限が必要。DELETEイベントにはRLS上の制約があり、
旧行配信はREPLICA IDENTITY設定にも依存する。したがって本文表の直接配信を避ける。
Broadcast/Presenceのチャンネル認可キャッシュとPostgres Changesの行認可を混同しない。

実DB/実クライアントで必須検証: 接続済みユーザーの退出COMMIT後、後続のイベントが
配信されないこと。APIの404だけではRealtimeの拒否を証明しない。既存JWTのまま購読を
継続する悪意あるクライアントも試す。もしプロバイダ挙動で要件を満たせないなら公開停止し、
認可キャッシュ/配信方法を再検討する。クライアントunsubscribeだけをセキュリティにしない。
退出前に認可・送出されたパケットが退出後に届くことまで取り消す保証はできない。
「退出直後」は退出後に認可される新イベントの拒否として確定する。
クライアントも退出時に購読を解除し、取得済みデータの表示を停止する。

### 再接続・削除同期

1. JWTを確認/更新してRealtime認証を設定し、イベント購読を成立させる。
2. 初回は履歴とsync_event_seqを取得。接続中イベントは一旦バッファする。
3. after_event_seqからAPIで上限Hまで全ページを同期。event_seq重複は無視。
4. messagesをid単位でmergeし、last_event_seqの小さいDTOで上書きしない。
   tombstoneを優先し、再同期で削除前本文を再表示しない。
5. 全ページ適用後だけ同期位置を進める。Realtimeで観測した最大番号に飛ばさない。
6. 切断/復帰/再認証時に同じ差分取得。通知自体が欠落した場合に備え、接続中も低頻度の
   差分照会を行う案（例30秒、表示roomのみ）を採用候補とする。省電力/読取量は測定する。
7. 退出/401/404時は購読停止しroom表示と当該roomのローカル本文キャッシュを破棄する。
   再加入は新規スナップショットから開始して過去全履歴を取得できる。

JWT更新は現在autoRefreshToken=falseなので、既存Auth処理との統合を実装前に設計する。
今回アプリの設定は変更しない。更新成功後はRealtimeへ新JWTを渡し、失敗時は購読を停止。

## 7. 送信制限・再送設計

既存の固定窓attemptカウンタを変更しない。新しいrate表も作らず、保存済みmessagesを
成功台帳として使用する。送信RPC内のユーザーadvisory lockで全room・全APIインスタンスを直列化。
ロック取得後のtに対しcreated_at > t-60秒の本人メッセージを数え、10件なら新規送信を拒否。
削除済みもカウントし、削除による枠回復は不可。時間ちょうど60秒前の成功は窓から外す。
判定時刻・created_atはアプリ時計やトランザクション開始前のnow()ではなく、ロック待ち後のDB時刻。
「成功時刻」はDBが記録する受理時刻とし、HTTP受信時刻・厳密なCOMMIT時刻とは区別する。

429は「最も古い窓内の成功時刻+60秒-t」を切り上げ、最低1秒をRetry-Afterへ設定する。
例: {"error":"Message rate limit exceeded","code":"MESSAGE_RATE_LIMITED","retry_after_seconds":12}。
同じユーザーの11並列リクエストは、他の条件が有効なら10成功・1拒否。DB失敗やrollbackは
messagesに残らないため非加算。削除APIはこの送信枠を消費しない。
認証前/不正入力/読取/削除の大量試行への入口保護は別枠で検討し、確定済み送信枠と混ぜない。

再送は所属検証後、クォータ確認より先に照合する。
- 同一room・未削除・同じ正規化本文: 200、既存DTO、再採番/新イベント/枠消費なし。
- 同じ識別子で別room、または未削除で本文が異なる: 409、既存本文は返さない。
- 同一room・削除済み: 200、tombstoneだけ返す。再INSERT/本文復元/クォータ消費はしない。
  この場合元本文が消えているため内容一致は比較しない。比較用の本文コピー/単純ハッシュも
  残さず、辞書攻撃や削除後の本文復元につながる情報を増やさない。削除済み再送200は確定済み。
- 同じIDを同時送信しても、ユーザーロックとUNIQUEで1行・1イベント・1件分だけ。
- クライアントは成功応答を失っても同じIDを再使用。タイムアウトを理由にIDを作り直さない。

## 8. セキュリティ上のリスクと対策

- service_roleはRLSを迂回: API認証とRPC内認可が必須。p_actorを端末から受け取らない。
- 削除旧本文: イベントに一度も複製せず、messagesをpublication/Data APIに公開しない。
  ログ/エラーメッセージ/旧行JSONにも含めない。既配信端末、バックアップ/WAL、管理者権限
  での残存まで論理削除で消せるとは主張しない。
- 古いイベントの再生: APIは現在のmessagesを返し、deleted_atのあるbodyは常にNULL。
- 所属のTOCTOU: API確認だけでなくroomロック後RPC内で確認。共有読取も同じroomと競合。
- 退出後受信: Realtimeの実測を出荷条件とし、イベントに本文を含めない追加防御を置く。
- ポリシー/関数の循環: events RLS→限定所属関数→room表という一方向にし、自表RLSを再帰しない。
- デフォルト権限: 管理RPC、messages、eventsの各CREATE直後に明示権限設定。PUBLICと他ロールの
  ACL/継承/関数所有者を確認し、authenticatedのTRUNCATE/REFERENCES/TRIGGER等も禁止。
- 無期限保存: 同期ログも増加する。監視と容量方針を用意し、Freeの上限を無視しない。
- 長いJSON/カーソル: 本文以外にもサイズ制限、UUID/10進文字列の厳密検証、未知パラメータ拒否。
- 保存本文をHTMLとして実行しない。削除表示文言は固定文字列としてアプリへ仕様提供する。
- タイマー/Pushに新しい副作用を接続しない。旧toggle SQLを再適用しない。

## 9. テスト計画

| 層 | 必須ケース・期待 |
| --- | --- |
| 本文 | 499/500成功、501拒否。日本語、絵文字、結合文字、CRLF、Unicode空白だけ、空、NULL、NUL |
| HTTP | 実JWT/無JWT/無効JWT、401/403/404/409/429/503、no-store、漏えいしないエラー |
| 通常操作 | 送信・最新/過去履歴・本人削除・削除再実行。DTOとDBが一致 |
| 削除安全性 | body=NULL、deleted_at不変、イベントに本文なし、createdイベント再生でも旧本文なし |
| 再送 | 同ID同本文200、異本文/room409、同時再送1行、削除後tombstone、制限到達後の再送も200 |
| 送信枠 | 10成功/11件目429、複数room合計、59.999/60秒境界、削除しても非回復、失敗非加算 |
| 並行処理 | 11並列で10件、複数APIプロセス、同room/別room、採番一意・順序、イベント失敗で全rollback |
| 認可 | 非所属・他room拒否、他人削除403、退出後送信/履歴/イベント拒否、再加入で参加前履歴も取得 |
| 競合 | send/deleteとleave/archive、重複DELETE、readとdelete、ロック待ちタイムアウト後同ID再送 |
| 権限 | 広いdefault ACL下でもmessages直接読取/書込とevents書込、管理RPC一般実行を拒否 |
| Realtime | 他room非配信、退出済み接続への後続イベント拒否、JWT期限/更新、INSERTだけ、本文なし |
| 再同期 | 接続前後の送信、通知重複/逆順/欠落、削除中の切断、旧履歴応答の遅着、複数ページ中の新規変更 |
| Account | sender FK SET NULL、履歴保持、退会表示、新規作成者偽装不可 |
| 回帰 | group作成/参加/退出/招待、最後のarchive、既存room値保持、暇状態/延長/端末登録に変更なし |

順序・制限テストはsleep任せにせず、隔離DBで既知のDB時刻/受理時刻とセッション間同期を使う。
本番タイマー関数のレプリカを作って実物の検証済みと扱わない。Realtimeは実際のSupabase
ローカルスタックまたは明示承認済み隔離プロジェクトで検証。単体モックだけでは出荷不可。
ログ/成果物にJWT、本文、コード、Push Tokenを保存しない。

## 10. 実装を開始する前に確認すべき事項

5項目は確定済みであり再承認待ちに戻さない。以下の技術的な検証・残る詳細判断を確認する。
1. コードポイント数は確定済み。空白集合・改行正規化の詳細を確認する。
2. 削除済み再送200は確定済み。未削除異本文/別roomの409処理を確認する。
3. 無期限保存は確定済み。容量費用/監視/予算を確認する。
4. 退出確定後の新規配信禁止は確定済み。接続済み購読に対する実測を出荷条件とする。
5. senderアカウント削除後はNULL/退会表示、本文保持、当人の削除権は消滅する扱い。
   全員退出後の再参加不可は確定済みで、既存アーカイブ仕様を維持する。
6. 実DBの未使用テーブル/関数、所有者・GRANT・RLS・publications/REPLICA IDENTITY、
   非公開スキーマの可用性、advisory lockとprofile/roomのFK関係を読み取り確認する。
7. 実プロフィール構造/削除トリガー・外部ワーカー依存。fixtureから断定しない。
8. Realtime/JWT更新のクライアント責務と低頻度同期の間隔。
9. 既存API契約を壊さない依存注入の分離、JSONコード・カーソル仕様のレビュー。
10. 実装後のマイグレーション適用は別承認。現在の設計作業では作成も適用もしない。

重点検証: room行ロック下のMAX+1採番を全書込経路で守り、物理削除を導入する前に永続
カウンタ等へ変更する。送信制限の(sender_id,created_at DESC)にはdeleted_at条件を付けず、
削除済みも窓内成功数に含める。Realtime退出後認可は実Supabaseの隔離環境で検証する。

## 11. 推奨実装順序

1. 上記詳細仕様を承認し、実DB定義と権限の読み取り照合（今回未実施）。
2. 隔離DB向けにmessages/events/RPC/所属RLSを実装し、広いdefault ACLで権限検証。
3. sendの原子性・成功台帳による全room制限・再送/採番を先に検証。
4. deleteのtombstoneとイベント、履歴/差分同期のスナップショット・カーソルを検証。
5. Express依存注入で4APIを接続。既存グループAPIとHTTP回帰テスト。
6. Realtimeイベント表のINSERT購読と退出/再接続/JWT実テスト。
7. クライアント契約を提示し、後続作業でアプリの認証更新・同期を実装。
8. 容量/負荷/ロック競合を測定し、適用前後監査・復旧情報の手順を別途レビュー。
9. 明示承認後だけ実DB適用・実JWT smoke。既存タイマー/Push回帰を確認。

## 公式資料と確認範囲

確認日: 2026-11-13。公式仕様を、今回のプロジェクトで実測済みとは扱わない。

- [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes): publication、
  SELECT/RLS、購読者ごとの認可、旧行/DELETEの注意点。
- [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization):
  Postgres ChangesとBroadcast/Presenceの認可の違い、JWTと認可キャッシュの注意点。
- [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security): GRANTとの組合せ、
  service role、限定関数の設計。
- [Realtime制限](https://supabase.com/docs/guides/realtime/limits): Free同時接続200・毎秒100。
  実プロジェクトの利用量、設定、退出時の配信停止は未確認。制限値は実装/公開時にも再確認。

この文書は実装・SQL適用・テスト実行の成果物ではない。追加されたのは設計書のみ。
