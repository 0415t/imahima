> Anonymized historical copy. Original retained locally. Current guidance: [backend](group-chat-backend.md) and [verification](group-chat-verification.md). Historical failures are preserved; old commands are not current deployment instructions.

# MVP管理roomのアーカイブ修正（2026-11-16 JST）

後続の[既存room修復結果](../verification/group-chat-local/reports/ROOM-REPAIR-RESULTS.public.md): 明示承認により対象1件をアーカイブし、所属・履歴を保持してAPI/RLS拒否を確認した。Realtime接続成立とデータ認可の差、および未実施項目を区別して記録している。以下の「未修復」は修復前の履歴。

## 実装と適用先

`20261116000000_group_mvp_managed_archive.sql`を追加。既存migrationは変更していない。適用したのは`imahima-chat-local`（127.0.0.1:56322/postgres、保存済みクラスタ識別子に一致）のみ。CLI db push/link/reset、共有DB、他の検証環境は使用していない。

汎用migrationにはローカルのroom ID、Project Ref、クラスタ識別子を埋め込んでいない。適用セッションの`imahima.room_classification`へ、レビュー済みJSON配列（room_id、mvp_managed、evidence）を渡す。

ローカル分類は`verification/group-chat-local/archive-classification.local.json`に分離。26件は実行結果の作成IDとSHA-256、1件は環境・ID限定のユーザー承認。対象27件・重複なし・未知IDなしを照合する。チーム用/他環境の分類には流用禁止。

適用結果は`.runtime/archive-migration-application.json`。27件すべてtrue、未分類0。分類前後のrooms（新フラグ除外）、profiles、所属、メッセージ、イベントの件数/digestが一致。既存テーブルのACL/RLSも一致した。招待コード、作成者参照、アーカイブ日時、所属、本文、イベントは変更していない。

## スキーマ・RPC

- `rooms.mvp_managed boolean NOT NULL`を追加。分類完了後にNOT NULL化する。暗黙のdefaultは設けず、新規MVP作成RPCがtrueを明示する。非MVPを追加する管理処理はfalseを明示する。
- migrationはrooms/room_membersへの書込みをロックしてから分類を検証する。入力欠落、件数不一致、重複、未知ID、不正なboolean/evidenceはトランザクション全体を中断。
- 作成者FKのON DELETE SET NULLと招待取得の作成者認可は維持。
- `group_mvp_execute`のcreateだけが管理フラグを設定する。leaveの旧アーカイブ判定を取り除き、所属トリガーに集約。公開引数/応答、認証、参加判定、既存のroomロックは維持。
- chat RPC、Realtime publication、RLSポリシー、Auth登録・タイマー・Push定義は変更しない。

## トリガーと権限

DELETE/UPDATEそれぞれにAFTER STATEMENTトリガーを設け、OLD transition tableの旧room IDを重複排除してUUID順にロックする。UPDATEはPostgreSQLのtransition table制約によりUPDATE OF room_idではなくUPDATE全体を対象にする。roleのみの変更では所属が残るためアーカイブされない。

各roomロック取得後、別SQLコマンドで残存所属を確認する。mvp_managed=true、未アーカイブ、0人の全条件を満たす場合だけ時刻を設定する。Auth hard deleteのCASCADEでも同じ処理が実行される。既にアーカイブされたroomの日時は再設定しない。

`group_mvp_private.archive_empty_membership_rooms()`はpostgres所有の限定SECURITY DEFINER。search_path空、row_security=off、lock_timeout=5秒。作成時に所有者の参照/更新権限と非フィルター参照能力を検証。private schema・関数のPUBLIC/anon/authenticated/service_role権限を明示REVOKEし、直接RPCとして公開しない。Auth実ロールからのCASCADEによる実行は実測済み。

READ COMMITTEDを要求し、それ以外は失敗・全体rollback。送信RPCのユーザーadvisory→roomの順序は変更しない。トリガーはユーザーロックを後から取得しない。複数旧roomを順にロックするが、AuthのFK処理を含むすべての組合せでデッドロックが存在しないことを保証するものではない。TRUNCATE/トリガー無効化は通常操作対象外であり、管理者が不変条件を迂回しない運用が必要。

## 検証記録

| 層/実行 | 成功 | 失敗 | 内容 |
| --- | ---: | ---: | --- |
| 適用前の分類拒否 | 4 | 0 | 欠落・重複・未知ID・文字列boolean。列/データが残らないことを確認 |
| `archive-<RUN_ID>` | 17 | 1 | CASCADE、移動、legacy保護、参加競合、複数room、Auth/送信、rollback。最後のRealtime購読が失敗し停止 |
| `<RUN_ID>` | 1 | 0 | Realtime再確認と旧27room/旧ユーザーデータの保持照合 |
| `<RUN_ID>` | 2 | 0 | Auth削除とメッセージ削除・履歴取得の追加競合 |
| HTTPモック/既存回帰 | 77 | 0 | 認証分類、タイムアウト、チャット、グループ、暇状態toggle |
| 合計 | 101 | 1 | 初回失敗を後続成功で消さない。層の異なる項目の合計 |

初回のRealtime試験は購読確立時にErrorとなり、送信・probe前に停止。channel状態/理由の詳細記録が不足しているため原因を確定しない。直近ログにはDatabaseIpVersionIsIpv4があったが、それを根本原因とは断定しない。

フォローアップではAuth setSession→Realtime setAuth→wait:trueで準備完了を待つ形に検証セットアップを揃え、購読状態を記録した。アーカイブ前の正の受信を確認し、最後の退出後、この試行の新しいarchived fixtureへ管理者DMLでメタデータprobeを挿入（通常APIを迂回する検証用データ、保持）。同じ接続のactive roomイベントは受信し、archived probeは非受信。接続/channelの健全性を確認し、一般JWTのイベントSELECTも空。通常チャットAPIは404。権限/RLS/publicationの緩和やRealtime再起動は行っていない。

Auth削除と複数room・同時2ユーザー削除、参加、送信、メッセージ削除、履歴取得は成功。ロックバリアを確認してから解放した。通常競合で観測したdeadlockは0。ただし有限回の試験。トリガーの意図したlock_timeoutではSQLSTATE 55P03、非対応分離レベルではP0001を受け、所属削除・アーカイブがともにrollbackされることを確認した。

型チェック・Lint・差分チェックを実施。別の隔離PostgreSQL/共有DBは使わず、古いfixtureやタイマー関数を専用環境へ適用しない。実タイマー更新/延長の統合はこの環境に定義がなく未実施であり、HTTPモック成功とは区別する。

最終`group_archive_postflight.sql`も成功。NOT NULL・defaultなし、直接関数実行禁止、2トリガー有効、元の27件すべてtrueを確認。元のベースDDL・グループmigration・チャットmigrationのSHA-256が適用時記録と一致することを確認した（`.runtime/archive-final-audit.json`）。

## 既存の不具合再現room

`<VERIFICATION_ID>`はtrueに分類したが、既にテストCが再参加した状態（メンバー1、未アーカイブ）を保持した。今回のmigrationは過去の空状態を推測して巻き戻さない。

修復案: 対象ID・既存検証ログの空状態/再参加証跡を再確認し、明示承認後、roomロック下でmvp_archived_atだけを設定して閉鎖する。所属・招待コード・履歴・イベントを削除せず、閉鎖後のAPI/RLS/Realtime認可を確認する。今回この修復は実施していない。

## 判定と残事項

新規の退出・Auth hard deleteで空になるMVP管理roomの不具合は修正を確認。非MVP保護、データ保持、権限境界も確認した。

ただし過去に再開された既存roomの修復は未実施、初回Realtime購読失敗は原因未確定。元の25秒タイムアウトも修正済みとはせず、従来の記録と20秒期限の実測を区別する。バックエンド全体を無条件に完成とは判定しない。共有環境への適用には別の分類manifest・事前監査・明示承認が必要。

今後の再実行は、新規テストデータを追加することを確認してから行う。適用スクリプトは初回適用専用であり、適用後の再実行は列存在チェックで停止する。失敗時の復旧や手動アーカイブは勝手に実行しない。
