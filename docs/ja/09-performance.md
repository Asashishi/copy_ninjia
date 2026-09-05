# 09 パフォーマンスベンチマーク

<p align="center">
  <a href="../cn/09-performance.md">简体中文</a> · <a href="../en/09-performance.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="08-commands.md">← 前のページ：08 コマンドと挙動リファレンス</a> · <b>次のページ：なし →</b>
</p>

---

本ページの計測値は `bun run perf:full -- --write-doc` が生成し、リリースごとに再実行して一括で上書きします。
下の 2 つのマーカーに挟まれた内容は手で編集せず、3 言語のうち 1 つだけを更新することもしないでください。

同じ実行は**構造化レポート全文**を、repository root の版管理された `performance-result.json` の
`fullSuite.lastRun` にも書き込みます。本ページは人間向けの表示、その JSON は同じ計測値の機械可読な
記録です（環境、セクション、項目ごとの平均と変動係数まで全て）。両者は同一の switch が書き出すため、
片方だけが古くなることはありません。

ベンチマークはリリース時と明示的な指示があったときにのみ実行し、`bun run check` には含めません。
ホットパスの GC/RSS/JIT ハードゲートは `bun run perf:hot-path-gate` が担当します。
[05 開発フローと品質ゲート](05-dev-workflow.md) を参照してください。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.4.1 · 3 ラウンドの平均 · 2026-09-05T06:46:26Z · プロセス起動からローカル復元完了まで 486.4 ms · グループメッセージ 1 件を基本ディスパッチする 1.260 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.03 ms / 844 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.56 ms / 140 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.1 (`4661e494f052c83c80dade1318e5710238340be6`) |
| カーネル | linux 6.8.0-138-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-05T06:46:26Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 385,931,405 |
| プロセス読み込み | 121.13 MiB |
| プロセス書き込み | 178.31 MiB |
| ブロックデバイス読み込み | 1.33 KiB |
| ブロックデバイス書き込み | 197.80 MiB |
| 読み込みシステムコール | 40,280 |
| 書き込みシステムコール | 84,067 |
| モックルート使用量 | 16.58 MiB |
| モックルートファイル数 | 161 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 154.3 ms | ±17.6% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 20.08 ms | ±6.9% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 677.9 µs | ±2.1% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.54 ms | ±4.5% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 7.71 ms | ±14.5% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 965.5 µs | ±10.7% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 279.7 ms | ±1.8% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 727.9 µs | ±16.8% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 486.4 ms | ±7.0% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 108.33 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.260 µs | 794,393 回/s | 74.67 MiB | 24.70 KiB | ±2.4% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 185.6 ns | 5,429,534 回/s | 77.87 MiB | 23.26 KiB | ±9.0% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 11.1 ns | 90,169,256 回/s | 66.28 MiB | 21.69 KiB | ±4.0% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 24.3 ns | 41,335,417 回/s | 66.05 MiB | 22.60 KiB | ±6.8% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.7 ns | 1,357,729,548 回/s | 65.45 MiB | 22.07 KiB | ±11.1% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 60.6 ns | 16,569,641 回/s | 67.86 MiB | 23.88 KiB | ±6.5% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.1 ns | 242,859,778 回/s | 65.32 MiB | 21.74 KiB | ±3.5% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 13.3 ns | 75,250,886 回/s | 66.57 MiB | 23.62 KiB | ±1.9% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 49.1 ns | 20,428,947 回/s | 68.24 MiB | 19.49 KiB | ±4.6% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 12.91 µs | 77,580 回/s | 85.94 MiB | 26.71 KiB | ±3.9% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 108.8 ns | 9,209,352 回/s | 74.52 MiB | 21.74 KiB | ±4.0% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 40.8 ns | 26,752,103 回/s | 72.95 MiB | 22.94 KiB | ±32.1% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 62.3 ns | 16,295,393 回/s | 68.73 MiB | 21.83 KiB | ±12.3% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 453.6 ns | 2,262,881 回/s | 102.07 MiB | 5.63 MiB | ±15.3% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 449.9 ns | 2,223,497 回/s | 124.33 MiB | 19.36 KiB | ±2.1% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.6 ns | 219,081,833 回/s | 67.03 MiB | 21.45 KiB | ±0.6% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.268 µs | 189,987 回/s | 74.47 MiB | 23.76 KiB | ±2.9% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 131.7 ns | 7,655,928 回/s | 104.53 MiB | 24.27 KiB | ±9.0% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 338.9 ns | 2,950,963 回/s | 91.20 MiB | 26.30 KiB | ±1.5% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 55.62 µs | 17,983 回/s | 86.53 MiB | 21.93 KiB | ±1.7% |
| 返信参照を抽出する<br><code>reply-reference</code> | 24.5 ns | 40,849,823 回/s | 75.53 MiB | 23.07 KiB | ±2.0% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 74.0 ns | 13,553,325 回/s | 76.95 MiB | 21.90 KiB | ±4.7% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.4 ns | 229,576,133 回/s | 71.59 MiB | 20.49 KiB | ±6.6% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 36.5 ns | 27,797,167 回/s | 73.12 MiB | 20.90 KiB | ±11.8% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 29.1 ns | 34,456,703 回/s | 66.33 MiB | 22.36 KiB | ±3.8% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 12.3 ns | 81,098,688 回/s | 69.18 MiB | 20.18 KiB | ±1.0% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 76.8 ns | 13,042,050 回/s | 67.52 MiB | 21.31 KiB | ±4.2% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 338 回/s | 2.95 ms | 2.03 ms | 9.44 ms | 34.41 ms | 338 レコード/s | 3.91 MiB | ±1.5% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 72 回/s | 13.91 ms | 14.03 ms | 24.18 ms | 57.96 ms | 9,218 レコード/s | 20.53 MiB | ±4.5% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 260 回/s | 4.02 ms | 2.65 ms | 10.49 ms | 44.49 ms | 260 レコード/s | 3.15 MiB | ±21.3% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 248 回/s | 4.03 ms | 2.80 ms | 12.16 ms | 42.74 ms | 248 レコード/s | 3.13 MiB | ±0.9% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 285 回/s | 3.50 ms | 2.61 ms | 9.06 ms | 30.15 ms | 285 レコード/s | 3.13 MiB | ±3.5% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 194 回/s | 5.17 ms | 4.27 ms | 11.59 ms | 18.64 ms | 194 レコード/s | 11.72 MiB | ±6.1% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 362 回/s | 2.76 ms | 2.07 ms | 6.30 ms | 26.42 ms | 362 レコード/s | 4.16 MiB | ±0.6% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 140 回/s | 7.17 ms | 5.56 ms | 16.08 ms | 31.44 ms | 140 レコード/s | 1.83 MiB | ±3.9% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 844 回/s | 1.18 ms | 1.03 ms | 1.95 ms | 3.33 ms | 844 レコード/s | 0 B | ±4.5% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 23,847,525 回/s | 348.0 ns | 0 B | 7.77 KiB | ±17.8% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,381 回/s | 12.33 ms | 61.90 MiB | 8.58 KiB | ±0.5% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 41,658 回/s | 192.1 µs | 4.86 MiB | 58.44 KiB | ±1.2% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 12,510 回/s | 640.1 µs | 2.70 MiB | 278.17 KiB | ±3.1% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 9,750 回/s | 13.14 ms | 67.73 MiB | 151.30 KiB | ±2.7% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,805 回/s | 14.59 ms | 9.00 MiB | 190.64 KiB | ±6.1% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 15.9 ns | 63,130,363 回/s | 74.40 MiB | 23.97 KiB | ±5.9% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 37.1 ns | 26,950,922 回/s | 67.67 MiB | 23.22 KiB | ±2.1% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 17.9 ns | 56,115,704 回/s | 73.26 MiB | 24.66 KiB | ±7.0% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 169.5 ms | 1.96 MiB | 4.96 KiB | ±3.8% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 29.67 ms | 0 B | -4.94 KiB | ±1.9% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
