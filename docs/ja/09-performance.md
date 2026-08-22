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

**直近の全量ベンチマーク** · Bun 1.4.0 · 3 ラウンドの平均 · 2026-08-22T14:39:18Z · プロセス起動からローカル復元完了まで 353.2 ms · グループメッセージ 1 件を基本ディスパッチする 2.167 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.13 ms / 785 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.41 ms / 157 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-08-22T14:39:18Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 369,130,605 |
| プロセス読み込み | 90.92 MiB |
| プロセス書き込み | 170.29 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 186.66 MiB |
| 読み込みシステムコール | 32,465 |
| 書き込みシステムコール | 80,529 |
| モックルート使用量 | 11.30 MiB |
| モックルートファイル数 | 149 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 136.2 ms | ±3.4% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 28.13 ms | ±43.9% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 768.8 µs | ±19.7% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.72 ms | ±12.2% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.20 ms | ±18.6% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 1.08 ms | ±18.3% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 157.2 ms | ±28.8% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 1.45 ms | ±77.8% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 353.2 ms | ±16.0% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 91.51 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 2.167 µs | 462,296 回/s | 83.17 MiB | 24.63 KiB | ±4.1% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 160.2 ns | 6,252,976 回/s | 79.05 MiB | 22.98 KiB | ±3.8% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 7.6 ns | 404,171,266 回/s | 67.13 MiB | 21.78 KiB | ±61.7% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 26.1 ns | 38,309,172 回/s | 67.78 MiB | 21.32 KiB | ±1.4% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.7 ns | 1,480,919,574 回/s | 66.44 MiB | 21.85 KiB | ±1.8% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.7 ns | 214,288,242 回/s | 67.09 MiB | 21.31 KiB | ±10.9% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 13.7 ns | 73,210,417 回/s | 67.46 MiB | 21.59 KiB | ±4.7% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 52.6 ns | 19,015,660 回/s | 69.75 MiB | 18.30 KiB | ±0.5% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 13.06 µs | 76,759 回/s | 88.25 MiB | 24.83 KiB | ±5.1% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 90.0 ns | 11,140,720 回/s | 72.71 MiB | 22.71 KiB | ±5.0% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 50.0 ns | 20,106,215 回/s | 69.79 MiB | 19.91 KiB | ±7.0% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 492.9 ns | 2,029,437 回/s | 110.05 MiB | 5.63 MiB | ±1.5% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 412.7 ns | 2,425,309 回/s | 120.96 MiB | 20.47 KiB | ±3.0% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 6.6 ns | 175,361,311 回/s | 67.44 MiB | 20.63 KiB | ±41.7% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 6.178 µs | 163,623 回/s | 74.72 MiB | -2.04 MiB | ±10.4% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 113.0 ns | 8,872,010 回/s | 105.79 MiB | 23.57 KiB | ±5.0% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 731.4 ns | 1,367,221 回/s | 82.21 MiB | 23.63 KiB | ±0.6% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 56.19 µs | 17,801 回/s | 87.14 MiB | -2.05 MiB | ±1.2% |
| 返信参照を抽出する<br><code>reply-reference</code> | 26.9 ns | 37,639,667 回/s | 77.81 MiB | 24.18 KiB | ±10.0% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 109.2 ns | 9,189,245 回/s | 79.82 MiB | 22.89 KiB | ±5.8% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 9.3 ns | 166,314,117 回/s | 72.29 MiB | 22.56 KiB | ±71.9% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 37.2 ns | 27,155,746 回/s | 74.10 MiB | 19.25 KiB | ±10.0% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 28.4 ns | 35,185,317 回/s | 73.29 MiB | 22.84 KiB | ±3.1% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 12.4 ns | 81,619,808 回/s | 70.81 MiB | 21.59 KiB | ±11.9% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 77.4 ns | 12,956,192 回/s | 69.35 MiB | 21.43 KiB | ±4.8% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 5 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 315 回/s | 4.46 ms | 4.48 ms | 9.22 ms | 61.86 ms | 315 レコード/s | 3.91 MiB | ±44.5% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 76 回/s | 13.25 ms | 12.89 ms | 24.56 ms | 40.83 ms | 9,707 レコード/s | 20.53 MiB | ±7.1% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 322 回/s | 3.10 ms | 2.54 ms | 5.28 ms | 19.73 ms | 322 レコード/s | 3.13 MiB | ±4.2% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 34 回/s | 29.70 ms | 32.95 ms | 54.43 ms | 72.73 ms | 34 レコード/s | 7.03 MiB | ±1.7% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 391 回/s | 2.56 ms | 2.08 ms | 4.68 ms | 34.40 ms | 391 レコード/s | 4.16 MiB | ±4.2% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 157 回/s | 6.37 ms | 5.41 ms | 13.91 ms | 23.16 ms | 157 レコード/s | 1.83 MiB | ±5.1% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 785 回/s | 1.26 ms | 1.13 ms | 1.99 ms | 2.84 ms | 785 レコード/s | 0 B | ±5.0% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 24,492,161 回/s | 328.9 ns | 0 B | 8.54 KiB | ±8.4% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,977 回/s | 11.68 ms | 61.90 MiB | -1.62 MiB | ±3.5% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 42,359 回/s | 189.0 µs | 4.83 MiB | -1.64 MiB | ±2.6% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,378 回/s | 600.2 µs | 2.67 MiB | 257.12 KiB | ±6.2% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 10,206 回/s | 12.54 ms | 67.68 MiB | -1.51 MiB | ±1.6% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,598 回/s | 14.92 ms | 8.95 MiB | 225.04 KiB | ±4.5% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：スライディングウィンドウは `LinkedQueue` + `trimSlidingWindow`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 時刻スライディングウィンドウの追加と期限切れ削除<br><code>linked-timestamp-window</code> | 54.0 ns | 18,528,761 回/s | 102.40 MiB | 23.21 KiB | ±1.0% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 27.7 ns | 37,584,778 回/s | 74.02 MiB | 25.82 KiB | ±21.0% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 188.2 ms | 2.17 MiB | 4.88 KiB | ±6.6% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 33.02 ms | 0 B | -4.88 KiB | ±7.6% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](conntent-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
