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

**直近の全量ベンチマーク** · Bun 1.4.0 · 3 ラウンドの平均 · 2026-09-01T15:29:18Z · プロセス起動からローカル復元完了まで 486.9 ms · グループメッセージ 1 件を基本ディスパッチする 1.316 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.07 ms / 826 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.29 ms / 161 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| カーネル | linux 6.8.0-138-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-01T15:29:18Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 385,931,405 |
| プロセス読み込み | 120.56 MiB |
| プロセス書き込み | 173.64 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 193.11 MiB |
| 読み込みシステムコール | 40,326 |
| 書き込みシステムコール | 84,034 |
| モックルート使用量 | 15.22 MiB |
| モックルートファイル数 | 160 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 142.8 ms | ±8.1% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 21.83 ms | ±7.5% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 835.5 µs | ±27.2% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 2.10 ms | ±32.6% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 8.75 ms | ±14.4% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 1.00 ms | ±20.2% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 283.5 ms | ±5.8% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 808.0 µs | ±18.6% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 486.9 ms | ±1.7% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 104.48 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.316 µs | 761,970 回/s | 77.22 MiB | 24.89 KiB | ±5.2% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 174.4 ns | 5,771,532 回/s | 80.47 MiB | 23.59 KiB | ±7.9% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 11.3 ns | 90,413,278 回/s | 67.49 MiB | 21.93 KiB | ±13.6% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 26.8 ns | 37,484,018 回/s | 68.27 MiB | 22.67 KiB | ±6.6% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.7 ns | 1,383,127,554 回/s | 67.02 MiB | 23.61 KiB | ±16.5% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 51.4 ns | 19,444,534 回/s | 69.67 MiB | 24.23 KiB | ±1.5% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.5 ns | 225,706,574 回/s | 67.44 MiB | 24.25 KiB | ±10.7% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 12.8 ns | 78,017,774 回/s | 68.39 MiB | 22.60 KiB | ±1.7% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 49.7 ns | 20,249,650 回/s | 70.04 MiB | 20.25 KiB | ±8.2% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 12.72 µs | 79,104 回/s | 88.24 MiB | 26.58 KiB | ±8.0% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 109.0 ns | 9,195,460 回/s | 75.57 MiB | 20.04 KiB | ±4.5% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 33.1 ns | 30,255,318 回/s | 75.22 MiB | 22.94 KiB | ±4.0% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 57.6 ns | 17,587,306 回/s | 70.38 MiB | 19.92 KiB | ±11.4% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 497.4 ns | 2,014,913 回/s | 102.20 MiB | 5.63 MiB | ±4.6% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 467.5 ns | 2,144,163 回/s | 124.46 MiB | 20.24 KiB | ±5.0% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.8 ns | 209,304,869 回/s | 68.32 MiB | 20.83 KiB | ±3.1% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.597 µs | 178,921 回/s | 75.98 MiB | -2.11 MiB | ±3.7% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 111.2 ns | 9,040,634 回/s | 107.33 MiB | 23.62 KiB | ±7.3% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 729.3 ns | 1,372,099 回/s | 80.87 MiB | 23.59 KiB | ±2.5% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 55.23 µs | 18,107 回/s | 88.50 MiB | -2.12 MiB | ±0.3% |
| 返信参照を抽出する<br><code>reply-reference</code> | 31.3 ns | 34,084,764 回/s | 76.72 MiB | 23.98 KiB | ±27.4% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 104.5 ns | 9,566,962 回/s | 81.35 MiB | 22.22 KiB | ±1.5% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 10.7 ns | 127,783,599 回/s | 73.24 MiB | 22.77 KiB | ±61.4% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 32.9 ns | 30,638,815 回/s | 75.15 MiB | 20.51 KiB | ±8.3% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 31.6 ns | 31,680,826 回/s | 74.08 MiB | 22.92 KiB | ±2.9% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 11.2 ns | 88,958,153 回/s | 71.99 MiB | 20.03 KiB | ±0.5% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 75.9 ns | 13,198,279 回/s | 70.02 MiB | 21.73 KiB | ±4.6% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 446 回/s | 2.24 ms | 1.85 ms | 3.74 ms | 55.20 ms | 446 レコード/s | 3.91 MiB | ±4.3% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 79 回/s | 12.67 ms | 13.11 ms | 22.19 ms | 32.22 ms | 10,117 レコード/s | 20.53 MiB | ±3.9% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 343 回/s | 2.92 ms | 2.39 ms | 6.22 ms | 14.81 ms | 343 レコード/s | 3.15 MiB | ±6.3% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 343 回/s | 2.93 ms | 2.47 ms | 4.95 ms | 17.52 ms | 343 レコード/s | 3.13 MiB | ±7.0% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 310 回/s | 3.27 ms | 2.69 ms | 5.98 ms | 21.05 ms | 310 レコード/s | 3.13 MiB | ±11.6% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 213 回/s | 4.69 ms | 4.09 ms | 8.01 ms | 16.50 ms | 213 レコード/s | 7.03 MiB | ±4.3% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 406 回/s | 2.46 ms | 2.02 ms | 4.25 ms | 20.79 ms | 406 レコード/s | 4.16 MiB | ±3.0% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 161 回/s | 6.22 ms | 5.29 ms | 13.27 ms | 24.09 ms | 161 レコード/s | 1.83 MiB | ±4.7% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 826 回/s | 1.20 ms | 1.07 ms | 2.02 ms | 3.10 ms | 826 レコード/s | 0 B | ±1.3% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 23,937,633 回/s | 341.3 ns | 0 B | 9.53 KiB | ±14.2% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,521 回/s | 12.18 ms | 61.90 MiB | -1.69 MiB | ±2.9% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 41,881 回/s | 191.0 µs | 4.86 MiB | -1.70 MiB | ±0.6% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 12,438 回/s | 643.9 µs | 2.70 MiB | 273.76 KiB | ±3.4% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 9,665 回/s | 13.25 ms | 67.73 MiB | -1.56 MiB | ±2.3% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,700 回/s | 14.71 ms | 9.00 MiB | 199.84 KiB | ±0.9% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.8 ns | 59,802,821 回/s | 76.97 MiB | 22.91 KiB | ±6.8% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 44.4 ns | 22,981,852 回/s | 69.96 MiB | 23.25 KiB | ±13.8% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 18.6 ns | 54,084,831 回/s | 76.09 MiB | 26.05 KiB | ±7.7% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 158.9 ms | 1.81 MiB | 4.92 KiB | ±9.9% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 33.44 ms | 0 B | -4.95 KiB | ±4.4% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
