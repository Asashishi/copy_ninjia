# 09 パフォーマンスベンチマーク

<p align="center">
  <a href="../cn/09-performance.md">简体中文</a> · <a href="../en/09-performance.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="conntent-table.md">📚 ドキュメントホーム</a> · <a href="08-commands.md">← 前のページ：08 コマンドと挙動リファレンス</a> · <b>次のページ：なし →</b>
</p>

---

本ページの計測値は `bun run perf:full -- --write-doc` が生成し、リリースごとに再実行して一括で上書きします。
下の 2 つのマーカーに挟まれた内容は手で編集せず、3 言語のうち 1 つだけを更新することもしないでください。

ベンチマークはリリース時と明示的な指示があったときにのみ実行し、`bun run check` には含めません。
ホットパスの GC/RSS/JIT ハードゲートは `bun run perf:hot-path-gate` が担当します。
[05 開発フローと品質ゲート](05-dev-workflow.md) を参照してください。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.3.14 · 3 ラウンドの平均 · 2026-08-20T15:31:50Z · プロセス起動からローカル復元完了まで 376.3 ms · グループメッセージ 1 件を基本ディスパッチする 1.901 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.35 ms / 640 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 6.55 ms / 129 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-08-20T15:31:50Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 369,130,605 |
| プロセス読み込み | 89.13 MiB |
| プロセス書き込み | 170.30 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 186.63 MiB |
| 読み込みシステムコール | 35,050 |
| 書き込みシステムコール | 80,533 |
| モックルート使用量 | 22.07 MiB |
| モックルートファイル数 | 152 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 136.3 ms | ±5.4% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 50.25 ms | ±60.3% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 962.0 µs | ±3.2% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.97 ms | ±6.1% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.83 ms | ±5.1% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 497.6 µs | ±4.0% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 139.2 ms | ±1.1% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 791.7 µs | ±24.1% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 376.3 ms | ±7.0% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 110.25 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.901 µs | 526,529 回/s | 115.28 MiB | 27.17 KiB | ±3.0% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 127.0 ns | 7,896,694 回/s | 114.50 MiB | 22.54 KiB | ±5.1% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 12.1 ns | 82,505,033 回/s | 79.79 MiB | 20.21 KiB | ±2.6% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 28.4 ns | 35,320,305 回/s | 80.71 MiB | 20.17 KiB | ±4.5% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.7 ns | 1,467,711,548 回/s | 78.28 MiB | 21.90 KiB | ±1.9% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.1 ns | 242,386,719 回/s | 79.58 MiB | 20.79 KiB | ±4.0% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 15.5 ns | 64,644,089 回/s | 80.79 MiB | 20.18 KiB | ±2.3% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 54.0 ns | 18,517,749 回/s | 82.83 MiB | 18.48 KiB | ±1.2% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 10.35 µs | 96,660 回/s | 156.42 MiB | 24.61 KiB | ±1.6% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 95.4 ns | 10,503,117 回/s | 89.89 MiB | 17.20 KiB | ±4.1% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 60.1 ns | 16,821,325 回/s | 83.74 MiB | 17.05 KiB | ±10.2% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 544.3 ns | 1,842,806 回/s | 137.71 MiB | 5.78 MiB | ±5.6% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 499.8 ns | 2,002,639 回/s | 145.72 MiB | 19.80 KiB | ±3.0% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 6.2 ns | 189,749,829 回/s | 80.13 MiB | 18.40 KiB | ±43.3% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.526 µs | 181,025 回/s | 145.95 MiB | -1.87 MiB | ±1.8% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 197.3 ns | 5,101,735 回/s | 147.69 MiB | 23.29 KiB | ±7.9% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 729.7 ns | 1,372,996 回/s | 121.70 MiB | 23.09 KiB | ±4.3% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 60.53 µs | 16,523 回/s | 121.63 MiB | -1.87 MiB | ±1.5% |
| 返信参照を抽出する<br><code>reply-reference</code> | 26.7 ns | 38,677,652 回/s | 109.54 MiB | 22.41 KiB | ±19.1% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 113.9 ns | 8,819,218 回/s | 124.26 MiB | 22.61 KiB | ±6.2% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.5 ns | 229,724,537 回/s | 86.63 MiB | 21.21 KiB | ±16.1% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 35.8 ns | 28,010,807 回/s | 107.94 MiB | 22.31 KiB | ±4.0% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 36.3 ns | 27,623,974 回/s | 106.41 MiB | 20.91 KiB | ±4.3% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 13.2 ns | 76,052,966 回/s | 83.17 MiB | 19.24 KiB | ±2.1% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 84.6 ns | 11,828,044 回/s | 81.71 MiB | 21.22 KiB | ±2.3% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 5 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 400 回/s | 2.50 ms | 1.98 ms | 4.65 ms | 27.44 ms | 400 レコード/s | 3.91 MiB | ±3.2% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 61 回/s | 16.31 ms | 17.02 ms | 27.96 ms | 35.30 ms | 7,848 レコード/s | 20.53 MiB | ±1.8% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 308 回/s | 3.28 ms | 2.62 ms | 5.77 ms | 21.56 ms | 308 レコード/s | 3.13 MiB | ±9.6% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 197 回/s | 5.09 ms | 4.46 ms | 10.20 ms | 16.58 ms | 197 レコード/s | 7.03 MiB | ±3.1% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 390 回/s | 2.57 ms | 2.05 ms | 4.38 ms | 23.13 ms | 390 レコード/s | 4.16 MiB | ±3.0% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 129 回/s | 7.80 ms | 6.55 ms | 16.67 ms | 30.56 ms | 129 レコード/s | 1.83 MiB | ±7.9% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 640 回/s | 1.55 ms | 1.35 ms | 3.14 ms | 3.99 ms | 640 レコード/s | 0 B | ±3.0% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 24,287,521 回/s | 329.4 ns | 0 B | 4.90 KiB | ±0.6% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 8,403 回/s | 15.23 ms | 61.91 MiB | -1.46 MiB | ±1.4% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 28,573 回/s | 280.4 µs | 4.83 MiB | -1.52 MiB | ±4.0% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 11,225 回/s | 712.9 µs | 2.67 MiB | 268.72 KiB | ±1.6% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 7,198 回/s | 17.79 ms | 67.68 MiB | -1.40 MiB | ±2.4% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 6,539 回/s | 19.69 ms | 8.91 MiB | 241.29 KiB | ±7.4% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：スライディングウィンドウは `LinkedQueue` + `trimSlidingWindow`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 時刻スライディングウィンドウの追加と期限切れ削除<br><code>linked-timestamp-window</code> | 41.1 ns | 26,276,317 回/s | 153.88 MiB | 22.89 KiB | ±30.0% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 29.4 ns | 34,014,629 回/s | 108.24 MiB | 25.56 KiB | ±2.0% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 172.1 ms | 1.39 MiB | 3.39 KiB | ±6.5% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 40.09 ms | 0 B | -5.60 KiB | ±4.7% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](conntent-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
