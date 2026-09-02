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

**直近の全量ベンチマーク** · Bun 1.4.0 · 3 ラウンドの平均 · 2026-09-02T09:38:14Z · プロセス起動からローカル復元完了まで 508.9 ms · グループメッセージ 1 件を基本ディスパッチする 1.345 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 980.2 µs / 887 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.75 ms / 136 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| カーネル | linux 6.8.0-138-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-02T09:38:14Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 385,931,405 |
| プロセス読み込み | 120.57 MiB |
| プロセス書き込み | 173.64 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 193.11 MiB |
| 読み込みシステムコール | 40,364 |
| 書き込みシステムコール | 84,168 |
| モックルート使用量 | 14.87 MiB |
| モックルートファイル数 | 161 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 153.8 ms | ±5.7% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 27.17 ms | ±15.6% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 788.9 µs | ±13.5% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.92 ms | ±3.6% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 7.93 ms | ±12.2% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 1.06 ms | ±14.2% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 289.8 ms | ±4.8% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 1.63 ms | ±90.8% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 508.9 ms | ±1.9% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 102.24 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.345 µs | 747,362 回/s | 78.46 MiB | 25.57 KiB | ±7.5% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 158.1 ns | 6,336,844 回/s | 81.55 MiB | 22.67 KiB | ±4.3% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 11.0 ns | 91,298,264 回/s | 67.62 MiB | 22.94 KiB | ±8.6% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 26.6 ns | 37,628,501 回/s | 68.21 MiB | 23.40 KiB | ±2.4% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.7 ns | 1,489,083,933 回/s | 67.21 MiB | 22.35 KiB | ±6.4% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 61.6 ns | 16,443,119 回/s | 70.20 MiB | 22.93 KiB | ±11.3% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.9 ns | 207,890,048 回/s | 67.60 MiB | 21.55 KiB | ±11.1% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 14.0 ns | 72,054,960 回/s | 68.59 MiB | 21.68 KiB | ±8.6% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 51.4 ns | 19,486,323 回/s | 69.97 MiB | 20.85 KiB | ±4.6% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 13.19 µs | 76,275 回/s | 88.25 MiB | 25.74 KiB | ±8.0% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 117.7 ns | 8,523,681 回/s | 75.22 MiB | 19.29 KiB | ±5.7% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 32.8 ns | 30,524,252 回/s | 75.60 MiB | 23.05 KiB | ±2.7% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 52.3 ns | 19,352,178 回/s | 70.37 MiB | 23.30 KiB | ±10.8% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 527.7 ns | 1,898,835 回/s | 105.36 MiB | 5.63 MiB | ±4.4% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 486.9 ns | 2,054,979 回/s | 120.29 MiB | 20.91 KiB | ±2.3% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.6 ns | 216,429,958 回/s | 68.81 MiB | 21.14 KiB | ±3.9% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.530 µs | 180,830 回/s | 76.87 MiB | -2.11 MiB | ±0.2% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 114.2 ns | 8,781,952 回/s | 107.05 MiB | 24.10 KiB | ±5.7% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 722.1 ns | 1,384,938 回/s | 85.96 MiB | 24.12 KiB | ±1.0% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 59.84 µs | 16,736 回/s | 88.30 MiB | -2.12 MiB | ±3.9% |
| 返信参照を抽出する<br><code>reply-reference</code> | 28.8 ns | 34,834,988 回/s | 79.69 MiB | 23.45 KiB | ±5.2% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 112.6 ns | 8,907,462 回/s | 83.40 MiB | 24.32 KiB | ±5.4% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 10.1 ns | 157,148,909 回/s | 73.05 MiB | 23.86 KiB | ±74.5% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 40.4 ns | 24,752,939 回/s | 74.75 MiB | 21.57 KiB | ±1.7% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 32.9 ns | 30,772,628 回/s | 73.88 MiB | 23.39 KiB | ±10.9% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 11.6 ns | 86,446,572 回/s | 71.46 MiB | 21.28 KiB | ±2.9% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 84.8 ns | 11,882,595 回/s | 70.36 MiB | 22.63 KiB | ±8.9% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 392 回/s | 2.55 ms | 1.92 ms | 6.45 ms | 21.15 ms | 392 レコード/s | 3.91 MiB | ±3.6% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 70 回/s | 14.26 ms | 14.34 ms | 24.64 ms | 45.09 ms | 8,972 レコード/s | 20.53 MiB | ±1.3% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 309 回/s | 3.23 ms | 2.51 ms | 7.21 ms | 29.78 ms | 309 レコード/s | 3.15 MiB | ±4.6% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 301 回/s | 3.32 ms | 2.50 ms | 9.49 ms | 28.95 ms | 301 レコード/s | 3.13 MiB | ±3.3% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 311 回/s | 3.21 ms | 2.58 ms | 7.52 ms | 19.91 ms | 311 レコード/s | 3.13 MiB | ±2.8% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 190 回/s | 5.26 ms | 4.35 ms | 11.67 ms | 19.19 ms | 190 レコード/s | 7.03 MiB | ±4.3% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 343 回/s | 3.05 ms | 2.15 ms | 7.06 ms | 26.25 ms | 343 レコード/s | 4.16 MiB | ±20.1% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 136 回/s | 7.37 ms | 5.75 ms | 16.60 ms | 27.56 ms | 136 レコード/s | 1.83 MiB | ±3.3% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 887 回/s | 1.12 ms | 980.2 µs | 1.65 ms | 3.54 ms | 887 レコード/s | 0 B | ±5.4% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 25,159,471 回/s | 319.6 ns | 0 B | 8.55 KiB | ±7.2% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 9,929 回/s | 12.91 ms | 61.90 MiB | -1.69 MiB | ±4.0% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 41,183 回/s | 194.3 µs | 4.86 MiB | -1.70 MiB | ±1.1% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 12,826 回/s | 624.8 µs | 2.70 MiB | 273.37 KiB | ±4.0% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 8,995 回/s | 14.26 ms | 67.73 MiB | -1.56 MiB | ±4.8% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,147 回/s | 15.74 ms | 9.00 MiB | 199.79 KiB | ±3.9% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 21.0 ns | 48,175,017 回/s | 76.56 MiB | 23.69 KiB | ±11.4% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 35.9 ns | 27,863,312 回/s | 70.35 MiB | 23.27 KiB | ±2.5% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 20.7 ns | 49,012,384 回/s | 75.70 MiB | 26.08 KiB | ±12.5% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 174.1 ms | 1.76 MiB | 4.99 KiB | ±10.1% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 35.33 ms | 0 B | -6.38 KiB | ±2.5% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
