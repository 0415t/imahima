# グループMVPの非破壊復旧準備

実行・適用はしていない。これらはマイグレーションではない。

## 使用ファイル

1. `supabase/tests/group_mvp_recovery_capture.sql`：適用前にSQL Editorで実行する
   読み取り専用SQL。関数本体・所有者・EXECUTE、テーブル／列GRANT・grantor・
   grant option、RLSフラグ、既存ポリシー・制約・インデックスを採取する。
   GRANT・RLS復元文は文字列として返すだけで、実行しない。
2. `supabase/tests/group_mvp_recovery_template.sql`：採取結果を埋める手動復旧用。
   未記入で実行しても冒頭で例外停止し、末尾もROLLBACK。元定義の採取と別途の
   復旧承認を得た後、レビュー済みコピーだけを完成させる。
3. `supabase/tests/group_mvp_recovery_dependencies.sql`：新規追加物のカタログ依存と
   関数本文の参照を読み取り確認する。外部コード・動的SQLまで完全に網羅しない。

## 確認済み情報と不足

監査で既存3ロールのSELECT/INSERT/UPDATE/DELETE、AuthへのFK、期限切れジョブ等は
確認されている。ただし、元generate_room_keyの正確な全文・所有者・ACLと全GRANTの
grantor／grant option、元RLSフラグ・ポリシー全文は、この作業に渡された情報だけでは
完全復元できない。6文字の生成方法を推測して復元SQLを作ったり、GRANT ALLで代替
しない。適用後の現行定義を採取して「元定義」とすることも禁止する。

採取結果はSQL Editorの単一結果セット全11行を確認し、プロジェクトID・実行ロール・採取日時・
対象マイグレーションのハッシュとともに、Git外の保護された場所へ保存する。
SQLファイルを保存しただけでは実DBの復旧情報を保存したことにならない。
採取前にすでにマイグレーション適用済みなら、既存の適用前記録を入手するまで停止。
既存room値の不変性を確認するためのID・名前・キー・所属の記録も、別途安全に保存する。
これらをGitやチャットに貼らない。今回、実データを取得・保存する処理は実行しない。

## データを残す復旧方針

- COMMIT前に失敗しただけなら、そのトランザクションのROLLBACK状態を確認する。
  復旧テンプレートを自動実行しない。接続断時はコミット成否を先に読み取り確認する。
- COMMIT後はグループAPIへの流入を止め、差分をレビューして関数・権限・RLSだけを
  元に戻す。元の一般ロール権限を戻すと、新規roomまで旧ポリシーで見える可能性がある。
- 既存ポリシー・既存制約は対象マイグレーションが変更しないので再作成しない。
- rows、room_key、membership、profiles、Auth、タイマー、Push Tokenは更新・削除しない。
- 新RPC、レート制限表、逆引きインデックス、作成者／アーカイブ列は原則保持する。
  これは「完全なスキーマダウングレード」ではなく、互換性復旧・安全な縮退である。
- 新列はgroup_mvp_executeの読み書き対象で、作成者列にはAuthへのFKが付く。
  逆引きインデックスは既存だった可能性もあるため、採取時点での有無が必要。
  レート表はconsume_rateから、rooms/room_membersと新列はexecuteから参照される。
  生成関数はrooms.room_keyの既定値とexecuteから利用される。
- 将来のチャット、ビュー、トリガー、外部呼出しが増えた場合は再監査する。
  削除が別途必要なら、利用停止→依存調査→データ保全→個別レビューの順とする。
  DROP CASCADE、自動DROP COLUMN、自動DELETEは提供しない。
- 所有者を変更する際は実行者の権限を確認する。異なるgrantorの権限チェーンは、単に
  同じGRANT文を実行しても由来まで復元できない。REVOKEはRESTRICTで停止させ、
  権限不整合をCASCADEで解消しない。

元の正確な採取結果でテンプレートを完成させるまでは、実行可能な完全復旧SQLが
用意できたとは扱わない。今回、実DBで採取・復旧・マイグレーション適用は行わない。

## 単一CSVのエクスポートと参照

1. 対象プロジェクトのSQL Editorで `group_mvp_recovery_capture.sql` 全文を1回実行する。
2. 結果が `section` と `data` の2列、11行になっていることを確認する。エラーや
   行数制限がある状態では保存完了としない。
3. 結果グリッドのExport／DownloadからCSV形式で全結果を保存する。画面のセル表示が
   省略されていても、表示テキストをコピーせずCSVを使う。UIのボタン名は環境で異なる。
4. Git外の保護された場所に保存する。Excelなどで開いて上書きすると長いセルの切捨てや
   改行・引用符の変換が起き得るため、元CSVをそのまま保管する。
5. 各 `data` はJSONB配列。0件は `[]`、未設定項目はJSONの `null`。関数本体の改行や
   引用符はJSON／CSVでエスケープされ、CSVパーサ→JSONパーサの順で元の文字列に戻る。
   手作業でカンマ分割や引用符置換をしない。SQL側にLIMIT、文字列切出しはない。

セクションは capture_context、generator_definition、generator_execute_grants、
table_security、table_grants、column_grants、policies、constraints、indexes、
new_objects、new_columns。空セクションも1行として出力するため「採取漏れ」と区別できる。

PowerShellでのローカル参照例（DBには接続せず、復旧SQLも実行しない）：

```powershell
$captureRows = Import-Csv -LiteralPath '<Git外のCSVパス>' -Encoding UTF8
if ($captureRows.Count -ne 11) { throw 'セクション数を確認してください' }
$captureBySection = @{}
foreach ($captureRow in $captureRows) {
    if ($captureBySection.ContainsKey($captureRow.section)) { throw 'セクションが重複しています' }
    $captureBySection[$captureRow.section] = @($captureRow.data | ConvertFrom-Json)
}
$originalGenerator = $captureBySection['generator_definition'][0].original_definition
# $originalGeneratorをレビュー用に参照する。Invoke-Expression等で実行しない。
```

CSVの取得後は全11セクションのJSONパース成功、元関数の全文、期待する表・制約・
ポリシーの件数を確認する。SQL側で切り詰めなくても、SQL Editorの転送上限や保存ツール
による欠落まで自動保証するものではない。実際のCSVを確認してから復旧情報採取済みとする。
