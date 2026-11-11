# 通常エントリーポイント検証（2026-11-11）

結果: 成功。実行時刻は日本時間14:14頃。

## 実行構成

検証専用エントリーポイントではなく、通常の`server/index.ts`をNode + tsxで起動した。
既存の専用ゲートウェイ`127.0.0.1:55440`、Auth、PostgREST、DB `imahima_member_free_test`を使用。
通常API用の待受は`HOST=127.0.0.1`, `PORT=55442`。
この指定のため、通常エントリーポイントへ任意の`HOST`設定を追加した。未指定時の既存動作は維持。

専用鍵だけを環境変数へ渡し、dotenvの読み込み先は空の検証ファイルに固定。
`tests/member-free-entrypoint-guard.cjs`をプリロードし、global fetchとNode HTTP/HTTPSを専用ゲートウェイ以外へ接続させない。
Expo宛ての通信が通信開始前に拒否されることをガード内で自己検証した。
Auth/RPC/Pushの応答を偽装する処理はない。

## 確認結果

| 確認 | 結果 |
|---|---|
| 通常API起動・health | 成功 |
| 不正Bearer | 401、プロフィール変更なし |
| 新しいA/Bの実Authログイン | 各200 |
| B→Aの暇ON | 各200、レスポンスとDBのis_free/free_untilが一致 |
| 通知キュー | Aのイベント1件、B宛てpending 1件 |
| Aの再ON | 200、イベント・キュー増加なし |
| 手動通知API | 200 / sent=0 / No registered devices |
| 両ワーカーの通常起動 | 成功 |
| 両claim RPC | 実DBから各200 |
| 暇ON通知のvalidate/complete RPC | 実DBから200 |
| 端末未登録の通知処理 | pending → cancelled、attempts=1、No registered devices |
| 通常shutdown処理 | 終了コード0 |
| 外部送信 | アプリからの外部HTTP試行0件、実Pushなし |

ワーカー段階のみ`FREE_END_NOTIFICATIONS_ENABLED=true`と`MEMBER_FREE_NOTIFICATIONS_ENABLED=true`、間隔各1000ms。
API確認段階は両方false。
Windowsでは子プロセスへのkillが強制終了になるため、検証用IPCから`SIGTERM`イベントを発火し、通常エントリーポイントのshutdownハンドラーで停止した。OSからの実シグナル配送は未検証。

実行したテスト:

- `node --test tests/test-member-free-entrypoint.mjs`: 1件成功、skipなし。
- API・ワーカーの既存モック回帰テスト: 67件成功。
- `tsc --noEmit`: 成功。

## DB上の記録と影響

- 新規イベント: `614048d5-7e8a-4612-87d4-e89b130eaeca`
- 新規送信待ち: `d5bdda00-95fc-48db-b4c8-43a70ae71c49`
- 前回検証の送信待ち`aca4ec09-44d7-43f3-9a89-762ee18dcf62`も、実ワーカーが取得したため`cancelled / No registered devices`へ遷移。
- 最終的に2件ともattempts=1、accepted_count=0。前回のJSONは当時のpendingを記録した履歴として保持。
- 専用DB内に追加したユーザー・room・イベントは削除せず保持。
- Dockerコンテナ・ボリューム・ネットワークの作成／変更／再起動／削除なし。
- 既存imahima DB、別プロジェクトDB、本番・共有DBへの接続なし。
- テストで新しく起動した通常APIプロセスは停止済み。前回の専用APIプロセスとDockerサービスは維持。

生の非機密記録は`tests/member-free-entrypoint-results.json`と`tests/member-free-entrypoint-worker-audit.json`。
再実行は既存の専用環境と秘密ファイルが有効な状態で上記コマンドを使用する。新しいfixtureを追加するので既存DBのreset不要。

## 残る確認

今回は端末トークン0件のため、実際のPush送信関数への受け渡し・受付成功・一時失敗からの再試行は通常起動の実DB経路では未検証。
次は専用環境の制御された送信先・テスト用transportでこの経路を確認し、その後に実端末で到達・再試行・重複送信を確認する。
