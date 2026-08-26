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

同じ実行は**構造化レポート全文**を、repository root の版管理された `performance-result.json` の
`fullSuite.lastRun` にも書き込みます。本ページは人間向けの表示、その JSON は同じ計測値の機械可読な
記録です（環境、セクション、項目ごとの平均と変動係数まで全て）。両者は同一の switch が書き出すため、
片方だけが古くなることはありません。

ベンチマークはリリース時と明示的な指示があったときにのみ実行し、`bun run check` には含めません。
ホットパスの GC/RSS/JIT ハードゲートは `bun run perf:hot-path-gate` が担当します。
[05 開発フローと品質ゲート](05-dev-workflow.md) を参照してください。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.4.0 · 3 ラウンドの平均 · 2026-08-26T16:47:51Z · プロセス起動からローカル復元完了まで 480.7 ms · グループメッセージ 1 件を基本ディスパッチする 2.172 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.02 ms / 911 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 11.33 ms / 87 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-08-26T16:47:51Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 376,131,005 |
| プロセス読み込み | 115.86 MiB |
| プロセス書き込み | 171.96 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 189.88 MiB |
| 読み込みシステムコール | 38,968 |
| 書き込みシステムコール | 82,267 |
| モックルート使用量 | 17.70 MiB |
| モックルートファイル数 | 162 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 147.9 ms | ±14.7% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 24.42 ms | ±18.9% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 818.1 µs | ±14.7% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.82 ms | ±16.8% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.32 ms | ±13.1% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 1.02 ms | ±20.9% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 270.0 ms | ±4.7% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 2.11 ms | ±94.2% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 480.7 ms | ±1.9% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 105.61 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 2.172 µs | 461,076 回/s | 82.57 MiB | 20.98 KiB | ±3.9% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 153.6 ns | 6,530,347 回/s | 79.04 MiB | 23.21 KiB | ±5.4% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 10.4 ns | 96,077,894 回/s | 66.86 MiB | 20.97 KiB | ±0.6% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 28.1 ns | 36,214,657 回/s | 67.07 MiB | 22.71 KiB | ±13.4% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.7 ns | 1,497,459,119 回/s | 66.05 MiB | 21.54 KiB | ±4.9% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.2 ns | 238,065,467 回/s | 67.00 MiB | 22.92 KiB | ±3.4% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 13.4 ns | 74,876,913 回/s | 67.46 MiB | 20.51 KiB | ±5.0% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 53.6 ns | 19,020,079 回/s | 69.32 MiB | 19.01 KiB | ±14.4% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 12.55 µs | 79,664 回/s | 87.05 MiB | 25.00 KiB | ±0.6% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 93.1 ns | 10,749,959 回/s | 72.72 MiB | 20.92 KiB | ±2.9% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 52.8 ns | 19,063,814 回/s | 69.60 MiB | 21.02 KiB | ±7.7% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 442.9 ns | 2,267,762 回/s | 104.28 MiB | 5.63 MiB | ±6.5% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 499.5 ns | 2,003,994 回/s | 125.57 MiB | 21.20 KiB | ±3.3% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 7.1 ns | 159,442,909 回/s | 67.49 MiB | 20.28 KiB | ±34.8% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.543 µs | 180,470 回/s | 74.94 MiB | -2.06 MiB | ±1.9% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 117.1 ns | 8,626,892 回/s | 105.68 MiB | 23.52 KiB | ±10.1% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 702.0 ns | 1,424,567 回/s | 80.14 MiB | 22.95 KiB | ±0.9% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 54.97 µs | 18,193 回/s | 87.36 MiB | -2.07 MiB | ±0.6% |
| 返信参照を抽出する<br><code>reply-reference</code> | 25.6 ns | 39,075,781 回/s | 78.80 MiB | 23.72 KiB | ±3.1% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 114.9 ns | 8,956,562 回/s | 81.81 MiB | 21.55 KiB | ±17.9% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 9.4 ns | 167,451,206 回/s | 71.78 MiB | 22.05 KiB | ±73.0% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 36.6 ns | 28,023,940 回/s | 74.27 MiB | 21.64 KiB | ±16.3% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 32.9 ns | 30,854,476 回/s | 73.21 MiB | 19.91 KiB | ±12.2% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 12.3 ns | 81,548,976 回/s | 69.10 MiB | 20.27 KiB | ±3.3% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 81.8 ns | 12,345,587 回/s | 68.89 MiB | 20.99 KiB | ±10.4% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 5 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 395 回/s | 2.57 ms | 1.96 ms | 4.95 ms | 78.45 ms | 395 レコード/s | 3.91 MiB | ±12.9% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 77 回/s | 12.97 ms | 13.38 ms | 21.89 ms | 41.71 ms | 9,869 レコード/s | 20.53 MiB | ±1.2% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 312 回/s | 3.24 ms | 2.55 ms | 7.14 ms | 26.98 ms | 312 レコード/s | 3.13 MiB | ±11.0% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 319 回/s | 3.18 ms | 2.55 ms | 6.82 ms | 20.94 ms | 319 レコード/s | 3.13 MiB | ±12.2% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 194 回/s | 5.15 ms | 4.31 ms | 9.60 ms | 27.33 ms | 194 レコード/s | 7.03 MiB | ±2.9% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 363 回/s | 2.78 ms | 2.08 ms | 6.62 ms | 33.47 ms | 363 レコード/s | 4.16 MiB | ±10.9% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 87 回/s | 11.63 ms | 11.33 ms | 25.05 ms | 45.52 ms | 87 レコード/s | 1.83 MiB | ±11.5% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 911 回/s | 1.09 ms | 1.02 ms | 1.85 ms | 2.37 ms | 911 レコード/s | 0 B | ±6.0% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 26,411,869 回/s | 303.3 ns | 0 B | 6.40 KiB | ±3.6% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,616 回/s | 12.06 ms | 61.90 MiB | -1.65 MiB | ±1.3% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 40,930 回/s | 195.6 µs | 4.84 MiB | -1.68 MiB | ±2.3% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,327 回/s | 600.8 µs | 2.68 MiB | 256.85 KiB | ±3.0% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 9,980 回/s | 12.83 ms | 67.71 MiB | -1.54 MiB | ±1.5% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,636 回/s | 14.82 ms | 8.98 MiB | 229.28 KiB | ±1.2% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：上限付きスライディングウィンドウは `TimestampDeque`、上限なしの荒らし対策 join ウィンドウは `LinkedQueue` + `trimSlidingWindow`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 15.7 ns | 64,155,745 回/s | 76.05 MiB | 23.27 KiB | ±7.0% |
| 上限なし時刻スライディングウィンドウの追加と期限切れ削除<br><code>linked-timestamp-window</code> | 56.0 ns | 17,849,651 回/s | 102.23 MiB | 22.64 KiB | ±1.7% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 17.4 ns | 57,643,626 回/s | 75.15 MiB | 24.99 KiB | ±2.0% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 157.5 ms | 2.57 MiB | 4.88 KiB | ±3.1% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 29.58 ms | 0 B | -5.39 KiB | ±2.6% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](conntent-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
