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

個別 scenario と `bun run perf:disk-transport` の実行方法・測定境界は [05 開発フロー](05-dev-workflow.md#個別シナリオと伝送ストレス検証) を参照してください。個別出力と hot-path gate は個別に記録し、以下の全量基準の生成 block を置き換えません。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-16T07:05:02Z · プロセス起動からローカル復元完了まで 348.1 ms · グループメッセージ 1 件を基本ディスパッチする 136.1 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 836.6 µs / 1,113 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 2.98 ms / 308 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-16T07:05:02Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,405 |
| プロセス読み込み | 164.14 MiB |
| プロセス書き込み | 173.94 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 193.70 MiB |
| 読み込みシステムコール | 51,592 |
| 書き込みシステムコール | 86,157 |
| モックルート使用量 | 14.20 MiB |
| モックルートファイル数 | 113 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 102.5 ms | ±4.0% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 12.85 ms | ±8.2% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 651.2 µs | ±12.1% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.61 ms | ±16.6% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 5.35 ms | ±11.5% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 818.8 µs | ±20.3% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 210.6 ms | ±7.9% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 958.9 µs | ±80.0% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 348.1 ms | ±4.2% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 110.22 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 136.1 ns | 7,377,270 回/s | 86.34 MiB | 12.25 KiB | ±6.5% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 93.1 ns | 10,754,256 回/s | 90.54 MiB | 21.26 KiB | ±3.2% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 15.9 ns | 62,851,717 回/s | 75.20 MiB | 22.94 KiB | ±1.5% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 29.9 ns | 33,555,129 回/s | 75.41 MiB | 22.41 KiB | ±4.8% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 34.7 ns | 28,813,527 回/s | 76.89 MiB | 22.52 KiB | ±0.8% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,154,513,921 回/s | 74.19 MiB | 22.51 KiB | ±3.0% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 56.6 ns | 18,003,407 回/s | 76.68 MiB | 22.36 KiB | ±13.9% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.0 ns | 248,621,825 回/s | 74.71 MiB | 22.25 KiB | ±4.1% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 12.4 ns | 80,554,742 回/s | 75.33 MiB | 20.83 KiB | ±5.2% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 58.0 ns | 19,246,185 回/s | 76.49 MiB | 21.41 KiB | ±36.1% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 13.91 µs | 72,693 回/s | 98.77 MiB | 22.86 KiB | ±10.4% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 95.8 ns | 10,438,233 回/s | 82.29 MiB | 22.82 KiB | ±2.0% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 30.5 ns | 33,274,934 回/s | 83.68 MiB | 23.57 KiB | ±12.2% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 57.4 ns | 17,878,018 回/s | 76.89 MiB | 23.49 KiB | ±16.7% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 290.9 ns | 3,524,439 回/s | 120.90 MiB | 5.63 MiB | ±16.3% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 328.2 ns | 3,047,269 回/s | 136.51 MiB | 22.72 KiB | ±0.9% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.5 ns | 220,502,684 回/s | 75.80 MiB | 21.46 KiB | ±2.1% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 4.564 µs | 219,178 回/s | 85.33 MiB | 24.85 KiB | ±1.7% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 100.1 ns | 9,993,557 回/s | 119.97 MiB | 25.67 KiB | ±0.8% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 260.3 ns | 3,842,041 回/s | 95.92 MiB | 27.08 KiB | ±1.1% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 38.96 µs | 25,678 回/s | 97.32 MiB | 23.79 KiB | ±2.2% |
| 返信参照を抽出する<br><code>reply-reference</code> | 18.9 ns | 52,987,901 回/s | 86.52 MiB | 24.80 KiB | ±2.7% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 54.3 ns | 18,413,524 回/s | 88.28 MiB | 22.17 KiB | ±0.7% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.3 ns | 231,909,301 回/s | 81.49 MiB | 22.45 KiB | ±1.8% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 39.1 ns | 25,611,121 回/s | 83.55 MiB | 20.73 KiB | ±4.9% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 22.8 ns | 44,037,578 回/s | 74.94 MiB | 22.57 KiB | ±7.1% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 16.3 ns | 61,476,817 回/s | 77.54 MiB | 23.37 KiB | ±6.1% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 78.5 ns | 12,784,168 回/s | 76.00 MiB | 22.17 KiB | ±5.7% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 760 回/s | 1.34 ms | 1.03 ms | 2.42 ms | 20.79 ms | 760 レコード/s | 3.91 MiB | ±14.4% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 134 回/s | 7.48 ms | 8.46 ms | 12.20 ms | 22.14 ms | 17,120 レコード/s | 21.42 MiB | ±1.1% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 672 回/s | 1.49 ms | 1.39 ms | 1.89 ms | 10.21 ms | 672 レコード/s | 3.15 MiB | ±1.9% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 546 回/s | 1.85 ms | 1.52 ms | 3.51 ms | 13.20 ms | 546 レコード/s | 3.13 MiB | ±11.6% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 547 回/s | 1.85 ms | 1.51 ms | 3.46 ms | 18.64 ms | 547 レコード/s | 3.13 MiB | ±12.5% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 346 回/s | 2.89 ms | 2.63 ms | 4.47 ms | 11.51 ms | 346 レコード/s | 5.55 MiB | ±1.9% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 808 回/s | 1.24 ms | 1.10 ms | 1.62 ms | 13.37 ms | 808 レコード/s | 4.16 MiB | ±2.2% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 308 回/s | 3.25 ms | 2.98 ms | 4.82 ms | 9.73 ms | 308 レコード/s | 1.83 MiB | ±0.9% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 1,113 回/s | 890.7 µs | 836.6 µs | 1.31 ms | 1.64 ms | 1,113 レコード/s | 0 B | ±2.1% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 28,495,287 回/s | 280.8 ns | 0 B | 3.82 KiB | ±0.8% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 17,743 回/s | 7.23 ms | 56.29 MiB | 32.27 KiB | ±4.6% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 68,679 回/s | 116.5 µs | 5.29 MiB | 76.59 KiB | ±1.8% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 15,966 回/s | 501.1 µs | 2.92 MiB | 297.18 KiB | ±0.9% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 16,117 回/s | 7.94 ms | 73.14 MiB | 186.86 KiB | ±0.7% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 13,658 回/s | 9.37 ms | 9.73 MiB | 224.40 KiB | ±1.0% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.8 ns | 59,887,237 回/s | 85.69 MiB | 23.94 KiB | ±7.3% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.1 ns | 27,700,316 回/s | 76.86 MiB | 23.96 KiB | ±2.6% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 19.6 ns | 51,289,453 回/s | 83.50 MiB | 26.09 KiB | ±7.6% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 131.8 ms | 1.68 MiB | 4.89 KiB | ±5.1% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 21.95 ms | 0 B | -4.98 KiB | ±7.4% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
