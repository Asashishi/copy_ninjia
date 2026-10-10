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

**直近の全量ベンチマーク** · Bun 1.4.3 · 3 ラウンドの平均 · 2026-10-10T17:53:33Z · プロセス起動からローカル復元完了まで 355.6 ms · グループメッセージ 1 件を基本ディスパッチする 153.9 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 194.1 µs / 4,294 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.84 ms / 499 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.3 (`c6da4a4d3010e5553438c60f6bd76d981976867c`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-10-10T17:53:33Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,453 |
| プロセス読み込み | 182.43 MiB |
| プロセス書き込み | 185.43 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 234.66 MiB |
| 読み込みシステムコール | 53,048 |
| 書き込みシステムコール | 243,743 |
| モックルート使用量 | 14.49 MiB |
| モックルートファイル数 | 103 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 102.7 ms | ±1.9% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 11.07 ms | ±2.6% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 632.2 µs | ±6.3% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.18 ms | ±3.6% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.60 ms | ±2.6% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 700.6 µs | ±8.1% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 221.4 ms | ±1.0% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 271.3 µs | ±15.8% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 355.6 ms | ±1.2% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 113.49 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 153.9 ns | 6,502,451 回/s | 88.02 MiB | 18.44 KiB | ±3.1% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 93.9 ns | 10,663,979 回/s | 90.32 MiB | 20.06 KiB | ±3.2% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 14.2 ns | 70,339,124 回/s | 77.84 MiB | 25.33 KiB | ±4.3% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 27.0 ns | 37,038,019 回/s | 77.49 MiB | 24.41 KiB | ±1.3% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 32.0 ns | 31,222,698 回/s | 79.48 MiB | 24.71 KiB | ±1.4% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,165,558,130 回/s | 76.09 MiB | 23.70 KiB | ±3.0% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 46.4 ns | 21,592,746 回/s | 78.49 MiB | 23.61 KiB | ±3.8% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 3.7 ns | 268,592,322 回/s | 76.73 MiB | 24.55 KiB | ±1.8% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 10.2 ns | 98,317,479 回/s | 77.28 MiB | 23.61 KiB | ±2.2% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 40.5 ns | 24,674,949 回/s | 79.23 MiB | 24.47 KiB | ±0.7% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.097 µs | 912,742 回/s | 99.22 MiB | 20.36 KiB | ±3.5% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 89.1 ns | 11,233,364 回/s | 85.59 MiB | 25.92 KiB | ±2.8% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 38.8 ns | 25,807,588 回/s | 85.86 MiB | 24.06 KiB | ±1.1% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 50.0 ns | 20,015,039 回/s | 80.10 MiB | 25.27 KiB | ±0.4% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 261.6 ns | 3,828,101 回/s | 123.32 MiB | 5.64 MiB | ±3.8% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 302.5 ns | 3,315,351 回/s | 133.45 MiB | 20.99 KiB | ±5.3% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.3 ns | 230,572,391 回/s | 77.53 MiB | 23.72 KiB | ±1.6% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.153 µs | 464,577 回/s | 85.55 MiB | 22.30 KiB | ±1.3% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 33.3 ns | 30,052,374 回/s | 86.36 MiB | 21.74 KiB | ±2.1% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 291.7 ns | 3,431,936 回/s | 85.88 MiB | 21.68 KiB | ±3.1% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 38.24 µs | 26,152 回/s | 96.19 MiB | 22.27 KiB | ±0.5% |
| 返信参照を抽出する<br><code>reply-reference</code> | 28.6 ns | 35,033,170 回/s | 87.82 MiB | 22.51 KiB | ±4.9% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 51.6 ns | 19,391,035 回/s | 96.60 MiB | 23.76 KiB | ±1.5% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 6.0 ns | 199,854,037 回/s | 77.13 MiB | 24.76 KiB | ±47.3% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 35.6 ns | 28,140,414 回/s | 84.62 MiB | 23.61 KiB | ±2.6% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 20.2 ns | 49,601,238 回/s | 77.27 MiB | 23.89 KiB | ±1.9% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 14.8 ns | 67,478,691 回/s | 76.73 MiB | 24.97 KiB | ±0.5% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 78.5 ns | 12,747,008 回/s | 76.36 MiB | 24.48 KiB | ±1.0% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 824 回/s | 1.21 ms | 1.11 ms | 1.71 ms | 9.36 ms | 824 レコード/s | 3.91 MiB | ±4.6% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 324 回/s | 3.09 ms | 2.94 ms | 5.90 ms | 12.85 ms | 41,449 レコード/s | 21.42 MiB | ±1.5% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 784 回/s | 1.28 ms | 1.19 ms | 1.70 ms | 5.78 ms | 784 レコード/s | 3.15 MiB | ±4.9% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 663 回/s | 1.52 ms | 1.32 ms | 2.52 ms | 7.43 ms | 663 レコード/s | 3.13 MiB | ±7.4% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 703 回/s | 1.42 ms | 1.33 ms | 1.88 ms | 8.06 ms | 703 レコード/s | 3.13 MiB | ±1.1% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 355 回/s | 2.82 ms | 2.53 ms | 4.56 ms | 11.87 ms | 355 レコード/s | 5.55 MiB | ±3.1% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 877 回/s | 1.14 ms | 1.07 ms | 1.56 ms | 5.81 ms | 877 レコード/s | 4.16 MiB | ±0.8% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 499 回/s | 2.01 ms | 1.84 ms | 2.88 ms | 6.71 ms | 499 レコード/s | 1.20 MiB | ±1.9% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,294 回/s | 230.8 µs | 194.1 µs | 393.5 µs | 632.8 µs | 4,294 レコード/s | 0 B | ±3.5% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 219.8 ms | 219.2 ms | 225.8 ms | 228.9 ms | 5 レコード/s | 0 B | ±3.4% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 7 回/s | 136.2 ms | 135.4 ms | 141.6 ms | 144.0 ms | 7 レコード/s | 7.31 MiB | ±1.1% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 30,339,431 回/s | 263.7 ns | 0 B | 12.09 KiB | ±1.5% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 44,298 回/s | 2.89 ms | 56.55 MiB | 22.08 KiB | ±1.2% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 72,586 回/s | 110.2 µs | 5.29 MiB | 88.85 KiB | ±0.2% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,016 回/s | 615.0 µs | 34.01 MiB | 243.00 KiB | ±2.4% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 61,263 回/s | 2.09 ms | 73.14 MiB | 140.78 KiB | ±1.5% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 18,730 回/s | 6.84 ms | 12.63 MiB | 426.00 KiB | ±3.7% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 15.3 ns | 65,542,086 回/s | 81.51 MiB | 21.51 KiB | ±1.1% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 37.9 ns | 26,364,996 回/s | 80.41 MiB | 25.62 KiB | ±0.2% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 17.2 ns | 58,514,402 回/s | 85.81 MiB | 27.35 KiB | ±6.4% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 123.7 ms | 2.02 MiB | 6.55 KiB | ±2.4% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 17.08 ms | 0 B | -4.74 KiB | ±3.7% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：09 コマンドと挙動リファレンス](09-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#10-パフォーマンスベンチマーク) · [次のページ：11 よくある質問 →](11-faq.md)

</div>
