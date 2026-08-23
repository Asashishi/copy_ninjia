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

**直近の全量ベンチマーク** · Bun 1.4.0 · 3 ラウンドの平均 · 2026-08-23T16:09:38Z · プロセス起動からローカル復元完了まで 345.3 ms · グループメッセージ 1 件を基本ディスパッチする 2.125 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.12 ms / 780 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.62 ms / 144 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-08-23T16:09:38Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 369,130,605 |
| プロセス読み込み | 91.10 MiB |
| プロセス書き込み | 170.33 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 186.71 MiB |
| 読み込みシステムコール | 32,553 |
| 書き込みシステムコール | 80,649 |
| モックルート使用量 | 11.37 MiB |
| モックルートファイル数 | 146 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 131.8 ms | ±2.1% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 31.34 ms | ±47.5% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 772.2 µs | ±17.7% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.72 ms | ±20.0% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.02 ms | ±10.3% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 862.7 µs | ±10.8% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 146.9 ms | ±11.8% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 720.7 µs | ±15.8% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 345.3 ms | ±5.1% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 92.42 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 2.125 µs | 471,119 回/s | 82.52 MiB | 24.46 KiB | ±3.1% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 166.5 ns | 6,011,697 回/s | 78.16 MiB | 23.10 KiB | ±2.7% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 11.0 ns | 91,340,639 回/s | 67.09 MiB | 21.90 KiB | ±6.3% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 26.2 ns | 38,217,476 回/s | 66.82 MiB | 22.38 KiB | ±5.4% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.8 ns | 1,316,472,830 回/s | 66.10 MiB | 22.73 KiB | ±9.0% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.3 ns | 230,580,656 回/s | 66.17 MiB | 22.81 KiB | ±3.8% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 13.4 ns | 74,843,257 回/s | 67.18 MiB | 22.06 KiB | ±2.9% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 53.2 ns | 18,804,280 回/s | 69.09 MiB | 17.81 KiB | ±1.6% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 12.70 µs | 78,781 回/s | 86.83 MiB | 26.18 KiB | ±2.5% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 91.3 ns | 10,986,864 回/s | 72.10 MiB | 22.78 KiB | ±5.8% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 53.1 ns | 19,002,578 回/s | 69.22 MiB | 20.93 KiB | ±9.7% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 488.0 ns | 2,049,711 回/s | 109.06 MiB | 5.63 MiB | ±1.4% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 424.6 ns | 2,357,835 回/s | 121.73 MiB | 19.19 KiB | ±3.4% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 8.8 ns | 136,773,940 回/s | 67.28 MiB | 20.54 KiB | ±35.9% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.489 µs | 182,260 回/s | 75.00 MiB | -2.05 MiB | ±1.8% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 133.6 ns | 7,776,757 回/s | 106.17 MiB | 24.07 KiB | ±18.4% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 717.5 ns | 1,395,471 回/s | 82.49 MiB | 23.13 KiB | ±3.5% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 53.63 µs | 18,650 回/s | 86.86 MiB | -2.06 MiB | ±1.4% |
| 返信参照を抽出する<br><code>reply-reference</code> | 26.4 ns | 38,228,560 回/s | 77.12 MiB | 23.42 KiB | ±9.1% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 110.3 ns | 9,115,181 回/s | 83.57 MiB | 22.86 KiB | ±7.5% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.0 ns | 247,850,740 回/s | 71.83 MiB | 21.61 KiB | ±3.5% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 39.1 ns | 25,915,920 回/s | 73.57 MiB | 20.68 KiB | ±10.6% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 31.3 ns | 32,074,978 回/s | 72.82 MiB | 20.53 KiB | ±7.3% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 12.0 ns | 83,348,012 回/s | 69.09 MiB | 21.55 KiB | ±5.0% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 76.2 ns | 13,138,367 回/s | 68.58 MiB | 21.62 KiB | ±4.2% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 5 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 405 回/s | 2.47 ms | 1.98 ms | 4.47 ms | 69.99 ms | 405 レコード/s | 3.91 MiB | ±5.6% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 77 回/s | 12.96 ms | 13.09 ms | 22.47 ms | 31.07 ms | 9,879 レコード/s | 20.53 MiB | ±2.7% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 318 回/s | 3.14 ms | 2.60 ms | 5.63 ms | 19.18 ms | 318 レコード/s | 3.13 MiB | ±3.0% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 99 回/s | 14.76 ms | 12.88 ms | 43.16 ms | 67.98 ms | 99 レコード/s | 7.03 MiB | ±53.0% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 378 回/s | 2.66 ms | 2.15 ms | 4.85 ms | 22.22 ms | 378 レコード/s | 4.16 MiB | ±6.2% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 144 回/s | 6.95 ms | 5.62 ms | 15.41 ms | 26.52 ms | 144 レコード/s | 1.83 MiB | ±2.2% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 780 回/s | 1.27 ms | 1.12 ms | 1.94 ms | 3.15 ms | 780 レコード/s | 0 B | ±1.5% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 26,683,046 回/s | 300.1 ns | 0 B | 9.74 KiB | ±2.8% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,593 回/s | 12.09 ms | 61.90 MiB | -1.62 MiB | ±2.1% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 41,072 回/s | 194.8 µs | 4.84 MiB | -1.65 MiB | ±1.9% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 12,915 回/s | 622.5 µs | 2.68 MiB | 238.40 KiB | ±6.9% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 10,170 回/s | 12.59 ms | 67.69 MiB | -1.51 MiB | ±1.5% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,257 回/s | 15.54 ms | 8.96 MiB | 239.77 KiB | ±5.1% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：スライディングウィンドウは `LinkedQueue` + `trimSlidingWindow`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 時刻スライディングウィンドウの追加と期限切れ削除<br><code>linked-timestamp-window</code> | 53.1 ns | 18,847,548 回/s | 102.56 MiB | 23.81 KiB | ±2.3% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 24.0 ns | 41,627,871 回/s | 74.72 MiB | 23.99 KiB | ±3.2% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 160.5 ms | 2.34 MiB | 4.34 KiB | ±6.0% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 29.08 ms | 0 B | -5.39 KiB | ±6.5% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](conntent-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
