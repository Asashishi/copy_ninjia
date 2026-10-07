# 10 パフォーマンスベンチマーク

<p align="center">
  <a href="../cn/10-performance.md">简体中文</a> · <a href="../en/10-performance.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="09-commands.md">← 前のページ：09 コマンドと挙動リファレンス</a> · <a href="11-faq.md">次のページ：11 よくある質問 →</a>
</p>

---

本ページの計測値は `bun run perf:full -- --write-doc` によって自動生成され、リリースごとに一括更新されます。
**下の 2 つのマーカーに挟まれた内容は手動で編集しないでください**。リリーススクリプトによって 3 言語のドキュメントが同一バッチで同期されます。

ベンチマークを実行すると、**構造化レポート全文**（実行環境、テストセクション、各項目の平均時間と変動係数）がリポジトリルートの `performance-result.json` 内 `fullSuite.lastRun` に書き込まれます。本ページのテーブルと JSON レポートは、単一の `--write-doc` スイッチによってアトミックに出力されます。

全量ベンチマークスイートはリリース時および明示的な指示があった場合のみ実行され、日常的な `bun run check` 門禁には含まれません。本番ホットパスの GC/RSS/JIT ハードゲートは `bun run perf:hot-path-gate` が独立して担当します（詳細は [05 開発フローと品質ゲート](05-dev-workflow.md) を参照）。

個別シナリオおよび `bun run perf:disk-transport` の実行手順・測定境界については、[05 開発フロー](05-dev-workflow.md#個別シナリオと伝送ストレス検証) を参照してください。個別検証の出力とホットパス門禁の結果は個別に記録され、以下の全量ベンチマーク生成ブロックを上書きすることはありません。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-10-07T10:56:42Z · プロセス起動からローカル復元完了まで 389.5 ms · グループメッセージ 1 件を基本ディスパッチする 137.5 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 205.6 µs / 4,309 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.93 ms / 475 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-10-07T10:56:42Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,453 |
| プロセス読み込み | 180.03 MiB |
| プロセス書き込み | 185.44 MiB |
| ブロックデバイス読み込み | 2.67 KiB |
| ブロックデバイス書き込み | 234.66 MiB |
| 読み込みシステムコール | 51,981 |
| 書き込みシステムコール | 244,036 |
| モックルート使用量 | 14.49 MiB |
| モックルートファイル数 | 103 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 114.0 ms | ±0.4% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 11.44 ms | ±2.6% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 673.2 µs | ±5.2% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.27 ms | ±5.8% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.89 ms | ±4.3% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 783.5 µs | ±2.6% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 241.1 ms | ±3.4% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 279.2 µs | ±1.8% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 389.5 ms | ±2.0% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 122.58 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 137.5 ns | 7,297,025 回/s | 100.45 MiB | 10.98 KiB | ±5.5% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 99.8 ns | 10,082,399 回/s | 103.93 MiB | 19.88 KiB | ±7.5% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 16.0 ns | 62,663,881 回/s | 90.24 MiB | 21.15 KiB | ±1.7% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 29.2 ns | 34,226,269 回/s | 90.85 MiB | 20.17 KiB | ±1.7% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 33.9 ns | 29,535,874 回/s | 91.65 MiB | 20.43 KiB | ±0.6% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,167,516,588 回/s | 88.23 MiB | 21.21 KiB | ±1.3% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 47.0 ns | 21,285,673 回/s | 91.83 MiB | 18.44 KiB | ±0.7% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.1 ns | 242,041,617 回/s | 89.97 MiB | 21.42 KiB | ±1.0% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 9.8 ns | 101,603,331 回/s | 88.90 MiB | 19.56 KiB | ±0.8% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 43.7 ns | 22,881,871 回/s | 89.38 MiB | 20.02 KiB | ±0.3% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.116 µs | 897,169 回/s | 111.29 MiB | 18.15 KiB | ±3.9% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 92.1 ns | 10,859,485 回/s | 96.22 MiB | 22.68 KiB | ±1.9% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 42.4 ns | 23,597,982 回/s | 97.48 MiB | 19.92 KiB | ±2.6% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 51.8 ns | 19,383,512 回/s | 90.30 MiB | 20.76 KiB | ±6.8% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 260.5 ns | 3,839,666 回/s | 128.78 MiB | 5.63 MiB | ±0.8% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 309.0 ns | 3,239,355 回/s | 147.84 MiB | 19.93 KiB | ±3.2% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.3 ns | 232,027,183 回/s | 89.48 MiB | 20.10 KiB | ±2.1% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.214 µs | 451,724 回/s | 98.63 MiB | 21.98 KiB | ±0.4% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 32.8 ns | 30,515,808 回/s | 98.05 MiB | 15.22 KiB | ±2.6% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 281.4 ns | 3,554,846 回/s | 102.93 MiB | 21.21 KiB | ±1.8% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 38.82 µs | 25,771 回/s | 111.38 MiB | 21.56 KiB | ±1.9% |
| 返信参照を抽出する<br><code>reply-reference</code> | 29.9 ns | 33,468,340 回/s | 100.48 MiB | 21.97 KiB | ±2.2% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 49.0 ns | 20,495,086 回/s | 108.90 MiB | 20.86 KiB | ±5.9% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 7.9 ns | 151,984,549 回/s | 88.50 MiB | 21.80 KiB | ±35.5% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 38.1 ns | 26,324,898 回/s | 96.79 MiB | 17.63 KiB | ±4.1% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 21.7 ns | 46,081,431 回/s | 88.77 MiB | 20.07 KiB | ±3.1% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 16.4 ns | 60,899,545 回/s | 91.55 MiB | 21.19 KiB | ±3.8% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 73.5 ns | 13,634,417 回/s | 91.73 MiB | 20.05 KiB | ±5.0% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 892 回/s | 1.12 ms | 1.00 ms | 1.58 ms | 9.21 ms | 892 レコード/s | 3.91 MiB | ±2.3% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 317 回/s | 3.15 ms | 3.00 ms | 5.65 ms | 12.99 ms | 40,607 レコード/s | 21.42 MiB | ±3.3% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 773 回/s | 1.30 ms | 1.19 ms | 1.85 ms | 7.75 ms | 773 レコード/s | 3.15 MiB | ±9.4% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 730 回/s | 1.37 ms | 1.25 ms | 1.93 ms | 7.52 ms | 730 レコード/s | 3.13 MiB | ±4.4% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 740 回/s | 1.35 ms | 1.26 ms | 1.80 ms | 8.48 ms | 740 レコード/s | 3.13 MiB | ±3.0% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 354 回/s | 2.82 ms | 2.57 ms | 4.37 ms | 12.59 ms | 354 レコード/s | 5.55 MiB | ±4.1% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 850 回/s | 1.18 ms | 1.08 ms | 1.50 ms | 13.87 ms | 850 レコード/s | 4.16 MiB | ±3.9% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 475 回/s | 2.11 ms | 1.93 ms | 3.18 ms | 6.82 ms | 475 レコード/s | 1.20 MiB | ±3.5% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,309 回/s | 229.6 µs | 205.6 µs | 359.4 µs | 541.3 µs | 4,309 レコード/s | 0 B | ±3.1% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 193.4 ms | 193.2 ms | 196.5 ms | 197.1 ms | 5 レコード/s | 0 B | ±0.7% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 7 回/s | 139.7 ms | 139.6 ms | 144.9 ms | 149.7 ms | 7 レコード/s | 7.31 MiB | ±0.7% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 29,605,673 回/s | 270.5 ns | 0 B | 5.51 KiB | ±3.1% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 44,506 回/s | 2.88 ms | 56.55 MiB | 31.41 KiB | ±0.7% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 74,958 回/s | 106.7 µs | 5.29 MiB | 78.65 KiB | ±1.3% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,348 回/s | 599.5 µs | 34.01 MiB | 281.68 KiB | ±1.4% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 63,789 回/s | 2.01 ms | 73.14 MiB | 132.89 KiB | ±1.4% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 20,558 回/s | 6.23 ms | 12.63 MiB | 417.38 KiB | ±2.9% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 17.1 ns | 58,692,807 回/s | 100.86 MiB | 21.54 KiB | ±5.9% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.3 ns | 27,533,476 回/s | 90.94 MiB | 22.61 KiB | ±1.2% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 17.8 ns | 56,647,878 回/s | 98.19 MiB | 23.77 KiB | ±8.2% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 121.6 ms | 1.42 MiB | 6.39 KiB | ±0.4% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 20.68 ms | 0 B | -3.56 KiB | ±8.0% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：09 コマンドと挙動リファレンス](09-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#10-パフォーマンスベンチマーク) · [次のページ：11 よくある質問 →](11-faq.md)

</div>
