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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-16T18:25:11Z · プロセス起動からローカル復元完了まで 309.4 ms · グループメッセージ 1 件を基本ディスパッチする 140.7 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 840.0 µs / 1,125 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 2.98 ms / 309 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-16T18:25:11Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,405 |
| プロセス読み込み | 164.26 MiB |
| プロセス書き込み | 173.94 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 193.70 MiB |
| 読み込みシステムコール | 51,812 |
| 書き込みシステムコール | 86,153 |
| モックルート使用量 | 14.86 MiB |
| モックルートファイル数 | 113 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 96.32 ms | ±0.6% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 13.51 ms | ±8.4% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 507.7 µs | ±5.6% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.31 ms | ±2.7% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.67 ms | ±5.8% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 641.6 µs | ±2.5% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 179.9 ms | ±0.8% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 887.0 µs | ±84.6% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 309.4 ms | ±0.8% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 110.28 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 140.7 ns | 7,113,642 回/s | 87.93 MiB | 4.13 KiB | ±2.5% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 83.7 ns | 11,949,244 回/s | 90.42 MiB | 20.87 KiB | ±1.2% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 16.1 ns | 62,172,221 回/s | 74.78 MiB | 21.66 KiB | ±1.7% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 23.9 ns | 46,235,022 回/s | 75.29 MiB | 21.78 KiB | ±27.8% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 33.5 ns | 29,869,648 回/s | 76.76 MiB | 21.28 KiB | ±0.5% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.8 ns | 1,190,647,550 回/s | 73.83 MiB | 23.19 KiB | ±0.9% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 51.5 ns | 19,420,116 回/s | 76.11 MiB | 20.79 KiB | ±0.9% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.0 ns | 247,896,620 回/s | 74.49 MiB | 21.59 KiB | ±1.6% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 11.4 ns | 87,952,589 回/s | 75.35 MiB | 19.02 KiB | ±2.2% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 41.7 ns | 23,968,661 回/s | 77.06 MiB | 19.71 KiB | ±2.2% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 7.736 µs | 129,485 回/s | 98.28 MiB | 21.83 KiB | ±4.1% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 92.1 ns | 10,862,813 回/s | 81.97 MiB | 23.39 KiB | ±2.6% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 26.9 ns | 37,138,250 回/s | 83.30 MiB | 22.53 KiB | ±1.3% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 48.4 ns | 20,677,137 回/s | 77.11 MiB | 23.73 KiB | ±2.7% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 280.8 ns | 3,564,730 回/s | 120.17 MiB | 5.63 MiB | ±3.0% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 298.2 ns | 3,358,871 回/s | 163.57 MiB | 21.53 KiB | ±4.0% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.2 ns | 239,150,610 回/s | 74.91 MiB | 21.39 KiB | ±1.2% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 4.370 µs | 228,866 回/s | 85.41 MiB | 23.38 KiB | ±0.6% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 96.6 ns | 10,359,825 回/s | 119.60 MiB | 24.90 KiB | ±2.4% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 269.6 ns | 3,711,132 回/s | 86.91 MiB | 25.08 KiB | ±2.3% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 36.70 µs | 27,252 回/s | 98.00 MiB | 22.44 KiB | ±0.3% |
| 返信参照を抽出する<br><code>reply-reference</code> | 18.8 ns | 53,096,694 回/s | 86.89 MiB | 24.46 KiB | ±1.1% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 52.5 ns | 19,034,866 回/s | 88.08 MiB | 20.25 KiB | ±0.7% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.3 ns | 233,610,209 回/s | 81.63 MiB | 20.94 KiB | ±2.5% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 37.2 ns | 26,881,125 回/s | 83.85 MiB | 20.63 KiB | ±1.6% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 20.8 ns | 48,124,127 回/s | 75.06 MiB | 21.04 KiB | ±1.0% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 15.5 ns | 64,582,796 回/s | 76.88 MiB | 22.38 KiB | ±0.4% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 72.0 ns | 13,885,817 回/s | 76.08 MiB | 20.65 KiB | ±2.1% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 938 回/s | 1.07 ms | 974.0 µs | 1.44 ms | 7.04 ms | 938 レコード/s | 3.91 MiB | ±4.7% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 147 回/s | 6.79 ms | 7.62 ms | 11.22 ms | 17.35 ms | 18,842 レコード/s | 21.42 MiB | ±1.7% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 605 回/s | 1.66 ms | 1.45 ms | 2.25 ms | 23.93 ms | 605 レコード/s | 3.15 MiB | ±7.9% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 635 回/s | 1.57 ms | 1.46 ms | 2.08 ms | 7.82 ms | 635 レコード/s | 3.13 MiB | ±2.9% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 651 回/s | 1.54 ms | 1.42 ms | 1.98 ms | 8.12 ms | 651 レコード/s | 3.13 MiB | ±3.0% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 359 回/s | 2.79 ms | 2.54 ms | 4.03 ms | 12.39 ms | 359 レコード/s | 5.55 MiB | ±2.0% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 813 回/s | 1.23 ms | 1.08 ms | 1.71 ms | 10.12 ms | 813 レコード/s | 4.16 MiB | ±2.7% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 309 回/s | 3.24 ms | 2.98 ms | 4.70 ms | 10.61 ms | 309 レコード/s | 1.83 MiB | ±0.7% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 1,125 回/s | 881.5 µs | 840.0 µs | 1.17 ms | 1.66 ms | 1,125 レコード/s | 0 B | ±1.5% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 29,864,392 回/s | 267.9 ns | 0 B | 6.75 KiB | ±0.6% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 20,253 回/s | 6.32 ms | 56.29 MiB | 31.74 KiB | ±0.9% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 73,390 回/s | 109.2 µs | 5.29 MiB | 80.82 KiB | ±3.7% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 16,698 回/s | 479.1 µs | 2.92 MiB | 296.78 KiB | ±0.6% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 18,039 回/s | 7.10 ms | 73.14 MiB | 185.21 KiB | ±1.6% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 14,615 回/s | 8.77 ms | 9.73 MiB | 222.49 KiB | ±4.1% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 18.0 ns | 55,564,367 回/s | 86.80 MiB | 23.16 KiB | ±3.9% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 37.0 ns | 27,070,852 回/s | 76.71 MiB | 24.06 KiB | ±1.7% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 18.1 ns | 55,387,859 回/s | 83.24 MiB | 24.94 KiB | ±3.4% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 115.8 ms | 1.61 MiB | 4.89 KiB | ±0.8% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 15.47 ms | 0 B | -4.98 KiB | ±2.4% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
