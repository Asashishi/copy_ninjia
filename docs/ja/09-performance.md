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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-29T07:27:46Z · プロセス起動からローカル復元完了まで 370.1 ms · グループメッセージ 1 件を基本ディスパッチする 159.5 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 233.1 µs / 3,767 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.97 ms / 444 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-29T07:27:46Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,429 |
| プロセス読み込み | 164.35 MiB |
| プロセス書き込み | 174.17 MiB |
| ブロックデバイス読み込み | 1.33 KiB |
| ブロックデバイス書き込み | 193.43 MiB |
| 読み込みシステムコール | 51,722 |
| 書き込みシステムコール | 86,117 |
| モックルート使用量 | 14.19 MiB |
| モックルートファイル数 | 106 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 124.5 ms | ±9.6% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 15.12 ms | ±10.3% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 795.2 µs | ±8.2% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.32 ms | ±2.8% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 5.50 ms | ±4.8% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 707.8 µs | ±4.7% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 208.6 ms | ±4.3% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 448.5 µs | ±45.2% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 370.1 ms | ±2.3% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 108.39 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 159.5 ns | 6,281,062 回/s | 90.65 MiB | 1.97 KiB | ±4.3% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 111.7 ns | 9,008,459 回/s | 90.70 MiB | 21.57 KiB | ±7.9% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 16.5 ns | 60,621,454 回/s | 76.43 MiB | 20.72 KiB | ±3.3% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 30.1 ns | 33,296,275 回/s | 76.41 MiB | 21.92 KiB | ±3.1% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 35.2 ns | 28,406,355 回/s | 78.05 MiB | 20.21 KiB | ±3.0% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,151,321,725 回/s | 75.00 MiB | 21.16 KiB | ±1.1% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 49.7 ns | 20,162,520 回/s | 77.59 MiB | 20.66 KiB | ±4.5% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.1 ns | 245,959,946 回/s | 75.52 MiB | 22.04 KiB | ±4.0% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 10.8 ns | 93,437,065 回/s | 76.26 MiB | 19.96 KiB | ±9.3% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 43.3 ns | 23,109,898 回/s | 77.70 MiB | 20.36 KiB | ±2.1% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.140 µs | 880,198 回/s | 102.87 MiB | 19.56 KiB | ±5.6% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 97.7 ns | 10,237,045 回/s | 83.24 MiB | 21.92 KiB | ±0.7% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 41.5 ns | 27,754,673 回/s | 84.35 MiB | 21.35 KiB | ±32.0% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 50.9 ns | 19,650,710 回/s | 77.96 MiB | 22.01 KiB | ±1.9% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 284.6 ns | 3,515,653 回/s | 116.39 MiB | 5.63 MiB | ±2.2% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 356.1 ns | 2,811,974 回/s | 136.62 MiB | 19.93 KiB | ±3.7% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.4 ns | 226,177,176 回/s | 76.82 MiB | 21.19 KiB | ±2.1% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.510 µs | 398,500 回/s | 87.58 MiB | 23.46 KiB | ±1.7% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 100.7 ns | 9,931,084 回/s | 121.46 MiB | 23.68 KiB | ±1.5% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 311.2 ns | 3,222,841 回/s | 87.17 MiB | 23.91 KiB | ±5.3% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 40.94 µs | 24,454 回/s | 100.10 MiB | 21.61 KiB | ±3.1% |
| 返信参照を抽出する<br><code>reply-reference</code> | 36.9 ns | 29,083,285 回/s | 89.57 MiB | 21.84 KiB | ±28.8% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 50.9 ns | 19,660,904 回/s | 95.99 MiB | 21.87 KiB | ±2.5% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 8.2 ns | 146,341,229 回/s | 76.46 MiB | 22.74 KiB | ±35.3% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 40.2 ns | 24,898,824 回/s | 85.40 MiB | 19.18 KiB | ±3.9% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 22.2 ns | 44,951,097 回/s | 76.19 MiB | 21.25 KiB | ±1.2% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 16.5 ns | 60,654,788 回/s | 77.78 MiB | 22.16 KiB | ±2.9% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 77.6 ns | 12,925,251 回/s | 77.13 MiB | 22.22 KiB | ±5.0% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 758 回/s | 1.32 ms | 1.17 ms | 1.98 ms | 11.06 ms | 758 レコード/s | 3.91 MiB | ±2.7% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 122 回/s | 8.21 ms | 9.06 ms | 13.89 ms | 23.53 ms | 15,592 レコード/s | 21.42 MiB | ±0.6% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 582 回/s | 1.72 ms | 1.52 ms | 2.72 ms | 9.76 ms | 582 レコード/s | 3.15 MiB | ±5.9% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 565 回/s | 1.77 ms | 1.59 ms | 2.68 ms | 9.79 ms | 565 レコード/s | 3.13 MiB | ±3.1% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 536 回/s | 1.88 ms | 1.54 ms | 3.57 ms | 16.38 ms | 536 レコード/s | 3.13 MiB | ±10.1% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 334 回/s | 2.99 ms | 2.70 ms | 4.24 ms | 13.33 ms | 334 レコード/s | 5.55 MiB | ±2.6% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 693 回/s | 1.45 ms | 1.23 ms | 2.38 ms | 18.24 ms | 693 レコード/s | 4.16 MiB | ±5.5% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 444 回/s | 2.26 ms | 1.97 ms | 3.97 ms | 10.12 ms | 444 レコード/s | 1.20 MiB | ±8.0% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 3,767 回/s | 263.0 µs | 233.1 µs | 438.0 µs | 606.7 µs | 3,767 レコード/s | 0 B | ±3.6% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 192.5 ms | 190.6 ms | 204.5 ms | 208.4 ms | 5 レコード/s | 0 B | ±1.7% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 28,766,674 回/s | 278.4 ns | 0 B | 3.98 KiB | ±3.3% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 16,120 回/s | 7.95 ms | 56.29 MiB | 48.50 KiB | ±3.5% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 60,700 回/s | 131.8 µs | 5.29 MiB | 76.42 KiB | ±1.3% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 14,305 回/s | 559.3 µs | 2.92 MiB | 296.27 KiB | ±1.0% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 14,632 回/s | 8.75 ms | 73.14 MiB | 188.63 KiB | ±2.8% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 11,744 回/s | 10.90 ms | 9.73 MiB | 201.59 KiB | ±0.6% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 19.5 ns | 52,280,193 回/s | 83.97 MiB | 21.54 KiB | ±14.5% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 38.7 ns | 25,990,038 回/s | 78.05 MiB | 23.05 KiB | ±7.3% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 20.7 ns | 48,479,249 回/s | 84.96 MiB | 25.26 KiB | ±3.7% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 143.1 ms | 1.94 MiB | 4.96 KiB | ±9.7% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 31.29 ms | 0 B | -4.94 KiB | ±4.5% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク) · [次のページ：10 よくある質問 →](10-faq.md)

</div>
