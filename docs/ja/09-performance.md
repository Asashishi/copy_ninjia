# 09 パフォーマンスベンチマーク

<p align="center">
  <a href="../cn/09-performance.md">简体中文</a> · <a href="../en/09-performance.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="08-commands.md">← 前のページ：08 コマンドと挙動リファレンス</a> · <a href="10-faq.md">次のページ：10 よくある質問 →</a>
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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-10-01T01:09:44Z · プロセス起動からローカル復元完了まで 360.9 ms · グループメッセージ 1 件を基本ディスパッチする 148.3 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 216.6 µs / 4,227 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.86 ms / 492 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-10-01T01:09:44Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,453 |
| プロセス読み込み | 179.78 MiB |
| プロセス書き込み | 185.20 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 234.42 MiB |
| 読み込みシステムコール | 52,556 |
| 書き込みシステムコール | 243,644 |
| モックルート使用量 | 15.14 MiB |
| モックルートファイル数 | 120 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 124.3 ms | ±9.1% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 12.49 ms | ±4.6% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 667.9 µs | ±4.8% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.24 ms | ±1.4% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 5.17 ms | ±7.4% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 649.7 µs | ±2.8% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 201.0 ms | ±2.2% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 913.2 µs | ±85.2% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 360.9 ms | ±3.0% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 109.87 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 148.3 ns | 6,748,600 回/s | 93.08 MiB | 9.51 KiB | ±2.6% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 100.2 ns | 9,997,776 回/s | 91.81 MiB | 20.10 KiB | ±4.7% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 16.2 ns | 61,846,549 回/s | 78.47 MiB | 21.81 KiB | ±1.3% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 29.7 ns | 33,684,148 回/s | 79.30 MiB | 21.39 KiB | ±4.6% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 35.4 ns | 28,280,203 回/s | 80.57 MiB | 20.46 KiB | ±4.3% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,138,193,987 回/s | 77.26 MiB | 22.14 KiB | ±5.8% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 50.8 ns | 19,741,072 回/s | 79.94 MiB | 20.38 KiB | ±5.0% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.0 ns | 248,842,748 回/s | 77.69 MiB | 21.28 KiB | ±3.7% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 10.5 ns | 95,721,806 回/s | 78.46 MiB | 20.68 KiB | ±3.5% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 43.0 ns | 23,245,264 回/s | 80.17 MiB | 21.21 KiB | ±1.0% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.110 µs | 901,239 回/s | 104.43 MiB | 19.44 KiB | ±1.4% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 95.0 ns | 10,529,980 回/s | 85.53 MiB | 23.52 KiB | ±1.2% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 24.5 ns | 41,022,852 回/s | 87.90 MiB | 23.16 KiB | ±7.7% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 49.7 ns | 20,169,508 回/s | 80.64 MiB | 22.38 KiB | ±3.9% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 259.9 ns | 3,849,376 回/s | 117.42 MiB | 5.63 MiB | ±2.2% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 315.7 ns | 3,172,934 回/s | 147.18 MiB | 18.79 KiB | ±3.9% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.3 ns | 233,273,391 回/s | 78.67 MiB | 21.19 KiB | ±1.3% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.222 µs | 450,185 回/s | 89.93 MiB | 23.03 KiB | ±1.0% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 98.2 ns | 10,198,505 回/s | 124.30 MiB | 23.87 KiB | ±3.7% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 283.0 ns | 3,534,208 回/s | 91.38 MiB | 24.43 KiB | ±1.0% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 39.02 µs | 25,632 回/s | 104.15 MiB | 21.51 KiB | ±0.8% |
| 返信参照を抽出する<br><code>reply-reference</code> | 38.5 ns | 26,964,399 回/s | 91.56 MiB | 22.59 KiB | ±18.8% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 50.1 ns | 20,032,401 回/s | 98.86 MiB | 22.19 KiB | ±5.3% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 8.1 ns | 144,719,433 回/s | 78.89 MiB | 23.00 KiB | ±33.3% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 38.2 ns | 26,206,089 回/s | 87.49 MiB | 19.14 KiB | ±0.9% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 21.9 ns | 45,634,244 回/s | 78.10 MiB | 21.11 KiB | ±2.3% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 16.4 ns | 61,246,674 回/s | 80.90 MiB | 20.79 KiB | ±5.7% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 76.5 ns | 13,083,837 回/s | 79.75 MiB | 21.52 KiB | ±1.7% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 953 回/s | 1.05 ms | 961.5 µs | 1.45 ms | 8.06 ms | 953 レコード/s | 3.91 MiB | ±2.2% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 317 回/s | 3.16 ms | 3.06 ms | 5.62 ms | 15.75 ms | 40,535 レコード/s | 21.42 MiB | ±4.1% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 790 回/s | 1.27 ms | 1.15 ms | 1.61 ms | 7.78 ms | 790 レコード/s | 3.15 MiB | ±0.7% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 663 回/s | 1.52 ms | 1.35 ms | 2.55 ms | 8.17 ms | 663 レコード/s | 3.13 MiB | ±10.2% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 725 回/s | 1.38 ms | 1.28 ms | 1.83 ms | 5.44 ms | 725 レコード/s | 3.13 MiB | ±2.0% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 363 回/s | 2.76 ms | 2.50 ms | 4.04 ms | 12.08 ms | 363 レコード/s | 5.55 MiB | ±3.1% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 866 回/s | 1.16 ms | 1.06 ms | 1.59 ms | 8.90 ms | 866 レコード/s | 4.16 MiB | ±4.6% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 492 回/s | 2.03 ms | 1.86 ms | 3.03 ms | 7.07 ms | 492 レコード/s | 1.20 MiB | ±2.5% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,227 回/s | 234.2 µs | 216.6 µs | 352.4 µs | 528.4 µs | 4,227 レコード/s | 0 B | ±2.1% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 189.9 ms | 188.2 ms | 197.3 ms | 207.7 ms | 5 レコード/s | 0 B | ±1.3% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 7 回/s | 140.2 ms | 139.2 ms | 147.6 ms | 151.0 ms | 7 レコード/s | 7.31 MiB | ±0.7% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 29,941,728 回/s | 267.2 ns | 0 B | 5.75 KiB | ±1.1% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 44,446 回/s | 2.88 ms | 56.31 MiB | 44.35 KiB | ±0.4% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 73,782 回/s | 108.5 µs | 5.29 MiB | 79.92 KiB | ±2.0% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 12,797 回/s | 625.6 µs | 34.01 MiB | 296.33 KiB | ±2.6% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 63,172 回/s | 2.03 ms | 73.14 MiB | 137.35 KiB | ±2.9% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 18,579 回/s | 6.90 ms | 12.63 MiB | 433.79 KiB | ±4.0% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.3 ns | 61,541,088 回/s | 89.83 MiB | 22.81 KiB | ±6.7% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.4 ns | 27,474,121 回/s | 79.73 MiB | 23.09 KiB | ±0.9% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 19.4 ns | 52,222,344 回/s | 87.79 MiB | 24.57 KiB | ±10.8% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 132.6 ms | 1.92 MiB | 4.89 KiB | ±1.6% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 21.38 ms | 0 B | -3.56 KiB | ±3.3% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク) · [次のページ：10 よくある質問 →](10-faq.md)

</div>
