> Anonymized historical record; original retained locally. Historical failures remain unchanged. Channel connection refusal is not an MVP criterion. Fresh event delivery to the repaired historical room remains UNTESTED. See [current guidance](../../../docs/group-chat-verification.md).

# ローカルアプリ用スキーマ適用記録

2026-11-13、承認された `imahima-chat-local` だけに適用。APIは127.0.0.1:56321、DBは127.0.0.1:56322/postgres。既存のホスト型Supabase、暇通知/権限検証DBは操作していない。

## 依存関係と実施順

1. `sql/00_application_base.sql`（今回追加、ローカル専用）
2. `../../supabase/migrations/20261111000000_group_management_mvp.sql`（変更なし）
3. `../../supabase/migrations/20261113000000_group_chat_mvp.sql`（変更なし）

各ファイルのBEGIN/COMMITを使い、lock_timeout=5秒、statement_timeout=60秒。対象ファイルだけをNode PostgreSQLクライアント経由で個別適用した。CLIのdb push/link/resetやマイグレーション一括適用はしていない。自動migrations/seedは引き続き無効。

既存の20261006000000_toggle_profile_is_free.sqlと20261017000000_create_user_device_tokens.sqlは、グループ/チャットの依存ではないため未適用。古いtoggleは確認済みタイマー仕様と異なるので、今回のローカル環境にタイマーの正本として導入しない。

## ベースDDLの範囲

- profiles: AuthユーザーIDへのFK、username/is_free/created_at/coment/avatar_url/free_until。
- rooms: UUID、room_name、UNIQUEのroom_keyと安全な生成関数。
- room_members: room/user複合PK、rooms/Authへの既存方針と同じFK、owner/memberのrole制約。
- 全3表のRLS、プロフィール本人SELECT、service_roleのプロフィールSELECT。
- 非公開 `chat_local_support.handle_new_user()` と追加トリガー `auth.users.chat_local_profile_created`。

登録トリガーはprofilesを自動作成するための**ローカル用追加**であり、Supabaseが持つAuthテーブル・関数・ロール・既存トリガーを削除/上書きしない。SECURITY DEFINER、空search_path、一般/serviceロールの関数実行・スキーマアクセスは禁止。トリガーの実動作はユーザー作成を禁止されているため未検証。

このベースDDLは完全な実DBスキーマの復元ではない。profilesの本人参照ポリシーなどは検証用に明示した最小権限であり、チームDBの未知のRLSと同一と主張しない。テスト用users表、通知関連表/ジョブ、タイマー関数は作成していない。

既存fixtureはAuthロール/テーブルの再作成とサンプルroomのINSERTを含むため流用していない。

## 接続先・適用安全策

`schema-tools.mjs`が専用CLI statusのURL、Dockerの所有ラベル・絶対作業パス・ネットワーク・127.0.0.1:56322公開を確認。その後、環境変数に依存せず**TCP 127.0.0.1:56322**へ接続し、DB名/ロール/保存済みsystem_identifierを照合した。Auth比較情報と各SQLのSHA-256を記録。

`apply-schema.mjs --apply`は今回実行済み。`.runtime/application-state.json`がある場合は再実行を拒否する。途中失敗した場合は当該ファイルの未完了トランザクションだけrollbackして停止し、既にコミット済みの前段は勝手に復旧しない。無条件再実行・マーカーの削除は禁止。

## 適用後の確認結果

- profiles/rooms/room_members/group_mvp_rate_limits/messages/room_message_eventsの6表でRLS有効。
- 一般ロールはrooms/room_members/送信制限表/messagesに直接アクセス不可。
- authenticatedは本人profilesと所属先イベントのSELECTのみ。メンバー表の権限は広げていない。
- 管理RPC6本はSECURITY INVOKER・空search_path・service_roleだけ実行可。
- service_roleのmessages UPDATEはbody/deleted_at/last_event_seqのみ。メッセージ物理DELETE、イベントUPDATE/DELETEは不可。
- 限定所属確認関数はSECURITY DEFINER・空search_path・row_security=off、authenticatedだけ実行可。
- publication追加対象はroom_message_eventsだけ。messagesは含まず、イベントに本文列なし。
- Auth既存オブジェクトのOID/定義/所有者/ACL/RLS/カラム/既存トリガー等を前後比較して一致。新規アプリ用トリガーとFK依存は意図した追加。
- auth.users、profiles、rooms、room_members、messages、イベント、送信制限表は全て0件。
- 専用PostgRESTへschema reloadを通知後、service_roleによるOpenAPIのGETで管理RPC6本を確認。RPCは呼び出していない。
- 既存マイグレーションのファイルハッシュは適用前後で一致。

## 記録ファイル

詳細はすべてGit対象外の`.runtime/`に保存する。

| ファイル | 内容 |
|---|---|
| application-state.json | 適用順、各ファイルSHA-256、コミット状態、識別子 |
| schema-step-1.json〜3.json | SQLコマンド実行結果、COMMIT確認 |
| auth-before-schema.json / auth-after-schema.json | Auth既存オブジェクト比較情報（ユーザーの秘密列値は取得しない） |
| schema-postflight.json | RLS/GRANT/RPC/ポリシー/制約/インデックス/トリガー/publicationの全照会結果 |
| schema-verification.json | スキーマ検証の要約 |
| verification.json | 基盤health、既存Docker環境・保護ファイルの比較結果 |

## 今後の確認コマンド

この段階では従来の `npm run verify`（空スキーマ専用）ではなく、次を使用する。

```powershell
Set-Location <WORKSPACE>\verification\group-chat-local
npm run verify:schema
```

読み取り専用の `sql/application_postflight.sql` を使用する。ユーザー0件を要求するため、テストデータ作成の承認後は別の段階用手順へ更新する。

## 未検証・次工程

実JWTでのExpress→PostgREST→RPC、登録トリガーの実行、RealtimeのPostgres Changes購読/退出後配信停止/再同期は未検証。次の明示承認後に専用ユーザー・room・メッセージを作成して確認する。ルートExpressの暇状態APIに必要なタイマー関数はこの環境にないため、今回の構成を暇状態/通知の完全な回帰環境とは扱わない。

マイグレーション履歴は専用application-state.jsonで管理し、Supabase CLIの履歴テーブルを手動更新していない。CLI reset/pushによる再現を前提にしない。
