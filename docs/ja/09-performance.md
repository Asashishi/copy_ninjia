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

**直近の全量ベンチマーク** · Bun 1.4.0 · 3 ラウンドの平均 · 2026-08-29T12:06:41Z · プロセス起動からローカル復元完了まで 498.0 ms · グループメッセージ 1 件を基本ディスパッチする 1.333 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.07 ms / 857 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.56 ms / 150 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-08-29T12:06:41Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 376,131,005 |
| プロセス読み込み | 112.92 MiB |
| プロセス書き込み | 171.97 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 189.90 MiB |
| 読み込みシステムコール | 38,269 |
| 書き込みシステムコール | 82,202 |
| モックルート使用量 | 15.29 MiB |
| モックルートファイル数 | 162 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 134.2 ms | ±5.9% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 66.35 ms | ±65.9% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 952.9 µs | ±33.6% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.79 ms | ±19.8% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 3.72 ms | ±11.2% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 993.4 µs | ±12.1% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 260.5 ms | ±3.1% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 664.7 µs | ±12.1% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 498.0 ms | ±9.2% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 107.02 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.333 µs | 751,524 回/s | 77.58 MiB | 25.38 KiB | ±4.4% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 171.3 ns | 5,841,445 回/s | 79.21 MiB | 22.61 KiB | ±2.0% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 7.4 ns | 411,452,905 回/s | 68.07 MiB | 20.63 KiB | ±61.7% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 27.8 ns | 36,455,257 回/s | 68.03 MiB | 21.93 KiB | ±12.0% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.7 ns | 1,456,577,729 回/s | 67.35 MiB | 22.55 KiB | ±2.8% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.4 ns | 229,831,358 回/s | 67.38 MiB | 22.83 KiB | ±4.4% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 13.4 ns | 74,456,255 回/s | 68.61 MiB | 20.10 KiB | ±3.4% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 48.8 ns | 20,509,195 回/s | 70.01 MiB | 16.97 KiB | ±1.6% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 12.76 µs | 78,725 回/s | 87.95 MiB | 26.28 KiB | ±6.7% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 92.9 ns | 10,800,578 回/s | 73.65 MiB | 20.18 KiB | ±5.8% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 54.9 ns | 18,288,945 回/s | 70.47 MiB | 22.55 KiB | ±6.0% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 512.0 ns | 1,957,764 回/s | 106.87 MiB | 5.63 MiB | ±4.7% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 422.7 ns | 2,365,970 回/s | 125.58 MiB | 21.23 KiB | ±1.2% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 6.9 ns | 173,950,284 回/s | 68.18 MiB | 19.61 KiB | ±46.4% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.519 µs | 181,337 回/s | 75.86 MiB | -2.06 MiB | ±2.7% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 120.6 ns | 8,309,028 回/s | 107.74 MiB | 24.56 KiB | ±4.9% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 733.4 ns | 1,364,001 回/s | 80.98 MiB | 23.02 KiB | ±1.9% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 54.46 µs | 18,397 回/s | 89.37 MiB | -2.07 MiB | ±4.3% |
| 返信参照を抽出する<br><code>reply-reference</code> | 26.1 ns | 38,626,902 回/s | 79.09 MiB | 23.02 KiB | ±9.1% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 99.1 ns | 10,107,069 回/s | 82.46 MiB | 22.57 KiB | ±3.3% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.2 ns | 239,157,317 回/s | 71.70 MiB | 22.02 KiB | ±8.0% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 39.8 ns | 25,665,435 回/s | 74.75 MiB | 19.56 KiB | ±14.8% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 31.8 ns | 32,100,853 回/s | 73.90 MiB | 22.15 KiB | ±14.8% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 14.6 ns | 68,776,089 回/s | 72.02 MiB | 21.34 KiB | ±7.6% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 81.3 ns | 12,311,753 回/s | 69.51 MiB | 20.61 KiB | ±2.2% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 5 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 414 回/s | 2.42 ms | 1.96 ms | 4.13 ms | 24.35 ms | 414 レコード/s | 3.91 MiB | ±4.8% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 78 回/s | 12.87 ms | 13.04 ms | 22.51 ms | 34.10 ms | 9,949 レコード/s | 20.53 MiB | ±2.5% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 332 回/s | 3.01 ms | 2.50 ms | 5.00 ms | 18.65 ms | 332 レコード/s | 3.13 MiB | ±1.9% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 307 回/s | 3.26 ms | 2.60 ms | 6.03 ms | 36.46 ms | 307 レコード/s | 3.13 MiB | ±3.4% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 199 回/s | 5.03 ms | 4.22 ms | 10.26 ms | 23.35 ms | 199 レコード/s | 7.03 MiB | ±6.0% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 334 回/s | 3.16 ms | 2.29 ms | 7.12 ms | 34.57 ms | 334 レコード/s | 4.16 MiB | ±21.5% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 150 回/s | 6.67 ms | 5.56 ms | 13.82 ms | 28.82 ms | 150 レコード/s | 1.83 MiB | ±5.5% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 857 回/s | 1.15 ms | 1.07 ms | 1.90 ms | 2.11 ms | 857 レコード/s | 0 B | ±0.3% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 24,800,785 回/s | 326.6 ns | 0 B | 7.38 KiB | ±10.7% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,640 回/s | 12.04 ms | 61.91 MiB | -1.65 MiB | ±2.5% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 40,728 回/s | 196.5 µs | 4.84 MiB | -1.68 MiB | ±2.0% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,648 回/s | 589.1 µs | 2.68 MiB | 256.15 KiB | ±6.9% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 9,712 回/s | 13.20 ms | 67.71 MiB | -1.54 MiB | ±4.0% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,957 回/s | 14.30 ms | 8.98 MiB | 228.80 KiB | ±2.9% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 19.5 ns | 52,858,740 回/s | 76.22 MiB | 21.86 KiB | ±18.2% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 35.0 ns | 28,548,965 回/s | 70.09 MiB | 21.73 KiB | ±1.6% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 21.4 ns | 48,947,296 回/s | 76.38 MiB | 22.03 KiB | ±21.3% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 165.9 ms | 1.78 MiB | 4.84 KiB | ±2.0% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 28.23 ms | 0 B | -5.43 KiB | ±4.6% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](conntent-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
