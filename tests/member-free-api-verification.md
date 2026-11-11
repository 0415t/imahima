# 通知APIの専用ローカル検証

実施日: 2026-11-11（日本時間）。結果: 成功。

## 構成と接続先確認

```text
Express 127.0.0.1:55441
  -> 新規HTTPゲートウェイ 127.0.0.1:55440
     -> 新規Auth v2.197.0 / 新規PostgREST v16.5
        -> host.docker.internal:55439/imahima_member_free_test
```

- 新規ネットワーク: `imahima-member-free-api-net`
- 新規コンテナ: `imahima-member-free-api-auth`, `imahima-member-free-api-rest`, `imahima-member-free-api-gateway`
- 接続確認用コンテナ: `imahima-member-free-api-db-probe`（終了状態で保持）
- 新しいボリュームは不要。新規サービスは既存ボリュームをマウントしない。
- DBコンテナへのネットワーク追加・再起動・設定変更は行わず、既存のlocalhost公開ポートを使用した。
- 起動前に新規probeから読み取り専用接続し、DB名とクラスタ識別子`7706764719554813981`を専用DB内の値と照合。一致を確認。
- Auth/RESTは`docker create`後、停止状態で実際の接続URL・ネットワーク設定を検証してから起動。
- PostgRESTの起動ログでも`host.docker.internal:55439`への接続を確認。
- JWT署名鍵・anon key・service role keyを暗号学的乱数から専用に生成。既存環境の鍵は使用していない。
- 専用クラスタの`supabase_auth_admin`と`authenticator`のパスワードも専用乱数に設定。
- 秘密情報はGit対象外の`.env.member-free-*.local`に保持。結果JSONには含めていない。

## 実行結果

| 操作 | HTTP | DBとの照合 |
|---|---|---|
| A/Bの実Authパスワードログイン | 各200 | 登録ユーザーIDとログインのIDが一致 |
| 誤パスワード | 400 / invalid_credentials | ログイン拒否 |
| Bearerなし | 401 | プロフィール・イベント・送信待ちに変更なし |
| 不正Bearer | 401 | プロフィール・イベント・送信待ちに変更なし |
| Bを先に暇ON（30分） | 200 | is_free/free_untilが一致、Bのイベント1件・送信待ち0件 |
| Aを暇ON（30分） | 200 | is_free/free_untilが一致、Aのイベント1件・B宛て送信待ち1件 |
| Aを再ON（60分指定） | 200 | 既存タイマー・ON期間・イベント・送信待ちを維持 |
| 手動通知API | 503 | 通知依存が未設定のため送信処理へ到達しない、DB変更なし |

ONリクエストに別ユーザーの`user_id`も含め、操作対象が本文ではなく認証ユーザーから決まることを確認。

最終の記録:

- Aのイベント: `429b501a-2bb8-4cc1-85ec-7685681e6bfa`
- B宛て送信待ち: `aca4ec09-44d7-43f3-9a89-762ee18dcf62`
- イベント合計2件（B自身のONも記録）、送信待ち合計1件。
- 送信待ちは`pending`, `attempts=0`, `lease_token=null`, `accepted_count=0`, `sent_at=null`。
- イベントのactor期間とAのプロフィール、送信待ちのrecipient期間とBのプロフィールが一致。
- 詳細なAPIレスポンスとDBスナップショットは`tests/member-free-api-results.json`に保存。

検証:

- 実Auth/API/DB統合テスト: 1件成功、skipなし。
- Auth更新後のSQL回帰テスト4本: すべて成功。
- 既存APIルートのモック回帰テスト: 34件成功。
- `tsc --noEmit`: 成功。
- 前回の実DB並行テストは成功済み。今回はデータを保持するため、空DBを要求する並行テストを再実行していない。

## Push遮断

`server/local-member-free-api.ts`が既存の`createApp`ルートを起動する。`server/index.ts`は起動しない。
両ワーカーの環境変数が`false`であることを起動時にassertし、ワーカー・Expo送信サービスはimportしない。
`createApp`に通知依存を渡さないため、手動通知APIは503。
プロセスのfetchも専用ゲートウェイorigin以外を拒否する。外部Push送信なし。

## 互換性・影響・残る範囲

- 同じ現行Authイメージが公式のAuthスキーマ更新を正常実行。`auth.schema_migrations`に82記録、最大`20260831180000`、`email_confirmed_at`を確認。手動でAuth列を追加する等の回避なし。
- Authログに旧JWT group設定の廃止予定警告あり。起動・認証・DB処理の失敗はなし。
- 既存DB・既存コンテナ・既存ボリューム・既存ネットワークは変更していない。55322や別プロジェクトDBへの接続なし。本番・共有DBへの接続なし。
- 書き込みは承認された専用DB内のAuth更新・専用ロールパスワード・fixtureに限定。
- 新規コンテナ・ネットワーク、Expressプロセス（起動時PID 23376）、A/B・room・通知記録は削除せず保持。
- 暇状態には期限があり、既存の専用DBのauto-expireジョブで後にOFFになり得る。JSONはテスト時点の記録。
- 既存`server/index.ts`の起動処理や本番構成、実Push配信は今回の対象外。同じルート実装とRPCを使う専用エントリーポイントで検証した。
- anon/service role keyは生成時から7日、ログインaccess tokenは1時間の有効期限。期限後の再利用には専用鍵・セッションの更新が必要。

## 実行ファイル

- `tests/setup-member-free-api.mjs`: probe照合、鍵生成、専用サービス作成、Auth起動。初期構築専用。秘密ファイルが既に存在すると上書きせず停止する。
- `tests/member-free-api-gateway.mjs`: 接続先を専用Auth/RESTに固定するHTTPゲートウェイ。
- `server/local-member-free-api.ts`: localhost限定、PushなしのAPI起動用。
- `tests/test-member-free-api.mjs`: Auth/API/DBの実検証。初期プロフィール・イベントが空であることを要求するので、現在のデータ保持状態ではそのまま再実行しない。

既存fixtureを消すresetは不要。再実行する場合は、別fixtureを使う手順へ更新してから行う。既存の検証記録を消すためのresetを実施しない。

構成の参考: [Supabase公式Docker構成](https://github.com/supabase/supabase/blob/master/docker/docker-compose.yml)、[Auth v2.197.0公式説明](https://github.com/supabase/auth/blob/v2.197.0/README.md)。
