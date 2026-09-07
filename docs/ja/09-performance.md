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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-07T09:40:53Z · プロセス起動からローカル復元完了まで 521.5 ms · グループメッセージ 1 件を基本ディスパッチする 1.253 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.11 ms / 806 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.99 ms / 128 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-138-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-07T09:40:53Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,405 |
| プロセス読み込み | 121.29 MiB |
| プロセス書き込み | 178.32 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 197.80 MiB |
| 読み込みシステムコール | 39,990 |
| 書き込みシステムコール | 85,180 |
| モックルート使用量 | 17.50 MiB |
| モックルートファイル数 | 160 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 149.2 ms | ±8.8% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 21.08 ms | ±21.9% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 736.7 µs | ±5.4% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.75 ms | ±6.0% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 8.37 ms | ±11.1% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 1.55 ms | ±38.9% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 319.1 ms | ±2.8% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 2.81 ms | ±51.6% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 521.5 ms | ±5.2% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 112.24 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.253 µs | 800,273 回/s | 79.56 MiB | 25.97 KiB | ±5.2% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 131.9 ns | 7,794,342 回/s | 86.60 MiB | 21.89 KiB | ±17.5% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 15.7 ns | 63,810,719 回/s | 72.20 MiB | 22.16 KiB | ±5.6% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 35.5 ns | 28,221,345 回/s | 72.58 MiB | 20.72 KiB | ±5.3% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 48.5 ns | 20,861,687 回/s | 73.31 MiB | 21.11 KiB | ±10.9% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.7 ns | 1,378,443,448 回/s | 71.76 MiB | 21.90 KiB | ±12.0% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 54.0 ns | 18,564,501 回/s | 73.85 MiB | 22.90 KiB | ±5.2% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.4 ns | 230,410,421 回/s | 71.28 MiB | 23.56 KiB | ±8.4% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 15.6 ns | 64,279,124 回/s | 72.44 MiB | 22.25 KiB | ±6.9% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 43.2 ns | 23,207,847 回/s | 73.67 MiB | 17.70 KiB | ±4.0% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 13.25 µs | 75,608 回/s | 93.72 MiB | 22.66 KiB | ±4.3% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 122.7 ns | 8,160,298 回/s | 79.42 MiB | 21.97 KiB | ±4.0% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 41.7 ns | 26,626,996 回/s | 79.47 MiB | 23.35 KiB | ±34.8% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 51.3 ns | 19,558,569 回/s | 74.01 MiB | 21.22 KiB | ±6.0% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 447.2 ns | 2,240,059 回/s | 118.04 MiB | 5.63 MiB | ±4.1% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 463.0 ns | 2,162,609 回/s | 127.87 MiB | 21.45 KiB | ±3.4% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 5.6 ns | 182,278,739 回/s | 72.78 MiB | 21.54 KiB | ±12.0% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.153 µs | 194,096 回/s | 82.27 MiB | 23.78 KiB | ±1.0% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 144.2 ns | 6,950,551 回/s | 114.95 MiB | 24.18 KiB | ±4.7% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 336.8 ns | 2,972,284 回/s | 97.47 MiB | 26.09 KiB | ±3.2% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 57.40 µs | 17,425 回/s | 95.10 MiB | 23.12 KiB | ±1.5% |
| 返信参照を抽出する<br><code>reply-reference</code> | 31.4 ns | 32,575,313 回/s | 81.13 MiB | 24.12 KiB | ±14.6% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 70.5 ns | 14,255,365 回/s | 85.00 MiB | 21.83 KiB | ±7.1% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 9.6 ns | 148,062,356 回/s | 76.02 MiB | 22.54 KiB | ±63.8% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 36.9 ns | 27,771,939 回/s | 80.40 MiB | 20.78 KiB | ±16.5% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 25.5 ns | 39,411,648 回/s | 71.93 MiB | 22.43 KiB | ±5.8% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 12.1 ns | 83,051,920 回/s | 74.96 MiB | 22.75 KiB | ±3.6% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 82.6 ns | 12,115,567 回/s | 72.69 MiB | 22.00 KiB | ±3.4% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 356 回/s | 2.81 ms | 1.98 ms | 7.33 ms | 54.71 ms | 356 レコード/s | 3.91 MiB | ±4.9% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 70 回/s | 14.25 ms | 14.44 ms | 25.09 ms | 41.99 ms | 8,988 レコード/s | 20.53 MiB | ±3.6% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 277 回/s | 3.62 ms | 2.76 ms | 9.80 ms | 22.00 ms | 277 レコード/s | 3.15 MiB | ±4.8% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 236 回/s | 4.58 ms | 3.47 ms | 12.63 ms | 23.94 ms | 236 レコード/s | 3.13 MiB | ±25.1% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 284 回/s | 3.53 ms | 2.69 ms | 9.98 ms | 21.32 ms | 284 レコード/s | 3.13 MiB | ±7.0% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 171 回/s | 5.85 ms | 4.67 ms | 14.22 ms | 25.40 ms | 171 レコード/s | 11.72 MiB | ±3.7% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 368 回/s | 2.71 ms | 2.10 ms | 5.48 ms | 26.51 ms | 368 レコード/s | 4.16 MiB | ±2.9% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 128 回/s | 7.85 ms | 5.99 ms | 19.36 ms | 42.69 ms | 128 レコード/s | 1.83 MiB | ±6.4% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 806 回/s | 1.23 ms | 1.11 ms | 1.87 ms | 2.93 ms | 806 レコード/s | 0 B | ±1.8% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 26,150,494 回/s | 306.2 ns | 0 B | 9.54 KiB | ±2.9% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 9,584 回/s | 13.37 ms | 61.90 MiB | 30.35 KiB | ±3.6% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 40,990 回/s | 195.2 µs | 4.86 MiB | 59.19 KiB | ±0.7% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 11,525 回/s | 694.3 µs | 2.70 MiB | 273.95 KiB | ±1.3% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 8,446 回/s | 15.36 ms | 67.73 MiB | 142.69 KiB | ±11.0% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 7,902 回/s | 16.26 ms | 9.00 MiB | 187.75 KiB | ±6.0% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 18.9 ns | 53,444,357 回/s | 79.20 MiB | 23.69 KiB | ±11.0% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 43.1 ns | 23,611,213 回/s | 73.19 MiB | 23.69 KiB | ±12.4% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 20.8 ns | 49,954,784 回/s | 80.42 MiB | 25.85 KiB | ±20.2% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 157.3 ms | 1.85 MiB | 4.89 KiB | ±5.0% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 35.49 ms | 0 B | -6.36 KiB | ±7.5% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
