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

**直近の全量ベンチマーク** · Bun 1.4.0 · 3 ラウンドの平均 · 2026-08-30T07:08:35Z · プロセス起動からローカル復元完了まで 458.7 ms · グループメッセージ 1 件を基本ディスパッチする 1.297 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.06 ms / 837 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.52 ms / 156 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| カーネル | linux 6.8.0-138-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-08-30T07:08:35Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 385,931,405 |
| プロセス読み込み | 120.35 MiB |
| プロセス書き込み | 173.64 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 193.11 MiB |
| 読み込みシステムコール | 40,111 |
| 書き込みシステムコール | 83,981 |
| モックルート使用量 | 13.91 MiB |
| モックルートファイル数 | 161 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 133.2 ms | ±4.0% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 21.70 ms | ±6.1% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 718.5 µs | ±7.4% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.68 ms | ±8.6% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.18 ms | ±13.8% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 873.8 µs | ±13.7% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 271.8 ms | ±2.5% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 748.1 µs | ±10.3% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 458.7 ms | ±2.6% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 105.88 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.297 µs | 771,400 回/s | 77.88 MiB | 25.33 KiB | ±2.7% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 157.2 ns | 6,422,467 回/s | 81.60 MiB | 22.49 KiB | ±9.8% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 7.5 ns | 532,558,074 回/s | 66.44 MiB | 21.75 KiB | ±64.3% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 25.9 ns | 38,651,942 回/s | 67.20 MiB | 20.56 KiB | ±3.9% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.8 ns | 1,271,163,082 回/s | 66.01 MiB | 22.05 KiB | ±17.0% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 54.7 ns | 18,320,317 回/s | 69.09 MiB | 22.11 KiB | ±5.0% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.1 ns | 242,100,823 回/s | 66.54 MiB | 22.20 KiB | ±1.8% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 13.4 ns | 74,944,892 回/s | 67.56 MiB | 21.18 KiB | ±4.8% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 48.3 ns | 20,747,805 回/s | 69.12 MiB | 16.99 KiB | ±3.4% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 12.39 µs | 80,826 回/s | 86.87 MiB | 23.91 KiB | ±4.2% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 129.9 ns | 7,707,585 回/s | 76.40 MiB | 19.24 KiB | ±3.2% |
| 一時 allowlist の日内活動と付与境界を進める<br><code>temporary-whitelist-activity</code> | 72.6 ns | 14,066,238 回/s | 76.63 MiB | 20.40 KiB | ±15.1% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 52.8 ns | 19,074,332 回/s | 69.39 MiB | 19.48 KiB | ±8.5% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 481.9 ns | 2,103,407 回/s | 104.30 MiB | 5.63 MiB | ±11.5% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 459.9 ns | 2,177,657 回/s | 124.42 MiB | 20.17 KiB | ±3.8% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.6 ns | 219,409,199 回/s | 67.39 MiB | 21.91 KiB | ±7.3% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.415 µs | 184,723 回/s | 74.90 MiB | -2.07 MiB | ±1.3% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 117.4 ns | 8,593,907 回/s | 105.66 MiB | 23.77 KiB | ±9.5% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 707.7 ns | 1,415,560 回/s | 80.88 MiB | 22.78 KiB | ±4.3% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 54.40 µs | 18,384 回/s | 88.47 MiB | -2.08 MiB | ±1.0% |
| 返信参照を抽出する<br><code>reply-reference</code> | 27.6 ns | 36,517,279 回/s | 75.98 MiB | 24.09 KiB | ±8.0% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 107.8 ns | 9,283,499 回/s | 85.01 MiB | 21.86 KiB | ±2.8% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.1 ns | 246,999,051 回/s | 70.82 MiB | 22.38 KiB | ±2.7% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 38.5 ns | 25,995,875 回/s | 73.93 MiB | 19.37 KiB | ±2.0% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 29.4 ns | 34,331,840 回/s | 73.01 MiB | 21.94 KiB | ±10.5% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 11.5 ns | 87,021,115 回/s | 70.08 MiB | 19.60 KiB | ±1.9% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 75.7 ns | 13,214,417 回/s | 68.15 MiB | 19.15 KiB | ±2.2% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 406 回/s | 2.46 ms | 1.97 ms | 4.40 ms | 54.69 ms | 406 レコード/s | 3.91 MiB | ±4.5% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 75 回/s | 13.28 ms | 13.47 ms | 23.07 ms | 43.90 ms | 9,663 レコード/s | 20.53 MiB | ±5.3% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 329 回/s | 3.06 ms | 2.47 ms | 6.17 ms | 16.79 ms | 329 レコード/s | 3.15 MiB | ±8.6% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 312 回/s | 3.21 ms | 2.44 ms | 6.97 ms | 43.21 ms | 312 レコード/s | 3.13 MiB | ±6.4% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 329 回/s | 3.05 ms | 2.43 ms | 5.89 ms | 18.22 ms | 329 レコード/s | 3.13 MiB | ±5.1% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 187 回/s | 5.34 ms | 4.51 ms | 10.33 ms | 17.16 ms | 187 レコード/s | 7.03 MiB | ±2.3% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 415 回/s | 2.41 ms | 2.02 ms | 4.06 ms | 17.15 ms | 415 レコード/s | 4.16 MiB | ±3.5% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 156 回/s | 6.45 ms | 5.52 ms | 11.58 ms | 26.35 ms | 156 レコード/s | 1.83 MiB | ±8.2% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 837 回/s | 1.19 ms | 1.06 ms | 1.83 ms | 3.44 ms | 837 レコード/s | 0 B | ±5.9% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 25,807,307 回/s | 310.1 ns | 0 B | 7.08 KiB | ±2.1% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,581 回/s | 12.10 ms | 61.90 MiB | -1.66 MiB | ±1.1% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 42,406 回/s | 189.0 µs | 4.86 MiB | -1.70 MiB | ±4.1% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 11,340 回/s | 706.4 µs | 2.70 MiB | 273.61 KiB | ±3.7% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 10,263 回/s | 12.48 ms | 67.73 MiB | -1.56 MiB | ±1.7% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,064 回/s | 15.89 ms | 9.00 MiB | 201.28 KiB | ±3.1% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.7 ns | 59,810,662 回/s | 75.86 MiB | 23.00 KiB | ±2.5% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 39.7 ns | 25,721,459 回/s | 69.16 MiB | 22.24 KiB | ±15.4% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 18.1 ns | 55,368,867 回/s | 74.80 MiB | 23.79 KiB | ±5.0% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 163.3 ms | 2.72 MiB | 4.41 KiB | ±3.3% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 33.26 ms | 0 B | -4.88 KiB | ±23.2% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
