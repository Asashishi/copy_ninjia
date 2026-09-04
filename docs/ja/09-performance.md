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

**直近の全量ベンチマーク** · Bun 1.4.0 · 3 ラウンドの平均 · 2026-09-04T09:28:52Z · プロセス起動からローカル復元完了まで 541.0 ms · グループメッセージ 1 件を基本ディスパッチする 1.452 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 986.7 µs / 924 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 6.21 ms / 129 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| カーネル | linux 6.8.0-138-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-04T09:28:52Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 385,931,405 |
| プロセス読み込み | 121.30 MiB |
| プロセス書き込み | 178.31 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 197.80 MiB |
| 読み込みシステムコール | 40,320 |
| 書き込みシステムコール | 84,094 |
| モックルート使用量 | 14.94 MiB |
| モックルートファイル数 | 163 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 159.2 ms | ±9.4% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 25.20 ms | ±15.7% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 909.4 µs | ±4.7% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.70 ms | ±14.9% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 7.14 ms | ±12.1% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 896.8 µs | ±11.3% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 316.9 ms | ±9.2% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 704.5 µs | ±1.8% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 541.0 ms | ±2.0% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 110.51 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.452 µs | 690,168 回/s | 76.59 MiB | 24.78 KiB | ±4.8% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 200.2 ns | 5,004,909 回/s | 80.72 MiB | 23.69 KiB | ±4.4% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 15.5 ns | 69,356,402 回/s | 67.70 MiB | 22.27 KiB | ±24.4% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 28.9 ns | 34,605,867 回/s | 67.98 MiB | 23.03 KiB | ±1.7% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,107,862,947 回/s | 66.96 MiB | 22.48 KiB | ±8.9% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 50.8 ns | 19,703,589 回/s | 69.89 MiB | 24.37 KiB | ±3.7% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.8 ns | 209,271,438 回/s | 67.23 MiB | 23.50 KiB | ±9.2% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 13.3 ns | 74,978,903 回/s | 68.00 MiB | 23.27 KiB | ±2.8% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 55.1 ns | 18,706,425 回/s | 69.46 MiB | 21.38 KiB | ±17.6% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 14.46 µs | 69,328 回/s | 87.01 MiB | 25.72 KiB | ±4.6% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 133.2 ns | 7,600,057 回/s | 75.10 MiB | 22.55 KiB | ±11.0% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 50.3 ns | 20,690,601 回/s | 73.86 MiB | 22.58 KiB | ±18.6% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 59.8 ns | 16,812,196 回/s | 69.98 MiB | 20.33 KiB | ±7.5% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 496.7 ns | 2,066,343 回/s | 108.04 MiB | 5.63 MiB | ±15.3% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 589.5 ns | 1,712,594 回/s | 122.41 MiB | 20.82 KiB | ±9.8% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.9 ns | 212,392,920 回/s | 68.45 MiB | 22.32 KiB | ±18.3% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 6.000 µs | 166,882 回/s | 75.60 MiB | -2.11 MiB | ±3.6% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 124.4 ns | 8,065,939 回/s | 106.89 MiB | 23.76 KiB | ±5.9% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 342.8 ns | 2,917,472 回/s | 96.89 MiB | 27.70 KiB | ±1.2% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 61.18 µs | 16,348 回/s | 88.23 MiB | -2.12 MiB | ±1.5% |
| 返信参照を抽出する<br><code>reply-reference</code> | 31.3 ns | 32,092,176 回/s | 78.57 MiB | 24.03 KiB | ±6.0% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 78.4 ns | 12,807,437 回/s | 79.09 MiB | 22.36 KiB | ±6.4% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.9 ns | 209,679,722 回/s | 71.59 MiB | 22.07 KiB | ±13.9% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 40.4 ns | 24,770,714 回/s | 74.89 MiB | 20.61 KiB | ±1.9% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 28.9 ns | 34,943,882 回/s | 68.07 MiB | 22.53 KiB | ±10.0% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 13.2 ns | 76,595,485 回/s | 70.38 MiB | 20.12 KiB | ±11.5% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 89.7 ns | 11,289,593 回/s | 68.65 MiB | 23.48 KiB | ±10.7% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 376 回/s | 2.66 ms | 2.03 ms | 5.97 ms | 21.89 ms | 376 レコード/s | 3.91 MiB | ±5.0% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 69 回/s | 14.45 ms | 14.44 ms | 25.48 ms | 38.61 ms | 8,858 レコード/s | 20.53 MiB | ±1.6% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 287 回/s | 3.49 ms | 2.67 ms | 8.42 ms | 24.78 ms | 287 レコード/s | 3.15 MiB | ±6.8% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 274 回/s | 3.69 ms | 3.08 ms | 8.01 ms | 24.28 ms | 274 レコード/s | 3.13 MiB | ±10.9% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 286 回/s | 3.50 ms | 2.84 ms | 7.75 ms | 18.45 ms | 286 レコード/s | 3.13 MiB | ±5.6% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 177 回/s | 5.68 ms | 4.54 ms | 13.48 ms | 25.93 ms | 177 レコード/s | 11.72 MiB | ±6.4% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 344 回/s | 2.91 ms | 2.26 ms | 7.16 ms | 19.46 ms | 344 レコード/s | 4.16 MiB | ±5.1% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 129 回/s | 7.73 ms | 6.21 ms | 17.48 ms | 31.97 ms | 129 レコード/s | 1.83 MiB | ±0.7% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 924 回/s | 1.07 ms | 986.7 µs | 1.56 ms | 2.15 ms | 924 レコード/s | 0 B | ±2.3% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 24,371,926 回/s | 330.3 ns | 0 B | 7.71 KiB | ±7.9% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 9,428 回/s | 13.58 ms | 61.90 MiB | -1.69 MiB | ±1.9% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 38,274 回/s | 209.3 µs | 4.86 MiB | -1.70 MiB | ±3.9% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 11,092 回/s | 721.4 µs | 2.70 MiB | 273.93 KiB | ±1.4% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 8,722 回/s | 14.72 ms | 67.73 MiB | -1.57 MiB | ±5.5% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 6,772 回/s | 19.00 ms | 9.00 MiB | 200.32 KiB | ±7.5% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 18.1 ns | 55,248,820 回/s | 76.18 MiB | 23.47 KiB | ±4.2% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.4 ns | 27,659,635 回/s | 69.97 MiB | 22.80 KiB | ±7.6% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 22.4 ns | 44,802,041 回/s | 75.46 MiB | 25.84 KiB | ±4.3% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 157.7 ms | 1.98 MiB | 4.96 KiB | ±7.2% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 36.32 ms | 0 B | -4.99 KiB | ±4.7% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
