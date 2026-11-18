> Anonymized historical copy. Original retained locally. Current guidance: [backend](group-chat-backend.md) and [verification](group-chat-verification.md). Historical failures are preserved; old commands are not current deployment instructions.

# グループチャットMVP: DB実装・検証メモ

対象設計: `docs/group-chat-mvp-detailed-design.public.md`。今回はDB・RPC・RLSのみ。共有DBへの適用、Express、Realtimeクライアントの実装は行わない。

## 追加ファイル

- `supabase/migrations/20261113000000_group_chat_mvp.sql`: テーブル、権限、RLS、RPC、本文を含まないイベントpublication。
- `supabase/tests/fixtures/chat_mvp_environment.sql`: 隔離DB専用のauth.uid/publication/広いデフォルト権限。
- `supabase/tests/group_chat_mvp.test.sql`: トランザクション内の機能・境界・権限テスト。最後にROLLBACK。
- `tests/test-chat-db-concurrency.mjs`: 専用コンテナへの複数接続による並行処理テスト。

既存マイグレーション・グループ管理RPC・タイマー・Push処理は変更しない。

## 実装契約

`messages`はroom単位のroom_seq、最新変更のlast_event_seq、送信者単位のclient_message_idを持つ。profiles削除時はsender_idをNULLにして履歴を保持する。論理削除後は本文NULL。トリガーで本文編集・復元・物理削除を拒否する。

`room_message_events`は作成/削除のメタデータのみを保存し、UPDATE/DELETEを禁止する。Realtimeにはこの表だけを追加する。本文・送信者・JWT・招待コードはイベントに保存しない。

送信はユーザーadvisory lock（名前空間1128813617、ユーザーIDのhashtext）→room FOR UPDATEの順。削除はroom FOR UPDATE。履歴/差分はroom FOR SHARE。既存join/leaveと同じroom行で直列化する。採番はロック後MAX+1。物理削除を導入する場合は永続カウンタ等への再設計が必要。

成功メッセージを台帳として全room合計の直近60秒を数える。削除済みも含め、再送はカウントしない。時計はロック後clock_timestamp()、境界はcreated_at > t - 60秒。既存グループ操作のレート制限表/RPCは使わない。

本文はUnicodeコードポイント1〜500、Unicode White_Spaceのみは禁止、CRLFをLFに正規化する。削除済みIDの再送は200でtombstoneを返し、本文を復元しない。

### RPC

すべてSECURITY INVOKER、空search_path、service_role専用EXECUTE。戻り値は既存と同じ`{status, data}`。このstatusはSQLの戻り値であり、PostgREST自体のHTTPステータスを変更しない。

| RPC | 主な引数 | 内容 |
|---|---|---|
| chat_send_message | p_actor, p_room_id, p_body, p_client_message_id | 新規201、同一再送200、衝突409、制限429 |
| chat_delete_message | p_actor, p_room_id, p_message_id | 本人のみ200、他人403、所属/対象なし404 |
| chat_list_messages | p_actor, p_room_id, p_limit=50, p_cursor=NULL | room_seq降順、limit最大100、sync_event_seq |
| chat_list_message_events | p_actor, p_room_id, p_after_event_seq='0', p_limit=50, p_cursor=NULL | 固定上限Hまでevent_seq昇順と現在状態 |

認証済みユーザーIDを渡す責任は後続のExpress実装にある。RPCはservice_role実行・profiles存在・現在の所属/アーカイブ・削除本人を再検証するが、任意のp_actorが正しいJWT由来かは検証できない。service_roleキーはサーバー限定とする。

RPCはREAD COMMITTEDを要求する。異なる分離レベルは例外。ロック待ちは5秒。後続ExpressでSQL例外/タイムアウトを秘匿した503等へ変換し、同じclient_message_idで再送できるようにする。429のretry_after_secondsをRetry-Afterへ変換する。

カーソルはDB層ではJSONBオブジェクト。履歴は`{v:1,room_id,direction:"before",before_seq:"..."}`、イベントは`{v:1,room_id,direction:"after",after_seq:"...",through_seq:"..."}`。APIでのエンコードは未実装。bigintは10進文字列で返す。

イベントページング中に削除が進むと、返す現在状態のlast_event_seqが固定上限Hより大きくなることがある。クライアントはメッセージ状態の版比較と同期カーソルを分離し、through_event_seqを超えて同期位置を進めない。古い応答でtombstoneを上書きしない。

## 権限・適用前提

一般ロールはmessagesを直接参照/更新できない。authenticatedはイベントSELECTのみ。room_membersの既存権限は広げない。非公開chat_privateスキーマの限定SECURITY DEFINER関数はauth.uid()自身の所属だけを判定する。所有者はマイグレーション実行ロールであり、未監査のロールへの付け替えはしない。

適用時はUTF8、auth.uid()、INSERTを配信するsupabase_realtime publication、所有者の非フィルター所属参照権限を検査する。全テーブル/publicスキーマ単位の広いpublicationがある場合、本文漏えいを避けて中断する。新規オブジェクトの名前衝突も中断する。既存表の権限・ポリシー・関数は置き換えない。

実環境ではpublication設定、所有者/BYPASSRLS、privateスキーマをAPI公開スキーマに含めない設定、service_role権限、外部削除処理との依存を別途監査する。room物理削除は新FKのRESTRICTにより拒否される。既存の退出/アーカイブは物理削除しないため維持される。

## 隔離テストの実行方法（PowerShell）

実DB接続情報は不要。次のコンテナ名が既存作業に使われていないことを確認して実行する。ネットワークnone、永続ボリュームなし。

```powershell
docker run -d --name imahima-chat-db-verification --network none --tmpfs /var/lib/postgresql/data -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16 -c wal_level=logical
docker exec imahima-chat-db-verification pg_isready -U postgres
# 起動完了後。NodeでUTF-8バイト列を渡し、PowerShellの文字コード変換を避ける。
@'
const fs = require('fs');
const {execFileSync} = require('child_process');
for (const file of [
  'supabase/tests/fixtures/group_mvp_schema.sql',
  'supabase/tests/fixtures/chat_mvp_environment.sql',
  'supabase/migrations/20261111000000_group_management_mvp.sql',
  'supabase/migrations/20261113000000_group_chat_mvp.sql',
  'supabase/tests/group_chat_mvp.test.sql',
  'supabase/tests/group_mvp.test.sql',
  'supabase/tests/group_availability.test.sql'
]) {
  execFileSync('docker', ['exec', '-i', 'imahima-chat-db-verification',
    'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'],
    {input: fs.readFileSync(file), stdio: ['pipe', 'pipe', 'pipe']});
  console.log('PASS ' + file);
}
'@ | node
node tests/test-chat-db-concurrency.mjs
# 並行テストの合成データはこの専用コンテナ内に残すため、終了後に破棄する。
docker rm -f imahima-chat-db-verification
```

2026-11-13の隔離PostgreSQL16で上記SQL3組・並行テストが成功。広いデフォルト権限下で一般ロールのRPC/本文操作拒否、所属に応じたイベントRLS、500/501文字、60秒境界、削除後も送信枠消費、再送、本人削除、イベント失敗時rollback、退会、アーカイブを確認した。並行11送信は10成功/1制限、同時再送は1行、room/event採番一意、同時削除は1イベント、送信と退出の両順序を確認した。

未検証: 実SupabaseのWebSocketによる退出直後の配信停止、JWT更新、切断/逆順/欠落からのクライアント復旧、実データ量での性能/容量。SQLのRLSテストだけでRealtime配信停止を保証したとは扱わない。既に送出されたパケットはクライアント側でも退出時に破棄する。無期限履歴とイベントによる容量増加、論理削除前本文のWAL/バックアップ残存も別途管理する。
