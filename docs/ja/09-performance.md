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

**直近の全量ベンチマーク** · Bun 1.4.0 · 3 ラウンドの平均 · 2026-08-27T16:54:00Z · プロセス起動からローカル復元完了まで 482.4 ms · グループメッセージ 1 件を基本ディスパッチする 1.307 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.01 ms / 878 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.56 ms / 148 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-08-27T16:54:00Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 376,131,005 |
| プロセス読み込み | 112.41 MiB |
| プロセス書き込み | 171.96 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 189.88 MiB |
| 読み込みシステムコール | 37,981 |
| 書き込みシステムコール | 82,284 |
| モックルート使用量 | 20.21 MiB |
| モックルートファイル数 | 162 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 172.4 ms | ±6.9% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 20.99 ms | ±2.8% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 1.32 ms | ±46.6% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.74 ms | ±8.0% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 5.01 ms | ±5.5% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 909.3 µs | ±17.7% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 253.7 ms | ±3.5% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 749.8 µs | ±15.4% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 482.4 ms | ±1.0% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 108.04 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.307 µs | 766,189 回/s | 78.39 MiB | 24.38 KiB | ±3.8% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 160.0 ns | 6,276,329 回/s | 80.82 MiB | 23.45 KiB | ±6.7% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 11.1 ns | 91,475,146 回/s | 67.77 MiB | 21.34 KiB | ±13.1% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 29.1 ns | 34,911,477 回/s | 68.42 MiB | 23.20 KiB | ±12.9% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,259,395,449 回/s | 67.34 MiB | 20.48 KiB | ±31.2% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.1 ns | 243,227,320 回/s | 67.60 MiB | 21.87 KiB | ±2.2% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 14.5 ns | 70,151,924 回/s | 68.39 MiB | 21.43 KiB | ±12.9% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 53.4 ns | 19,021,207 回/s | 70.33 MiB | 17.62 KiB | ±12.8% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 12.83 µs | 78,082 回/s | 88.70 MiB | 26.55 KiB | ±4.4% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 87.4 ns | 11,474,149 回/s | 75.41 MiB | 20.39 KiB | ±5.5% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 51.9 ns | 19,264,637 回/s | 70.30 MiB | 19.09 KiB | ±2.8% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 508.4 ns | 1,995,299 回/s | 106.49 MiB | 5.63 MiB | ±11.9% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 464.4 ns | 2,163,727 回/s | 123.97 MiB | 19.51 KiB | ±7.0% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.4 ns | 229,788,732 回/s | 69.35 MiB | 21.30 KiB | ±3.0% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.407 µs | 185,057 回/s | 76.62 MiB | -2.04 MiB | ±2.6% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 151.1 ns | 6,704,254 回/s | 108.96 MiB | 23.94 KiB | ±11.8% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 692.8 ns | 1,444,185 回/s | 80.27 MiB | 23.85 KiB | ±2.2% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 54.04 µs | 18,508 回/s | 87.85 MiB | -2.05 MiB | ±1.3% |
| 返信参照を抽出する<br><code>reply-reference</code> | 28.7 ns | 35,711,855 回/s | 80.39 MiB | 22.96 KiB | ±16.3% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 110.1 ns | 9,135,570 回/s | 85.44 MiB | 21.42 KiB | ±7.8% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 13.9 ns | 119,853,152 回/s | 74.00 MiB | 22.65 KiB | ±50.7% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 33.7 ns | 29,879,352 回/s | 75.46 MiB | 19.07 KiB | ±8.6% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 31.1 ns | 32,224,109 回/s | 74.55 MiB | 22.80 KiB | ±5.0% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 12.7 ns | 79,430,019 回/s | 71.66 MiB | 21.37 KiB | ±8.4% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 77.9 ns | 12,859,516 回/s | 69.24 MiB | 20.20 KiB | ±4.0% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 5 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 438 回/s | 2.28 ms | 1.93 ms | 3.91 ms | 17.26 ms | 438 レコード/s | 3.91 MiB | ±0.7% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 77 回/s | 12.96 ms | 13.26 ms | 21.94 ms | 35.62 ms | 9,885 レコード/s | 20.53 MiB | ±3.2% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 336 回/s | 2.97 ms | 2.49 ms | 5.21 ms | 19.22 ms | 336 レコード/s | 3.13 MiB | ±2.3% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 321 回/s | 3.11 ms | 2.58 ms | 6.35 ms | 13.85 ms | 321 レコード/s | 3.13 MiB | ±0.4% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 178 回/s | 5.61 ms | 4.43 ms | 13.93 ms | 25.60 ms | 178 レコード/s | 7.03 MiB | ±2.9% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 407 回/s | 2.46 ms | 2.04 ms | 4.26 ms | 19.38 ms | 407 レコード/s | 4.16 MiB | ±1.7% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 148 回/s | 6.76 ms | 5.56 ms | 15.25 ms | 24.57 ms | 148 レコード/s | 1.83 MiB | ±0.9% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 878 回/s | 1.13 ms | 1.01 ms | 1.80 ms | 2.85 ms | 878 レコード/s | 0 B | ±2.6% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 24,540,468 回/s | 330.2 ns | 0 B | 4.48 KiB | ±11.0% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,580 回/s | 12.11 ms | 61.90 MiB | -1.65 MiB | ±3.0% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 41,755 回/s | 191.6 µs | 4.84 MiB | -1.68 MiB | ±1.0% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,789 回/s | 581.0 µs | 2.68 MiB | 257.51 KiB | ±3.8% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 9,849 回/s | 13.02 ms | 67.71 MiB | -1.54 MiB | ±4.7% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,945 回/s | 14.32 ms | 8.98 MiB | 229.64 KiB | ±2.8% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 21.4 ns | 48,682,441 回/s | 75.57 MiB | 22.96 KiB | ±19.6% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 38.5 ns | 26,061,759 回/s | 70.46 MiB | 22.94 KiB | ±5.6% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 19.0 ns | 52,950,511 回/s | 76.22 MiB | 24.52 KiB | ±7.4% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 160.4 ms | 3.26 MiB | 4.92 KiB | ±3.3% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 31.49 ms | 0 B | -5.39 KiB | ±11.8% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](conntent-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
