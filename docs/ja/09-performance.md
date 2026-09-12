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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-12T11:30:34Z · プロセス起動からローカル復元完了まで 313.7 ms · グループメッセージ 1 件を基本ディスパッチする 138.4 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 793.1 µs / 1,207 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 2.90 ms / 323 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-12T11:30:34Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,405 |
| プロセス読み込み | 121.42 MiB |
| プロセス書き込み | 178.32 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 197.80 MiB |
| 読み込みシステムコール | 40,002 |
| 書き込みシステムコール | 85,067 |
| モックルート使用量 | 13.35 MiB |
| モックルートファイル数 | 161 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 92.79 ms | ±3.1% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 12.17 ms | ±10.2% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 506.0 µs | ±2.1% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.33 ms | ±3.5% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.56 ms | ±6.1% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 642.1 µs | ±1.2% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 186.8 ms | ±1.4% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 1.60 ms | ±52.7% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 313.7 ms | ±1.6% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 110.27 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 138.4 ns | 7,233,324 回/s | 93.16 MiB | 10.81 KiB | ±3.1% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 81.3 ns | 12,294,833 回/s | 95.08 MiB | 21.67 KiB | ±0.4% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 15.8 ns | 63,367,872 回/s | 80.17 MiB | 23.13 KiB | ±2.5% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 29.0 ns | 34,486,670 回/s | 80.36 MiB | 22.06 KiB | ±1.5% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 36.7 ns | 27,281,099 回/s | 79.81 MiB | 22.28 KiB | ±2.5% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,143,098,829 回/s | 77.93 MiB | 21.93 KiB | ±1.1% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 53.0 ns | 18,893,426 回/s | 82.11 MiB | 21.67 KiB | ±3.8% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.2 ns | 237,563,609 回/s | 77.65 MiB | 22.06 KiB | ±3.2% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 11.7 ns | 85,330,921 回/s | 78.73 MiB | 21.59 KiB | ±3.0% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 42.0 ns | 23,831,048 回/s | 82.13 MiB | 20.15 KiB | ±2.7% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 7.998 µs | 125,911 回/s | 99.98 MiB | 21.99 KiB | ±8.6% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 94.8 ns | 10,558,695 回/s | 86.38 MiB | 24.67 KiB | ±3.0% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 27.6 ns | 36,191,486 回/s | 85.77 MiB | 23.05 KiB | ±1.1% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 49.6 ns | 20,210,065 回/s | 80.30 MiB | 22.89 KiB | ±5.7% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 265.4 ns | 3,772,284 回/s | 125.88 MiB | 5.63 MiB | ±3.6% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 296.4 ns | 3,374,880 回/s | 139.89 MiB | 19.36 KiB | ±1.6% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.2 ns | 237,427,178 回/s | 80.81 MiB | 21.08 KiB | ±1.0% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 4.400 µs | 227,339 回/s | 87.03 MiB | 24.39 KiB | ±1.7% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 94.6 ns | 10,569,960 回/s | 121.43 MiB | 44.48 KiB | ±1.0% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 253.3 ns | 3,951,750 回/s | 103.11 MiB | 28.23 KiB | ±3.5% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 38.30 µs | 26,118 回/s | 105.36 MiB | 23.64 KiB | ±1.7% |
| 返信参照を抽出する<br><code>reply-reference</code> | 18.3 ns | 54,532,917 回/s | 91.24 MiB | 24.46 KiB | ±2.0% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 51.5 ns | 19,420,230 回/s | 91.99 MiB | 21.26 KiB | ±1.5% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.4 ns | 225,858,992 回/s | 85.14 MiB | 22.22 KiB | ±6.4% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 33.9 ns | 29,614,930 回/s | 86.06 MiB | 20.10 KiB | ±6.0% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 21.3 ns | 46,943,013 回/s | 80.54 MiB | 22.06 KiB | ±1.4% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 15.5 ns | 64,469,873 回/s | 78.56 MiB | 23.04 KiB | ±0.2% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 73.9 ns | 13,561,516 回/s | 79.45 MiB | 22.12 KiB | ±4.4% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 925 回/s | 1.09 ms | 941.1 µs | 1.45 ms | 8.87 ms | 925 レコード/s | 3.91 MiB | ±7.1% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 145 回/s | 6.87 ms | 7.70 ms | 11.38 ms | 18.26 ms | 18,624 レコード/s | 20.53 MiB | ±2.1% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 614 回/s | 1.63 ms | 1.42 ms | 2.35 ms | 10.60 ms | 614 レコード/s | 3.15 MiB | ±2.7% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 616 回/s | 1.63 ms | 1.44 ms | 2.47 ms | 9.97 ms | 616 レコード/s | 3.13 MiB | ±5.5% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 650 回/s | 1.54 ms | 1.43 ms | 2.00 ms | 9.81 ms | 650 レコード/s | 3.13 MiB | ±3.8% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 349 回/s | 2.87 ms | 2.64 ms | 4.34 ms | 9.84 ms | 349 レコード/s | 11.72 MiB | ±4.9% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 841 回/s | 1.19 ms | 1.09 ms | 1.55 ms | 8.68 ms | 841 レコード/s | 4.16 MiB | ±3.1% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 323 回/s | 3.09 ms | 2.90 ms | 4.19 ms | 7.53 ms | 323 レコード/s | 1.83 MiB | ±1.3% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 1,207 回/s | 821.0 µs | 793.1 µs | 1.11 ms | 1.38 ms | 1,207 レコード/s | 0 B | ±0.7% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 29,790,260 回/s | 268.8 ns | 0 B | 6.86 KiB | ±2.9% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 19,925 回/s | 6.43 ms | 61.90 MiB | 31.71 KiB | ±1.5% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 75,908 回/s | 105.4 µs | 4.86 MiB | 81.29 KiB | ±0.9% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 18,323 回/s | 436.8 µs | 2.70 MiB | 273.05 KiB | ±2.2% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 17,888 回/s | 7.16 ms | 67.73 MiB | 187.01 KiB | ±1.0% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 14,475 回/s | 8.85 ms | 9.00 MiB | 220.54 KiB | ±1.7% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 15.6 ns | 64,775,792 回/s | 85.81 MiB | 23.30 KiB | ±11.8% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 35.8 ns | 27,960,985 回/s | 81.16 MiB | 24.05 KiB | ±0.9% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 18.8 ns | 53,309,406 回/s | 87.85 MiB | 25.53 KiB | ±2.2% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 118.8 ms | 1.73 MiB | 4.96 KiB | ±0.9% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 16.38 ms | 0 B | -4.98 KiB | ±5.0% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
