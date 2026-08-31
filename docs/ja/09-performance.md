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

**直近の全量ベンチマーク** · Bun 1.4.0 · 3 ラウンドの平均 · 2026-08-31T13:46:19Z · プロセス起動からローカル復元完了まで 470.4 ms · グループメッセージ 1 件を基本ディスパッチする 1.222 µs · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 1.05 ms / 844 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 5.84 ms / 140 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| カーネル | linux 6.8.0-138-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-08-31T13:46:19Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 385,931,405 |
| プロセス読み込み | 120.38 MiB |
| プロセス書き込み | 173.64 MiB |
| ブロックデバイス読み込み | 1.33 KiB |
| ブロックデバイス書き込み | 193.11 MiB |
| 読み込みシステムコール | 40,130 |
| 書き込みシステムコール | 83,991 |
| モックルート使用量 | 14.55 MiB |
| モックルートファイル数 | 163 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 131.4 ms | ±2.7% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 23.06 ms | ±6.3% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 730.1 µs | ±13.4% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.62 ms | ±7.0% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 8.09 ms | ±20.1% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 884.6 µs | ±2.6% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 281.6 ms | ±3.4% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 819.5 µs | ±31.7% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 470.4 ms | ±2.1% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 103.44 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 1.222 µs | 821,346 回/s | 75.11 MiB | 25.39 KiB | ±5.9% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 156.0 ns | 6,494,178 回/s | 80.27 MiB | 23.11 KiB | ±11.7% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 10.4 ns | 96,412,899 回/s | 67.44 MiB | 22.14 KiB | ±1.1% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 28.2 ns | 35,600,850 回/s | 67.82 MiB | 22.14 KiB | ±6.1% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.7 ns | 1,412,634,107 回/s | 66.60 MiB | 21.78 KiB | ±9.3% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 52.6 ns | 19,125,549 回/s | 69.89 MiB | 23.00 KiB | ±7.8% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.6 ns | 218,826,607 回/s | 67.14 MiB | 23.01 KiB | ±8.6% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 14.0 ns | 71,759,559 回/s | 67.61 MiB | 21.18 KiB | ±4.6% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 53.4 ns | 18,756,354 回/s | 69.64 MiB | 21.58 KiB | ±3.1% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 13.23 µs | 75,632 回/s | 87.09 MiB | 24.14 KiB | ±1.8% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 110.8 ns | 9,040,905 回/s | 75.10 MiB | 17.33 KiB | ±4.5% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 44.5 ns | 25,651,705 回/s | 74.18 MiB | 23.34 KiB | ±40.0% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 51.9 ns | 19,273,868 回/s | 69.78 MiB | 22.13 KiB | ±1.8% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 516.1 ns | 1,945,808 回/s | 105.27 MiB | 5.63 MiB | ±6.5% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 451.4 ns | 2,216,695 回/s | 123.80 MiB | 21.36 KiB | ±2.6% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.4 ns | 225,268,586 回/s | 67.93 MiB | 21.91 KiB | ±3.3% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 5.519 µs | 181,274 回/s | 75.20 MiB | -2.07 MiB | ±2.2% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 134.4 ns | 7,458,547 回/s | 106.24 MiB | 24.08 KiB | ±4.9% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 718.7 ns | 1,391,686 回/s | 82.56 MiB | 22.93 KiB | ±1.5% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 57.20 µs | 17,535 回/s | 88.61 MiB | -2.08 MiB | ±5.6% |
| 返信参照を抽出する<br><code>reply-reference</code> | 24.4 ns | 41,210,241 回/s | 79.18 MiB | 23.94 KiB | ±6.0% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 101.1 ns | 9,911,469 回/s | 82.43 MiB | 22.50 KiB | ±4.0% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 9.1 ns | 186,607,995 回/s | 72.38 MiB | 23.37 KiB | ±80.4% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 35.1 ns | 28,665,345 回/s | 74.63 MiB | 21.23 KiB | ±8.1% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 28.6 ns | 35,135,492 回/s | 73.36 MiB | 22.26 KiB | ±7.9% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 12.3 ns | 81,751,028 回/s | 70.29 MiB | 20.05 KiB | ±7.1% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 77.6 ns | 12,899,693 回/s | 69.53 MiB | 21.41 KiB | ±3.3% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 426 回/s | 2.35 ms | 1.90 ms | 4.09 ms | 19.52 ms | 426 レコード/s | 3.91 MiB | ±3.1% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 52 回/s | 19.98 ms | 17.07 ms | 47.28 ms | 88.66 ms | 6,668 レコード/s | 20.53 MiB | ±18.5% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 175 回/s | 6.15 ms | 5.38 ms | 14.77 ms | 43.77 ms | 175 レコード/s | 3.15 MiB | ±28.7% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 321 回/s | 3.12 ms | 2.47 ms | 7.03 ms | 22.56 ms | 321 レコード/s | 3.13 MiB | ±5.6% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 272 回/s | 3.70 ms | 2.79 ms | 8.80 ms | 23.00 ms | 272 レコード/s | 3.13 MiB | ±7.8% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 168 回/s | 6.06 ms | 4.57 ms | 12.82 ms | 24.48 ms | 168 レコード/s | 7.03 MiB | ±12.6% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 380 回/s | 2.67 ms | 2.15 ms | 5.01 ms | 19.87 ms | 380 レコード/s | 4.16 MiB | ±13.0% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 140 回/s | 7.17 ms | 5.84 ms | 14.74 ms | 29.44 ms | 140 レコード/s | 1.83 MiB | ±5.7% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 844 回/s | 1.17 ms | 1.05 ms | 1.94 ms | 3.17 ms | 844 レコード/s | 0 B | ±7.1% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 25,938,425 回/s | 309.8 ns | 0 B | 5.93 KiB | ±6.6% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 10,636 回/s | 12.04 ms | 61.90 MiB | -1.69 MiB | ±2.0% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 43,489 回/s | 184.0 µs | 4.86 MiB | -1.70 MiB | ±0.5% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 12,729 回/s | 628.7 µs | 2.70 MiB | 273.09 KiB | ±2.0% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 10,431 回/s | 12.27 ms | 67.73 MiB | -1.56 MiB | ±1.6% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 8,892 回/s | 14.42 ms | 9.00 MiB | 205.34 KiB | ±4.1% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 20.2 ns | 52,060,087 回/s | 74.86 MiB | 23.53 KiB | ±22.7% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 38.8 ns | 25,799,400 回/s | 69.78 MiB | 22.60 KiB | ±1.9% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 19.0 ns | 52,791,648 回/s | 75.48 MiB | 24.52 KiB | ±6.3% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 155.5 ms | 1.97 MiB | 4.92 KiB | ±7.9% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 29.43 ms | 0 B | -4.95 KiB | ±9.5% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
