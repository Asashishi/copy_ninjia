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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-13T08:13:44Z · プロセス起動からローカル復元完了まで 296.2 ms · グループメッセージ 1 件を基本ディスパッチする 146.0 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 792.7 µs / 1,194 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 2.94 ms / 320 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-13T08:13:44Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,405 |
| プロセス読み込み | 121.72 MiB |
| プロセス書き込み | 178.32 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 197.80 MiB |
| 読み込みシステムコール | 40,293 |
| 書き込みシステムコール | 85,066 |
| モックルート使用量 | 13.62 MiB |
| モックルートファイル数 | 160 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 88.96 ms | ±1.0% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 11.68 ms | ±5.4% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 506.6 µs | ±6.4% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.31 ms | ±3.3% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.03 ms | ±2.8% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 630.0 µs | ±1.4% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 176.7 ms | ±1.7% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 438.5 µs | ±12.0% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 296.2 ms | ±0.7% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 115.03 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 146.0 ns | 6,852,681 回/s | 86.60 MiB | 6.06 KiB | ±2.1% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 100.0 ns | 10,066,774 回/s | 87.19 MiB | 22.76 KiB | ±8.1% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 16.0 ns | 62,787,963 回/s | 74.55 MiB | 23.83 KiB | ±4.5% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 28.3 ns | 35,304,063 回/s | 74.16 MiB | 23.79 KiB | ±0.5% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 34.0 ns | 29,426,154 回/s | 75.64 MiB | 23.19 KiB | ±2.5% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,133,745,453 回/s | 72.83 MiB | 22.82 KiB | ±7.2% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 49.6 ns | 20,219,924 回/s | 75.58 MiB | 21.71 KiB | ±4.9% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 3.9 ns | 256,476,618 回/s | 73.22 MiB | 23.21 KiB | ±4.5% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 11.4 ns | 87,450,484 回/s | 74.05 MiB | 22.05 KiB | ±0.7% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 42.7 ns | 23,441,314 回/s | 75.51 MiB | 22.73 KiB | ±1.2% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 8.074 µs | 124,075 回/s | 97.82 MiB | 22.27 KiB | ±4.2% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 94.6 ns | 10,576,159 回/s | 81.07 MiB | 25.21 KiB | ±2.9% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 35.5 ns | 30,589,974 回/s | 82.51 MiB | 23.26 KiB | ±30.7% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 49.1 ns | 20,396,302 回/s | 75.86 MiB | 23.58 KiB | ±3.3% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 266.7 ns | 3,757,200 回/s | 119.31 MiB | 5.64 MiB | ±4.5% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 292.8 ns | 3,429,660 回/s | 136.40 MiB | 21.94 KiB | ±6.4% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.3 ns | 234,267,488 回/s | 74.11 MiB | 22.72 KiB | ±2.2% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 4.416 µs | 226,453 回/s | 84.43 MiB | 25.39 KiB | ±0.6% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 94.5 ns | 10,587,097 回/s | 117.37 MiB | 44.71 KiB | ±1.7% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 250.5 ns | 3,992,831 回/s | 91.01 MiB | 27.38 KiB | ±1.5% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 37.05 µs | 26,989 回/s | 96.91 MiB | 23.32 KiB | ±0.3% |
| 返信参照を抽出する<br><code>reply-reference</code> | 19.1 ns | 52,454,933 回/s | 85.26 MiB | 25.24 KiB | ±3.1% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 51.5 ns | 19,418,370 回/s | 87.69 MiB | 23.71 KiB | ±1.8% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.3 ns | 233,580,481 回/s | 78.74 MiB | 22.73 KiB | ±1.8% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 33.7 ns | 29,708,036 回/s | 82.18 MiB | 20.53 KiB | ±0.7% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 21.0 ns | 47,714,290 回/s | 74.32 MiB | 21.43 KiB | ±1.2% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 16.4 ns | 61,051,523 回/s | 76.10 MiB | 24.12 KiB | ±2.5% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 77.8 ns | 12,892,110 回/s | 75.14 MiB | 22.55 KiB | ±5.0% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 941 回/s | 1.06 ms | 959.5 µs | 1.54 ms | 8.49 ms | 941 レコード/s | 3.91 MiB | ±0.8% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 149 回/s | 6.73 ms | 7.52 ms | 10.82 ms | 17.46 ms | 19,019 レコード/s | 20.53 MiB | ±1.2% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 620 回/s | 1.62 ms | 1.44 ms | 2.22 ms | 14.40 ms | 620 レコード/s | 3.15 MiB | ±6.3% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 667 回/s | 1.50 ms | 1.42 ms | 1.95 ms | 5.22 ms | 667 レコード/s | 3.13 MiB | ±5.9% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 654 回/s | 1.53 ms | 1.44 ms | 1.96 ms | 11.57 ms | 654 レコード/s | 3.13 MiB | ±4.5% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 335 回/s | 2.99 ms | 2.75 ms | 4.83 ms | 8.75 ms | 335 レコード/s | 11.72 MiB | ±5.5% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 830 回/s | 1.21 ms | 1.10 ms | 1.63 ms | 7.89 ms | 830 レコード/s | 4.16 MiB | ±7.2% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 320 回/s | 3.13 ms | 2.94 ms | 4.37 ms | 8.95 ms | 320 レコード/s | 1.83 MiB | ±3.6% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 1,194 回/s | 830.2 µs | 792.7 µs | 1.09 ms | 1.47 ms | 1,194 レコード/s | 0 B | ±1.3% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 30,245,252 回/s | 264.5 ns | 0 B | 6.28 KiB | ±0.9% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 20,988 回/s | 6.10 ms | 61.90 MiB | 31.08 KiB | ±1.0% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 77,955 回/s | 102.7 µs | 4.86 MiB | 78.04 KiB | ±2.5% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 18,051 回/s | 443.5 µs | 2.70 MiB | 279.46 KiB | ±2.4% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 18,246 回/s | 7.02 ms | 67.73 MiB | 187.62 KiB | ±1.1% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 15,155 回/s | 8.46 ms | 9.00 MiB | 224.49 KiB | ±3.4% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.7 ns | 60,538,077 回/s | 85.61 MiB | 24.54 KiB | ±9.5% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.2 ns | 27,644,329 回/s | 75.58 MiB | 25.41 KiB | ±3.2% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 18.8 ns | 53,395,663 回/s | 82.22 MiB | 26.42 KiB | ±4.6% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 117.3 ms | 1.67 MiB | 5.04 KiB | ±0.3% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 16.35 ms | 0 B | -4.94 KiB | ±13.9% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク)

</div>
