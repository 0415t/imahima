# Issue #36 のローカル統合テスト

Node.js 24、リポジトリの依存パッケージ、ローカルの Linux Docker エンジンが必要です。
事前に次のイメージをローカルに用意してください。ランナーはイメージを pull しません。

- `public.ecr.aws/supabase/postgres:17.11.0.011`
- `public.ecr.aws/supabase/gotrue:v2.197.0`
- `public.ecr.aws/supabase/postgrest:v16.5`

リポジトリルートで次を実行します。

```sh
node --test --test-isolation=none tests/test-chat-push-integration.mjs
```

ランナーは毎回固有のラベルと名前で新規DB・Auth・PostgRESTを構築し、DBはホストに公開しません。
AuthとPostgRESTのコンテナポートも公開しません。ホスト側のループバックゲートウェイが、専用コンテナ内の curl を通じて Docker 内部ネットワークの Auth と PostgREST にだけ中継します。
DBの識別子・実行nonce・バージョンを照合し、実Authのスキーマ初期化後に、空のテストDBだけへ
23本のmigrationを適用します。アーカイブの分類は空のルーム集合に対する空配列です。
実行済みのローカルSupabaseや共有DBを指定する引数はありません。

合成ユーザーはGoTrue管理APIで作成し、実パスワードログインのJWTでAPIを操作します。
Expressは通常の `server/index.ts` を使い、セットアップ用プロセスでは全ワーカーを無効にします。
検証用プロセスだけでチャットPushワーカーを起動し、終了前・暇ON通知は無効にします。
ルートの `.env` や起動元のDB・Expo設定を読み込まず、実行ごとに生成したローカル資格情報を使います。

送信モックはExpo SDKの最終HTTP送信だけを置き換えます。
通常API・Auth・PostgREST RPCの応答は実サービスのものです。テスト用preloadは検証用ゲートウェイ以外への
TCP接続を拒否し、模擬Expoでは当該実行で生成したトークンだけを受け付けます。
親ランナーも環境プロキシを使わないHTTPエージェントで登録済みのループバックにだけ接続し、リダイレクトを拒否します。
`loaderIpcBlocked` は、tsx が親プロセスに接続しようとしたローカルIPCの拒否件数です。外部TCPとは別に集計します。
削除との競合はワーカーの2回目の実validateリクエストをIPCで一時保留し、実APIの削除完了を待ってから
転送します。対象通知IDの実PostgREST応答がHTTP 200で `owned=false` になり、模擬Expoに送信されないことを確認します。
期限切れは隔離された合成行の時刻を調整して再現します。

実行結果にはケース別成否、模擬Expo件数、外向き接続拒否テストの結果、outboxの終端行数を表示します。
JWT、パスワード、Pushトークン、実通知内容の出力は不要です。
`sent` は模擬Expo受付を意味し、実機配信・Realtime・Hosted環境の検証とは別です。

正常完了、テスト失敗、SIGINT/SIGTERMで実行中の子プロセスと当該実行のDockerリソースを終了します。
### 強制終了後の手動復旧

ローカルDockerコンテキストで、対象ランナーが終了済みであることを確認します。
先頭の `Issue #36 Docker run UUID` に表示された値を指定し、PowerShellで対象を照合します。

```powershell
$run = '<出力された実行UUID>'
if ($run -cnotmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { throw 'Invalid run UUID' }
$filter = "label=imahima.issue36.run=$run"
docker ps -a --no-trunc --filter $filter --format '{{.ID}} {{.Names}} {{.Labels}}'
docker network ls --no-trunc --filter $filter --format '{{.ID}} {{.Name}} {{.Labels}}'
```

表示されたUUIDが一致し、コンテナ名が `imahima-issue36-<UUID>-db`、`-auth`、`-rest` のいずれか、
ネットワーク名が `imahima-issue36-<UUID>` であることを確認します。確認済みの完全IDを1件ずつ指定し、
コンテナを全件削除した後にネットワークを削除します。

```powershell
docker rm -fv <確認済みのコンテナID>
docker network rm <確認済みのネットワークID>
```

一覧コマンドを再実行し、両方とも空であることを確認します。別の実行UUIDや既存のSupabase環境には触れません。

障害注入では、`ISSUE36_SKIP_FINAL_VALIDATE=1` で最終validateの欠落を検出できます。
`ISSUE36_SIMULATE_LOST_CREATE=network` または `container` では、Dockerで実際に作成された後に
CLIの結果が失われた場合を再現できます。各コマンドは失敗し、当該UUIDのリソースは後始末されます。
