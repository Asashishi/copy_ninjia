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

個別 scenario と `diskTransport` の実行方法・測定境界は [05 開発フロー](05-dev-workflow.md#個別シナリオと伝送ストレス検証) を参照してください。個別出力と hot-path gate は個別に記録し、以下の全量基準の生成 block を置き換えません。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-07T06:24:08Z · プロセス起動からローカル復元完了まで 569.9 ms · グループメッセージ 1 件を基本ディスパッチする 1.348 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.12 ms / 817 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 9.93 ms / 88 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-138-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-07T06:24:08Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,405 |
| プロセス読み込み | 121.33 MiB |
| プロセス書き込み | 178.32 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 197.80 MiB |
| 読み込みシステムコール | 40,034 |
| 書き込みシステムコール | 85,110 |
| モックルート使用量 | 16.80 MiB |
| モックルートファイル数 | 161 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 173.1 ms | ±4.1% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 27.70 ms | ±6.7% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 1.34 ms | ±30.0% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.82 ms | ±7.1% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 8.01 ms | ±0.8% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 1.12 ms | ±9.6% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 332.3 ms | ±5.2% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 723.2 µs | ±14.8% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 569.9 ms | ±3.0% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 112.33 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.348 µs | 742,336 回/s | 80.88 MiB | 25.70 KiB | ±2.8% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 157.1 ns | 6,377,241 回/s | 88.81 MiB | 21.30 KiB | ±4.0% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 17.6 ns | 57,201,207 回/s | 72.41 MiB | 21.79 KiB | ±7.4% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 46.3 ns | 21,959,464 回/s | 73.24 MiB | 23.24 KiB | ±12.9% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 51.5 ns | 19,696,952 回/s | 73.58 MiB | 23.33 KiB | ±12.2% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,150,684,806 回/s | 71.61 MiB | 22.83 KiB | ±19.5% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 58.4 ns | 17,171,336 回/s | 73.87 MiB | 22.87 KiB | ±5.3% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 5.6 ns | 185,266,057 回/s | 72.14 MiB | 21.61 KiB | ±18.1% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 15.7 ns | 64,145,373 回/s | 72.20 MiB | 21.43 KiB | ±7.1% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 57.6 ns | 17,394,594 回/s | 73.76 MiB | 22.25 KiB | ±4.9% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 13.65 µs | 73,786 回/s | 94.71 MiB | 22.09 KiB | ±8.3% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 194.3 ns | 5,151,342 回/s | 80.44 MiB | 24.61 KiB | ±2.8% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 44.3 ns | 23,933,877 回/s | 80.34 MiB | 22.98 KiB | ±24.1% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 47.9 ns | 21,020,127 回/s | 74.51 MiB | 18.84 KiB | ±8.6% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 519.9 ns | 1,923,477 回/s | 118.11 MiB | 5.63 MiB | ±0.3% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 597.3 ns | 1,679,472 回/s | 128.10 MiB | 20.65 KiB | ±5.6% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 5.7 ns | 175,232,379 回/s | 72.79 MiB | 21.67 KiB | ±1.4% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 6.173 µs | 162,275 回/s | 83.01 MiB | 23.98 KiB | ±4.1% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 145.1 ns | 6,998,129 回/s | 115.00 MiB | 24.61 KiB | ±12.7% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 389.5 ns | 2,571,504 回/s | 96.08 MiB | 26.96 KiB | ±4.0% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 65.54 µs | 15,266 回/s | 96.34 MiB | 23.58 KiB | ±2.3% |
| 返信参照を抽出する<br><code>reply-reference</code> | 35.1 ns | 28,838,223 回/s | 80.96 MiB | 24.86 KiB | ±10.6% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 85.6 ns | 11,784,309 回/s | 85.46 MiB | 22.41 KiB | ±9.9% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 11.7 ns | 157,624,234 回/s | 78.26 MiB | 23.05 KiB | ±85.2% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 44.0 ns | 23,384,876 回/s | 80.57 MiB | 19.47 KiB | ±15.9% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 31.9 ns | 31,394,852 回/s | 72.22 MiB | 21.91 KiB | ±2.4% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 14.1 ns | 71,328,213 回/s | 74.64 MiB | 21.39 KiB | ±6.7% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 93.3 ns | 10,847,505 回/s | 72.99 MiB | 22.53 KiB | ±11.3% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 248 回/s | 4.05 ms | 2.74 ms | 12.03 ms | 37.38 ms | 248 レコード/s | 3.91 MiB | ±5.9% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 55 回/s | 18.39 ms | 18.10 ms | 33.89 ms | 48.28 ms | 7,011 レコード/s | 20.53 MiB | ±8.7% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 244 回/s | 4.11 ms | 3.12 ms | 10.66 ms | 30.34 ms | 244 レコード/s | 3.15 MiB | ±6.4% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 199 回/s | 5.15 ms | 3.77 ms | 13.08 ms | 29.56 ms | 199 レコード/s | 3.13 MiB | ±15.7% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 206 回/s | 4.92 ms | 3.48 ms | 13.74 ms | 31.29 ms | 206 レコード/s | 3.13 MiB | ±12.8% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 128 回/s | 7.88 ms | 6.00 ms | 18.73 ms | 34.00 ms | 128 レコード/s | 11.72 MiB | ±9.9% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 267 回/s | 3.75 ms | 2.65 ms | 11.51 ms | 27.14 ms | 267 レコード/s | 4.16 MiB | ±6.0% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 88 回/s | 11.63 ms | 9.93 ms | 23.68 ms | 43.34 ms | 88 レコード/s | 1.83 MiB | ±17.4% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 817 回/s | 1.21 ms | 1.12 ms | 1.86 ms | 2.66 ms | 817 レコード/s | 0 B | ±0.3% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 19,606,319 回/s | 408.9 ns | 0 B | 8.34 KiB | ±4.7% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 5,870 回/s | 22.10 ms | 61.90 MiB | 30.85 KiB | ±11.0% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 31,726 回/s | 252.3 µs | 4.86 MiB | 61.83 KiB | ±2.4% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 9,790 回/s | 818.2 µs | 2.70 MiB | 274.18 KiB | ±3.7% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 7,392 回/s | 17.34 ms | 67.73 MiB | 154.03 KiB | ±3.9% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 6,554 回/s | 19.58 ms | 9.00 MiB | 189.05 KiB | ±5.0% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 17.1 ns | 58,449,590 回/s | 79.64 MiB | 23.89 KiB | ±1.9% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 49.5 ns | 20,214,169 回/s | 74.03 MiB | 23.13 KiB | ±2.2% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 22.4 ns | 45,095,505 回/s | 80.19 MiB | 25.22 KiB | ±10.7% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 206.4 ms | 1.90 MiB | 4.89 KiB | ±5.6% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 40.90 ms | 0 B | -7.73 KiB | ±1.9% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
