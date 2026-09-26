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

**直近の全量ベンチマーク** · Bun 1.4.2 · 3 ラウンドの平均 · 2026-09-26T15:34:49Z · プロセス起動からローカル復元完了まで 372.4 ms · グループメッセージ 1 件を基本ディスパッチする 158.1 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 809.1 µs / 1,149 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 2.95 ms / 313 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-09-26T15:34:49Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,429 |
| プロセス読み込み | 167.65 MiB |
| プロセス書き込み | 173.94 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 193.70 MiB |
| 読み込みシステムコール | 52,427 |
| 書き込みシステムコール | 86,241 |
| モックルート使用量 | 15.87 MiB |
| モックルートファイル数 | 105 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 151.6 ms | ±1.1% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 12.49 ms | ±8.3% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 677.6 µs | ±1.6% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.23 ms | ±7.3% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.44 ms | ±3.3% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 325.4 µs | ±8.0% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 189.3 ms | ±2.5% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 289.9 µs | ±1.4% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 372.4 ms | ±1.3% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 117.06 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 158.1 ns | 6,356,241 回/s | 91.48 MiB | 10.81 KiB | ±7.4% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 96.1 ns | 10,534,527 回/s | 94.14 MiB | 21.61 KiB | ±11.5% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 15.7 ns | 63,723,624 回/s | 77.57 MiB | 20.89 KiB | ±1.2% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 28.4 ns | 35,207,200 回/s | 78.04 MiB | 22.44 KiB | ±1.4% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 34.7 ns | 28,881,755 回/s | 79.27 MiB | 20.60 KiB | ±3.2% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,139,886,568 回/s | 76.23 MiB | 22.22 KiB | ±5.0% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 49.4 ns | 20,268,030 回/s | 78.99 MiB | 20.55 KiB | ±4.6% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.2 ns | 235,435,228 回/s | 76.96 MiB | 22.02 KiB | ±1.3% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 10.5 ns | 95,055,366 回/s | 77.37 MiB | 20.60 KiB | ±4.1% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 43.2 ns | 23,184,230 回/s | 79.08 MiB | 19.25 KiB | ±2.4% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 7.974 µs | 125,824 回/s | 101.40 MiB | 20.95 KiB | ±5.6% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 93.7 ns | 10,672,544 回/s | 85.49 MiB | 22.12 KiB | ±1.6% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 24.6 ns | 40,722,714 回/s | 86.55 MiB | 23.08 KiB | ±4.1% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 50.6 ns | 19,754,625 回/s | 79.54 MiB | 20.93 KiB | ±1.2% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 265.9 ns | 3,765,038 回/s | 118.57 MiB | 5.63 MiB | ±3.6% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 314.7 ns | 3,178,547 回/s | 141.47 MiB | 20.37 KiB | ±1.6% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.5 ns | 225,093,972 回/s | 77.37 MiB | 20.73 KiB | ±6.2% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 4.520 µs | 221,298 回/s | 87.75 MiB | 23.71 KiB | ±1.9% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 98.6 ns | 10,193,322 回/s | 122.70 MiB | 24.70 KiB | ±7.5% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 292.9 ns | 3,420,327 回/s | 88.68 MiB | 24.51 KiB | ±4.1% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 37.04 µs | 26,999 回/s | 101.87 MiB | 22.43 KiB | ±0.7% |
| 返信参照を抽出する<br><code>reply-reference</code> | 28.8 ns | 35,118,493 回/s | 91.27 MiB | 23.54 KiB | ±9.7% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 45.2 ns | 22,367,239 回/s | 93.14 MiB | 20.84 KiB | ±10.2% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 8.0 ns | 145,719,846 回/s | 77.27 MiB | 22.94 KiB | ±33.3% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 37.1 ns | 26,957,105 回/s | 86.00 MiB | 19.78 KiB | ±1.3% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 21.7 ns | 46,027,678 回/s | 76.83 MiB | 22.86 KiB | ±0.1% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 16.1 ns | 62,032,129 回/s | 79.87 MiB | 20.84 KiB | ±2.7% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 76.8 ns | 13,022,532 回/s | 78.91 MiB | 21.05 KiB | ±2.0% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 903 回/s | 1.11 ms | 1.02 ms | 1.58 ms | 5.81 ms | 903 レコード/s | 3.91 MiB | ±2.3% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 145 回/s | 6.89 ms | 7.84 ms | 11.05 ms | 19.51 ms | 18,578 レコード/s | 21.42 MiB | ±1.5% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 642 回/s | 1.56 ms | 1.44 ms | 1.96 ms | 7.98 ms | 642 レコード/s | 3.15 MiB | ±0.3% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 645 回/s | 1.55 ms | 1.46 ms | 1.96 ms | 7.91 ms | 645 レコード/s | 3.13 MiB | ±1.3% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 624 回/s | 1.60 ms | 1.47 ms | 2.28 ms | 6.96 ms | 624 レコード/s | 3.13 MiB | ±0.8% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 353 回/s | 2.83 ms | 2.66 ms | 3.65 ms | 10.23 ms | 353 レコード/s | 5.55 MiB | ±1.4% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 863 回/s | 1.16 ms | 1.06 ms | 1.57 ms | 6.79 ms | 863 レコード/s | 4.16 MiB | ±4.4% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 313 回/s | 3.20 ms | 2.95 ms | 4.48 ms | 10.79 ms | 313 レコード/s | 1.83 MiB | ±4.0% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 1,149 回/s | 862.8 µs | 809.1 µs | 1.23 ms | 1.59 ms | 1,149 レコード/s | 0 B | ±2.3% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 186.0 ms | 185.0 ms | 190.4 ms | 196.5 ms | 5 レコード/s | 0 B | ±0.6% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 29,749,580 回/s | 269.2 ns | 0 B | 7.14 KiB | ±3.3% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 19,680 回/s | 6.51 ms | 56.29 MiB | 41.95 KiB | ±1.8% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 72,469 回/s | 110.4 µs | 5.29 MiB | 90.39 KiB | ±1.7% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 17,000 回/s | 470.7 µs | 2.92 MiB | 296.19 KiB | ±1.4% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 18,165 回/s | 7.05 ms | 73.14 MiB | 164.32 KiB | ±1.1% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 15,085 回/s | 8.49 ms | 9.73 MiB | 201.04 KiB | ±1.9% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 17.7 ns | 56,501,370 回/s | 88.43 MiB | 22.40 KiB | ±0.8% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.4 ns | 27,474,121 回/s | 79.42 MiB | 23.26 KiB | ±2.7% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 17.3 ns | 57,985,468 回/s | 86.11 MiB | 25.24 KiB | ±2.9% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 122.1 ms | 1.71 MiB | 4.89 KiB | ±4.0% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 16.82 ms | 0 B | -4.98 KiB | ±7.8% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：08 コマンドと挙動リファレンス](08-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-パフォーマンスベンチマーク) · [次のページ：10 よくある質問 →](10-faq.md)

</div>
