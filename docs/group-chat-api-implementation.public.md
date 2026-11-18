> Anonymized historical copy. Original retained locally. Current guidance: [backend](group-chat-backend.md) and [verification](group-chat-verification.md). Historical failures are preserved; old commands are not current deployment instructions.

# グループチャットMVP Express API実装

2026-11-13。対象設計は `group-chat-mvp-detailed-design.public.md`、DB契約は `group-chat-db-implementation.public.md`。

## 接続

`server/index.ts`で既存service_roleクライアントと `auth.getUser(accessToken)` を再利用する。`createApp`の第3引数にチャット依存を追加した。既存の第1/第2引数とグループ・暇状態の処理は維持する。

`server/chat.ts`が認証、入力検証、現在の所属確認、HTTP変換を担当し、`server/services/chat.ts`が4つのDB RPCへ接続する。認証済みIDを `p_actor` に設定し、クライアントの送信者指定や未知パラメータは400にする。所属確認後の退出等はRPCの再検証で拒否する。

| HTTP | RPC |
|---|---|
| POST /groups/:roomId/messages | chat_send_message |
| GET /groups/:roomId/messages | chat_list_messages |
| DELETE /groups/:roomId/messages/:messageId | chat_delete_message |
| GET /groups/:roomId/message-events | chat_list_message_events |

POSTはapplication/jsonの `{body, client_message_id}`。改行CRLFをLFへ正規化し、Unicodeコードポイント1〜500、Unicode White_Spaceだけの本文、NUL、不正サロゲートを検証する。送信制限、再送、削除権、採番、トランザクションはDBの責任とする。

GETはlimit（既定50、最大100）とcursor。イベント初回はafter_event_seq（既定文字列0）を利用でき、cursorとの同時指定は禁止。GET/DELETEに本文は受け付けない。

HTTPの `next_cursor` はDBのJSONBオブジェクトをUTF-8 JSON→パディングなしbase64urlにした文字列。受信時の最大2048文字、形式、room、方向、バージョン、キー、bigint範囲を検証する。これは署名や認可の代用ではない。未来の位置等はRPCが検証する。シーケンス番号は文字列のまま保持する。

RPCの `{status,data}` をHTTP statusとJSON本文に展開する。429は `retry_after_seconds` と `Retry-After` を返す。予期しないDB障害・権限エラー・ロック待ち失敗・認証サービス例外は503/CHAT_UNAVAILABLE。不正/期限切れJWTは401/UNAUTHENTICATED。全応答no-store。SQL詳細・本文・JWTのログは追加していない。

既存JSONパーサーの100KB上限を再利用し、チャットの構文エラーは400/INVALID_INPUT、超過は413/PAYLOAD_TOO_LARGE。他のグループAPIのエラー形式は変更しない。

## 検証

実DBの環境変数を読み込まないローカルHTTPテスト:

```powershell
node --import tsx --test --test-concurrency=1 tests/test-chat.ts tests/test-groups.ts tests/test-profile-toggle.ts
```

31件成功（チャット10、既存グループ16、暇状態5）。認証拒否、本人ID固定、不正入力、Unicode境界、カーソル往復、所属拒否、再送/403/409/429変換、障害秘匿、JSON/サイズ上限を検証した。

隔離DB結合テストはDB実装メモの専用コンテナを起動し、2つのfixtureと既存グループ/新規チャットmigrationを読み込んでから実行する:

```powershell
$env:CHAT_ISOLATED_DB='1'
node --import tsx --test tests/test-chat-db.ts
Remove-Item Env:CHAT_ISOLATED_DB
docker rm -f imahima-chat-db-verification
```

専用コンテナ名・postgres:16・network noneを検査する。HTTP→実サービスアダプター→psql経由の実RPCで、送信・再送・衝突・他人削除403・本人削除・削除後再送・履歴/イベントページング・10件制限・退出後拒否が成功。合成データはコンテナ内だけに作成し、コンテナ破棄で除去する。

この結合テストは認証を注入し、Supabaseクライアントのrpc転送をpsqlへ置き換える。実Supabase AuthのJWT検証、PostgREST経由の通信・スキーマキャッシュを検証したものではない。

変更バックエンド・新規テストの型チェックは成功:

```powershell
node node_modules/typescript/bin/tsc --noEmit --ignoreConfig --module node16 --target es2022 --strict --esModuleInterop --skipLibCheck server/app.ts server/index.ts server/chat.ts server/services/chat.ts tests/test-chat.ts tests/test-chat-db.ts
```

全体の `tsc --noEmit` は既存フロントエンドのルート型、react-navigation依存、アイコン型、ColorSchemeNameのエラーで失敗する。対象外のため変更していない。

## 次工程・未検証

- 明示承認後のDB適用と、実JWT/PostgREST経由のスモークテスト。今回共有DBへの接続・書込みは行っていない。
- Realtime購読、退出直後の配信停止、JWT更新、再接続・逆順・重複・削除の差分復旧。今回は実装していない。
- クライアントはカーソルを不透明文字列として渡し、last_event_seqで状態比較し、送信応答だけで全体の同期位置を進めない。
- 実環境での容量・負荷・大量アクセス対策。新しい送信制限器をExpress側に追加していない。
- 既存タイマー/Pushの実サービス疎通は未実施。該当処理と既存マイグレーションは変更していない。
